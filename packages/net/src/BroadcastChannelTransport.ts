import { makeRoomCode, normalizeRoomCode } from './roomCode';
import { Signal } from './Signal';
import type { Transport } from './Transport';

export interface BroadcastChannelOptions {
  /** Namespaces room codes, so two games open in one browser never meet. Use the same prefix as for PeerJS. */
  prefix?: string;
  /**
   * Joining: how long to keep looking for the host, in milliseconds. Default 10000, so
   * a player window opened together with the host's finds it once the host is up.
   */
  timeoutMs?: number;
  /**
   * A peer that sends nothing (not even the heartbeat every 2 seconds) for this long is
   * treated as gone, as a closed tab is. Default 60000: browsers slow the timers of
   * hidden tabs, so a short limit drops players whose window is behind another.
   */
  peerTimeoutMs?: number;
}

/** What travels on the channel. `d` is the game's message as JSON text. */
type Envelope =
  | { t: 'probe'; from: string }
  | { t: 'taken'; to: string }
  | { t: 'hello'; from: string }
  | { t: 'welcome'; from: string; to: string }
  | { t: 'refused'; to: string; reason: string }
  | { t: 'data'; from: string; to: string; d: string }
  | { t: 'beat'; from: string }
  | { t: 'bye'; from: string };

const HEARTBEAT_MS = 2000;
const PROBE_MS = 150;
const HELLO_RETRY_MS = 250;

/**
 * Local multiplayer for testing: players are windows (or tabs) of the same browser on one
 * machine, connected through the browser's `BroadcastChannel`. No internet, no signalling
 * server, nothing to install. This is the counterpart of Unity's Multiplayer Play Mode:
 * open the game in two to four windows and play them against each other.
 *
 *   // Host window                                        // Every other window
 *   const t = await BroadcastChannelTransport.host();       const t = await BroadcastChannelTransport.join(code);
 *   manager.startHost(t);                                   manager.startClient(t, t.hostId);
 *   // or CommandSession.host(t)                            // or CommandSession.join(t, t.hostId)
 *
 * Same shape as `PeerJsTransport` (a star: guests talk to the host only, `roomCode`,
 * `hostId`), so switching between the two is one line. Only windows of the same browser
 * profile and the same origin meet; a private window is a different profile. Browsers
 * pause the frame loop of a hidden tab, so put the players in separate windows side by
 * side rather than tabs of one window. Delivery is reliable and in order, as the
 * `Transport` interface requires; messages travel as JSON, as they would over a network.
 */
export class BroadcastChannelTransport implements Transport {
  readonly onMessage = new Signal<[peerId: string, message: unknown]>();
  readonly onPeerJoined = new Signal<[peerId: string]>();
  readonly onPeerLeft = new Signal<[peerId: string]>();

  /** Last time each connected peer was heard from (milliseconds, `Date.now()`). */
  private readonly lastHeard = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly sayGoodbye = () => this.close();

  private constructor(
    private readonly channel: BroadcastChannel,
    readonly localId: string,
    /** The code other windows pass to `join`. */
    readonly roomCode: string,
    /** The host's transport id. For the host this equals `localId`. */
    readonly hostId: string,
    private readonly peerTimeoutMs: number,
  ) {
    channel.onmessage = (event: MessageEvent) => this.receive(event.data as Envelope);
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    // A closed or reloaded window says goodbye, so the others notice at once.
    globalThis.addEventListener?.('pagehide', this.sayGoodbye);
  }

