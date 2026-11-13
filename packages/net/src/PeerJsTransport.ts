import { type DataConnection, Peer, type PeerOptions } from 'peerjs';
import { makeRoomCode, normalizeRoomCode } from './roomCode';
import { Signal } from './Signal';
import type { Transport } from './Transport';

export interface PeerJsOptions {
  /**
   * Namespaces room codes on the shared PeerJS signalling server, so two different
   * games never collide. Use something unique to your game.
   */
  prefix?: string;
  /**
   * Passed to PeerJS. Use it to point at your own PeerServer or to supply TURN servers,
   * which some networks need before WebRTC can connect.
   */
  peerOptions?: PeerOptions;
  /** Give up connecting after this many milliseconds. Default 15000. */
  timeoutMs?: number;
}

/**
 * WebRTC data channels via PeerJS, in a star: guests connect to the host and nobody
 * else, which is all `CommandSession` needs.
 *
 *   // Host                                     // Guest
 *   const t = await PeerJsTransport.host();      const t = await PeerJsTransport.join(code);
 *   share(t.roomCode);                           CommandSession.join(t, t.hostId);
 *   CommandSession.host(t);
 *
 * PeerJS's free cloud server only brokers the connection; gameplay data flows directly
 * between players. Use the Convex lobby if you want a browsable list of rooms.
 */
export class PeerJsTransport implements Transport {
  readonly onMessage = new Signal<[peerId: string, message: unknown]>();
  readonly onPeerJoined = new Signal<[peerId: string]>();
  readonly onPeerLeft = new Signal<[peerId: string]>();
  /** Raised for connection problems after start-up (lost signalling server, ...). */
  readonly onError = new Signal<[error: Error]>();

  private readonly connections = new Map<string, DataConnection>();
  private closed = false;

  private constructor(
    private readonly peer: Peer,
    readonly localId: string,
    /** The code guests pass to `join`. */
    readonly roomCode: string,
    /** The host's transport id. For the host this equals `localId`. */
    readonly hostId: string,
  ) {
    peer.on('error', (error) => this.onError.emit(error));
  }

  /** Opens a room and waits for the signalling server to confirm it. */
  static host(options: PeerJsOptions & { roomCode?: string } = {}): Promise<PeerJsTransport> {
    const roomCode = options.roomCode ?? makeRoomCode();
    const hostId = `${options.prefix ?? 'synergy'}-${roomCode}`;
    const peer = options.peerOptions ? new Peer(hostId, options.peerOptions) : new Peer(hostId);
    return withTimeout(options.timeoutMs, peer, (resolve, reject) => {
      peer.once('open', (id) => {
        const transport = new PeerJsTransport(peer, id, roomCode, id);
        peer.on('connection', (connection) => transport.adopt(connection));
        resolve(transport);
      });
      peer.once('error', (error) =>
        reject(error.type === 'unavailable-id' ? new Error(`Room code ${roomCode} is already in use.`) : error),
      );
    });
  }

  /** Connects to the room with this code. Rejects if there is no such room. */
  static join(roomCode: string, options: PeerJsOptions = {}): Promise<PeerJsTransport> {
    const code = normalizeRoomCode(roomCode);
    const hostId = `${options.prefix ?? 'synergy'}-${code}`;
    const peer = options.peerOptions ? new Peer(options.peerOptions) : new Peer();
    return withTimeout(options.timeoutMs, peer, (resolve, reject) => {
      peer.once('error', (error) =>
        reject(error.type === 'peer-unavailable' ? new Error(`No room found with code ${code}.`) : error),
      );
      peer.once('open', (id) => {
        const transport = new PeerJsTransport(peer, id, code, hostId);
        const connection = peer.connect(hostId, { reliable: true, serialization: 'json' });
        connection.once('open', () => {
          transport.adopt(connection);
          resolve(transport);
        });
        connection.once('error', reject);
      });
    });
  }

  get peers(): readonly string[] {
    return [...this.connections.keys()];
  }

  send(peerId: string, message: unknown): void {
    const connection = this.connections.get(peerId);
    if (connection?.open) void connection.send(message); // delivery is reported through the connection, not here
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.destroy();
    this.connections.clear();
  }

  private adopt(connection: DataConnection): void {
    const ready = () => {
      this.connections.set(connection.peer, connection);
      this.onPeerJoined.emit(connection.peer);
    };
    if (connection.open) ready();
    else connection.once('open', ready);
    connection.on('data', (data) => this.onMessage.emit(connection.peer, data));
    const gone = () => {
      if (this.connections.delete(connection.peer)) this.onPeerLeft.emit(connection.peer);
    };
    connection.once('close', gone);
    connection.once('error', gone);
  }
}

function withTimeout(
  timeoutMs: number | undefined,
  peer: Peer,
  run: (resolve: (transport: PeerJsTransport) => void, reject: (error: Error) => void) => void,
): Promise<PeerJsTransport> {
  return new Promise<PeerJsTransport>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error('Timed out connecting. Check the network, or supply TURN servers in peerOptions.'));
    }, timeoutMs ?? 15_000);
    run(
      (transport) => {
        clearTimeout(timer);
        resolve(transport);
      },
      (error) => {
        clearTimeout(timer);
        peer.destroy();
        reject(error);
      },
    );
  });
}
