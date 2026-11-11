import { Signal } from './Signal';
import { LoopbackHub, type Transport } from './Transport';

/** One accepted command, with its position in the shared order. */
export interface CommandEntry<C> {
  /** 0, 1, 2, ... Every player sees the same commands with the same numbers. */
  seq: number;
  /** Who issued it. */
  playerId: string;
  command: C;
}

/**
 * A multiplayer session built on one idea: every player applies the same commands in
 * the same order. Game code submits commands ("move unit 3 to B4", "end turn") instead
 * of changing state directly, and changes state only when a command comes back through
 * `onCommand`. If applying a command is deterministic, all players stay in sync.
 *
 * This suits turn-based games directly, and lockstep real-time strategy when commands
 * are stamped with the simulation tick they apply to.
 *
 *   session.onCommand.add(({ playerId, command }) => {
 *     state = applyCommand(state, command, playerId);
 *   });
 *   session.submit({ type: 'endTurn' });
 */
export interface Session<C> {
  readonly localId: string;
  readonly isHost: boolean;
  /** Player ids in join order; the host is first. */
  readonly players: readonly string[];
  /** Every command accepted so far. */
  readonly log: readonly CommandEntry<C>[];
  /** Fires once per accepted command, in order, on every player (including the sender). */
  readonly onCommand: Signal<[entry: CommandEntry<C>]>;
  readonly onPlayersChanged: Signal<[players: readonly string[]]>;
  /** The host refused a command this player submitted. */
  readonly onRejected: Signal<[command: C, reason: string]>;
  readonly onClosed: Signal<[reason: string]>;
  submit(command: C): void;
  close(): void;
}

export interface HostOptions<C> {
  /**
   * Runs on the host before a command is accepted. Return a string to reject it with
   * that reason. This is where cheating and out-of-turn actions are stopped.
   */
  validate?: (candidate: { playerId: string; command: C }, log: readonly CommandEntry<C>[]) => string | void;
  /** Refuse new players beyond this many (including the host). */
  maxPlayers?: number;
}

type Wire<C> =
  | { t: 'hello' }
  | { t: 'welcome'; players: string[]; log: CommandEntry<C>[] }
  | { t: 'players'; players: string[] }
  | { t: 'submit'; command: C }
  | { t: 'command'; entry: CommandEntry<C> }
  | { t: 'rejected'; command: C; reason: string }
  | { t: 'refused'; reason: string };

/**
 * `Session` over any `Transport`, with one player acting as host. The host decides the
 * order of commands and relays them; clients only talk to the host (a star topology).
 * If the host leaves, the session closes (there is no host migration).
 */
export class CommandSession<C> implements Session<C> {
  readonly onCommand = new Signal<[entry: CommandEntry<C>]>();
  readonly onPlayersChanged = new Signal<[players: readonly string[]]>();
  readonly onRejected = new Signal<[command: C, reason: string]>();
  readonly onClosed = new Signal<[reason: string]>();

  private playerList: string[] = [];
  private entries: CommandEntry<C>[] = [];
  private closed = false;
  private readonly unsubscribe: (() => void)[] = [];

  /** Starts a session as the host. */
  static host<C>(transport: Transport, options: HostOptions<C> = {}): CommandSession<C> {
    return new CommandSession<C>(transport, null, options);
  }

  /** Joins the session hosted by `hostId`. Players and past commands arrive via the signals. */
  static join<C>(transport: Transport, hostId: string): CommandSession<C> {
    return new CommandSession<C>(transport, hostId, {});
  }

  /** A session with a single local player: single-player and hot-seat games use the same code path as online ones. */
  static local<C>(options: HostOptions<C> = {}): CommandSession<C> {
    return CommandSession.host<C>(new LoopbackHub().connect('local'), options);
  }