  /**
   * Opens a room in this browser. Rejects if another window already hosts `roomCode`
   * (a code is made up when none is given).
   */
  static async host(options: BroadcastChannelOptions & { roomCode?: string } = {}): Promise<BroadcastChannelTransport> {
    const roomCode = normalizeRoomCode(options.roomCode ?? makeRoomCode());
    const hostId = `host-${roomCode}`;
    const channel = openChannel(options.prefix, roomCode);
    // Ask whether this room is already open somewhere: a host answers within a moment.
    const taken = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_MS);
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as Envelope;
        if (message.t === 'taken' && message.to === hostId) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      post(channel, { t: 'probe', from: hostId });
    });
    if (taken) {
      channel.close();
      throw new Error(`Room code ${roomCode} is already open in another window of this browser.`);
    }
    return new BroadcastChannelTransport(channel, hostId, roomCode, hostId, options.peerTimeoutMs ?? 60_000);
  }

  /**
   * Joins the room another window of this browser hosts. Keeps asking until the host
   * answers or `timeoutMs` passes. `id` names this player in the session (it must be
   * unique in the room); one is made up when it is left out.
   */
  static join(
    roomCode: string,
    options: BroadcastChannelOptions & { id?: string } = {},
  ): Promise<BroadcastChannelTransport> {
    const code = normalizeRoomCode(roomCode);
    const hostId = `host-${code}`;
    const localId = options.id ?? `guest-${crypto.randomUUID().slice(0, 8)}`;
    const channel = openChannel(options.prefix, code);
    return new Promise<BroadcastChannelTransport>((resolve, reject) => {
      const finish = (error: Error | null) => {
        clearInterval(retry);
        clearTimeout(timer);
        if (error) {
          channel.close();
          reject(error);
          return;
        }
        const transport = new BroadcastChannelTransport(
          channel,
          localId,
          code,
          hostId,
          options.peerTimeoutMs ?? 60_000,
        );
        transport.connect(hostId);
        resolve(transport);
      };
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as Envelope;
        if (message.t === 'welcome' && message.to === localId) finish(null);
        else if (message.t === 'refused' && message.to === localId) finish(new Error(message.reason));
      };
      const hello = () => post(channel, { t: 'hello', from: localId });
      const retry = setInterval(hello, HELLO_RETRY_MS);
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `No room ${code} is open in this browser. Local rooms only reach windows of the same browser ` +
                'profile and site: host it in another window first (a private window does not count).',
            ),
          ),
        options.timeoutMs ?? 10_000,
      );
      hello();
    });
  }

  get isHost(): boolean {
    return this.localId === this.hostId;
  }

  get peers(): readonly string[] {
    return [...this.lastHeard.keys()];
  }

  send(peerId: string, message: unknown): void {
    if (this.closed || !this.lastHeard.has(peerId)) return;
    post(this.channel, { t: 'data', from: this.localId, to: peerId, d: JSON.stringify(message) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    globalThis.removeEventListener?.('pagehide', this.sayGoodbye);
    post(this.channel, { t: 'bye', from: this.localId });
    this.channel.close();
    const peers = [...this.lastHeard.keys()];
    this.lastHeard.clear();
    for (const peer of peers) this.onPeerLeft.emit(peer);
  }

  private receive(message: Envelope): void {
    if (this.closed) return;
    switch (message.t) {
      case 'probe':
        if (this.isHost) post(this.channel, { t: 'taken', to: message.from });
        return;
      case 'hello':
        if (!this.isHost) return;
        if (message.from === this.localId) {
          post(this.channel, { t: 'refused', to: message.from, reason: `The id ${message.from} is the host's.` });
          return;
        }
        // Repeated hellos (the guest retries until answered) are answered again, not re-joined.
        post(this.channel, { t: 'welcome', from: this.localId, to: message.from });
        this.connect(message.from);
        return;
      case 'data':
        if (message.to !== this.localId || !this.lastHeard.has(message.from)) return;
        this.lastHeard.set(message.from, Date.now());
        this.onMessage.emit(message.from, JSON.parse(message.d));
        return;
      case 'beat':
        if (this.lastHeard.has(message.from)) this.lastHeard.set(message.from, Date.now());
        return;
      case 'bye':
        this.disconnect(message.from);
        if (message.from === this.hostId && !this.isHost) this.close();
        return;
      default:
        return;
    }
  }

  private connect(peerId: string): void {
    if (this.lastHeard.has(peerId)) return;
    this.lastHeard.set(peerId, Date.now());
    this.onPeerJoined.emit(peerId);
  }

  private disconnect(peerId: string): void {
    if (this.lastHeard.delete(peerId)) this.onPeerLeft.emit(peerId);
  }

  private heartbeat(): void {
    post(this.channel, { t: 'beat', from: this.localId });
    const now = Date.now();
    for (const [peer, heard] of [...this.lastHeard]) {
      if (now - heard > this.peerTimeoutMs) this.disconnect(peer);
    }
  }
}

function openChannel(prefix: string | undefined, roomCode: string): BroadcastChannel {
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error(
      'This runtime has no BroadcastChannel. Local rooms need a browser (or Bun); use LoopbackHub in tests.',
    );
  }
  return new BroadcastChannel(`${prefix ?? 'synergy'}-${roomCode}`);
}

function post(channel: BroadcastChannel, message: Envelope): void {
  channel.postMessage(message);
}
