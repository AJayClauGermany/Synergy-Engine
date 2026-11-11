import { Signal } from './Signal';

/**
 * A way to exchange JSON-compatible messages with other players. Sessions are written
 * against this interface, so the same game code runs over an in-memory loopback (tests,
 * local play), WebRTC via PeerJS, or anything else you implement.
 *
 * Delivery must be reliable and ordered per peer.
 */
export interface Transport {
  /** This endpoint's id, unique within the connection. */
  readonly localId: string;
  /** Ids of the endpoints currently reachable with `send`. */
  readonly peers: readonly string[];
  readonly onMessage: Signal<[peerId: string, message: unknown]>;
  readonly onPeerJoined: Signal<[peerId: string]>;
  readonly onPeerLeft: Signal<[peerId: string]>;
  send(peerId: string, message: unknown): void;
  close(): void;
}

/**
 * An in-memory network. Every transport connected to the same hub can reach every other.
 *
 *   const hub = new LoopbackHub();
 *   const host = hub.connect('host');
 *   const guest = hub.connect('guest');
 *
 * Messages are delivered on a microtask by default. Pass `{ manual: true }` and call
 * `hub.flush()` to control delivery exactly, which keeps tests deterministic.
 */
export class LoopbackHub {
  private readonly nodes = new Map<string, LoopbackTransport>();
  private queue: (() => void)[] = [];
  private scheduled = false;
  private counter = 0;

  constructor(private readonly options: { manual?: boolean } = {}) {}

  connect(id = `peer-${++this.counter}`): LoopbackTransport {
    if (this.nodes.has(id)) throw new Error(`LoopbackHub: id "${id}" is already connected.`);
    const node = new LoopbackTransport(this, id);
    const existing = [...this.nodes.values()];
    this.nodes.set(id, node);
    for (const other of existing) {
      this.enqueue(() => other.onPeerJoined.emit(id));
      this.enqueue(() => node.onPeerJoined.emit(other.localId));
    }
    return node;
  }

  /** Delivers everything queued so far, including messages sent while flushing. */
  flush(): void {
    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = [];
      for (const deliver of batch) deliver();
    }
  }

  /** @internal */
  _peersOf(id: string): string[] {
    return [...this.nodes.keys()].filter((other) => other !== id);
  }

  /** @internal */
  _send(from: string, to: string, message: unknown): void {
    // Round-trip through JSON so loopback behaves like a real wire: no shared references,
    // and non-serialisable values fail here instead of only in production.
    const payload = JSON.stringify(message);
    this.enqueue(() => this.nodes.get(to)?.onMessage.emit(from, JSON.parse(payload)));
  }

  /** @internal */
  _disconnect(id: string): void {
    if (!this.nodes.delete(id)) return;
    for (const other of this.nodes.values()) this.enqueue(() => other.onPeerLeft.emit(id));
  }

  private enqueue(deliver: () => void): void {
    this.queue.push(deliver);
    if (this.options.manual || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }
}

export class LoopbackTransport implements Transport {
  readonly onMessage = new Signal<[peerId: string, message: unknown]>();
  readonly onPeerJoined = new Signal<[peerId: string]>();
  readonly onPeerLeft = new Signal<[peerId: string]>();
  private closed = false;

  /** @internal Use `hub.connect()`. */
  constructor(
    private readonly hub: LoopbackHub,
    readonly localId: string,
  ) {}

  get peers(): readonly string[] {
    return this.closed ? [] : this.hub._peersOf(this.localId);
  }

  send(peerId: string, message: unknown): void {
    if (!this.closed) this.hub._send(this.localId, peerId, message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub._disconnect(this.localId);
  }
}