  private constructor(
    private readonly transport: Transport,
    private readonly hostId: string | null,
    private readonly options: HostOptions<C>,
  ) {
    this.unsubscribe.push(
      transport.onMessage.add((peerId, message) => this.receive(peerId, message as Wire<C>)),
      transport.onPeerLeft.add((peerId) => this.peerLeft(peerId)),
    );
    if (hostId === null) {
      this.playerList = [transport.localId];
    } else {
      this.send(hostId, { t: 'hello' });
    }
  }

  get localId(): string {
    return this.transport.localId;
  }

  get isHost(): boolean {
    return this.hostId === null;
  }

  get players(): readonly string[] {
    return this.playerList;
  }

  get log(): readonly CommandEntry<C>[] {
    return this.entries;
  }

  submit(command: C): void {
    if (this.closed) throw new Error('This session is closed.');
    if (this.hostId === null) this.accept(this.localId, command);
    else this.send(this.hostId, { t: 'submit', command });
  }

  close(): void {
    this.shutDown('closed locally');
    this.transport.close();
  }

  private send(peerId: string, message: Wire<C>): void {
    this.transport.send(peerId, message);
  }

  private broadcast(message: Wire<C>): void {
    for (const playerId of this.playerList) {
      if (playerId !== this.localId) this.send(playerId, message);
    }
  }

  /** Host only: validate, number and distribute a command. */
  private accept(playerId: string, command: C): void {
    const reason = this.options.validate?.({ playerId, command }, this.entries);
    if (typeof reason === 'string') {
      if (playerId === this.localId) this.onRejected.emit(command, reason);
      else this.send(playerId, { t: 'rejected', command, reason });
      return;
    }
    const entry: CommandEntry<C> = { seq: this.entries.length, playerId, command };
    this.entries.push(entry);
    this.broadcast({ t: 'command', entry });
    this.onCommand.emit(entry);
  }

  private receive(peerId: string, message: Wire<C>): void {
    if (this.closed || !message || typeof message !== 'object') return;
    if (this.hostId === null) {
      // Host: only players may submit, and only newcomers may say hello.
      if (message.t === 'hello' && !this.playerList.includes(peerId)) {
        const max = this.options.maxPlayers ?? Number.POSITIVE_INFINITY;
        if (this.playerList.length >= max) {
          this.send(peerId, { t: 'refused', reason: 'The session is full.' });
          return;
        }
        this.playerList = [...this.playerList, peerId];
        this.send(peerId, { t: 'welcome', players: this.playerList, log: this.entries });
        this.broadcast({ t: 'players', players: this.playerList });
        this.onPlayersChanged.emit(this.playerList);
      } else if (message.t === 'submit' && this.playerList.includes(peerId)) {
        this.accept(peerId, message.command);
      }
      return;
    }
    // Client: only the host is trusted.
    if (peerId !== this.hostId) return;
    switch (message.t) {
      case 'welcome':
        this.playerList = message.players;
        this.onPlayersChanged.emit(this.playerList);
        for (const entry of message.log) this.deliver(entry);
        break;
      case 'players':
        this.playerList = message.players;
        this.onPlayersChanged.emit(this.playerList);
        break;
      case 'command':
        this.deliver(message.entry);
        break;
      case 'rejected':
        this.onRejected.emit(message.command, message.reason);
        break;
      case 'refused':
        this.shutDown(message.reason);
        break;
    }
  }

  private deliver(entry: CommandEntry<C>): void {
    // The transport is ordered, so anything else is a duplicate (e.g. sent just before the welcome).
    if (entry.seq !== this.entries.length) return;
    this.entries.push(entry);
    this.onCommand.emit(entry);
  }

  private peerLeft(peerId: string): void {
    if (this.closed) return;
    if (this.hostId === null) {
      if (!this.playerList.includes(peerId)) return;
      this.playerList = this.playerList.filter((id) => id !== peerId);
      this.broadcast({ t: 'players', players: this.playerList });
      this.onPlayersChanged.emit(this.playerList);
    } else if (peerId === this.hostId) {
      this.shutDown('The host left the session.');
    }
  }

  private shutDown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.onClosed.emit(reason);
  }
}
