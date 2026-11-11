import { ConvexClient } from 'convex/browser';
import { anyApi, type FunctionReference } from 'convex/server';
import { type CommandEntry, type Session } from './Session';
import { Signal } from './Signal';

export interface RoomInfo {
  /** Short code players share to join. */
  code: string;
  name: string;
  status: 'open' | 'playing' | 'closed';
  hostId: string;
  /** The host's PeerJS room code, when gameplay runs over WebRTC. */
  peerCode?: string;
  maxPlayers: number;
  players: { id: string; name: string }[];
}

// The functions in /convex, referenced by name so this package does not depend on the
// app's generated code. Keep these in step with convex/rooms.ts and convex/commands.ts.
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<'mutation', 'public', Args, Result>;
type Query<Args extends Record<string, unknown>, Result> = FunctionReference<'query', 'public', Args, Result>;
const api = anyApi as unknown as {
  rooms: {
    create: Mutation<
      { name: string; playerId: string; playerName: string; peerCode?: string; maxPlayers?: number },
      RoomInfo
    >;
    join: Mutation<{ code: string; playerId: string; playerName: string }, RoomInfo>;
    leave: Mutation<{ code: string; playerId: string }, null>;
    heartbeat: Mutation<{ code: string; playerId: string }, null>;
    setStatus: Mutation<{ code: string; playerId: string; status: RoomInfo['status'] }, null>;
    get: Query<{ code: string }, RoomInfo | null>;
    listOpen: Query<Record<string, never>, RoomInfo[]>;
  };
  commands: {
    submit: Mutation<{ code: string; playerId: string; command: unknown }, number>;
    list: Query<{ code: string; after?: number }, CommandEntry<unknown>[]>;
  };
};

const PLAYER_ID_KEY = 'synergy.playerId';
const HEARTBEAT_MS = 25_000;
/** Re-subscribe with a later cursor after this many commands, so updates stay small. */
const CURSOR_STEP = 200;

function persistentPlayerId(): string {
  try {
    const stored = globalThis.localStorage?.getItem(PLAYER_ID_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    globalThis.localStorage?.setItem(PLAYER_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export interface ConvexLobbyOptions {
  /** Defaults to an id remembered in localStorage, so a player keeps their seat after a reload. */
  playerId?: string;
  playerName?: string;
}

/**
 * The persistent, live side of multiplayer, backed by Convex:
 *
 * - a room directory players can browse or join by code;
 * - `openSession(code)`: a `Session` whose command log is stored and ordered by the
 *   database. No WebRTC needed, matches survive reloads, and players can take turns
 *   hours apart. Ideal for turn-based games.
 *
 * For fast real-time play, use the lobby only to find each other (store the PeerJS code
 * in `peerCode`) and run the match over `PeerJsTransport`.
 *
 *   const lobby = new ConvexLobby(process.env.PUBLIC_CONVEX_URL!, { playerName: 'Ada' });
 *   const room = await lobby.createRoom({ name: "Ada's game" });
 *   const session = lobby.openSession<Command>(room.code);
 */
export class ConvexLobby {
  readonly client: ConvexClient;
  readonly playerId: string;
  playerName: string;
  private readonly ownsClient: boolean;

  constructor(urlOrClient: string | ConvexClient, options: ConvexLobbyOptions = {}) {
    this.ownsClient = typeof urlOrClient === 'string';
    this.client = typeof urlOrClient === 'string' ? new ConvexClient(urlOrClient) : urlOrClient;
    this.playerId = options.playerId ?? persistentPlayerId();
    this.playerName = options.playerName ?? 'Player';
  }

  createRoom(options: { name: string; peerCode?: string; maxPlayers?: number }): Promise<RoomInfo> {
    return this.client.mutation(api.rooms.create, {
      ...options,
      playerId: this.playerId,
      playerName: this.playerName,
    });
  }

  joinRoom(code: string): Promise<RoomInfo> {
    return this.client.mutation(api.rooms.join, { code, playerId: this.playerId, playerName: this.playerName });
  }

  async leaveRoom(code: string): Promise<void> {
    await this.client.mutation(api.rooms.leave, { code, playerId: this.playerId });
  }

  getRoom(code: string): Promise<RoomInfo | null> {
    return this.client.query(api.rooms.get, { code });
  }

  /** Tells the server you are still in the room. Rooms with no heartbeat for two minutes are closed. */
  async heartbeat(code: string): Promise<void> {
    await this.client.mutation(api.rooms.heartbeat, { code, playerId: this.playerId });
  }

  /** Host only. Mark a room 'playing' to hide it from the open list. */
  async setStatus(code: string, status: RoomInfo['status']): Promise<void> {
    await this.client.mutation(api.rooms.setStatus, { code, playerId: this.playerId, status });
  }

  /** Calls back now and whenever the list of open rooms changes. Returns the unsubscribe function. */
  watchOpenRooms(callback: (rooms: RoomInfo[]) => void): () => void {
    return this.client.onUpdate(api.rooms.listOpen, {}, callback);
  }

  /** Calls back now and whenever this room changes (players joining, status, ...). */
  watchRoom(code: string, callback: (room: RoomInfo | null) => void): () => void {
    return this.client.onUpdate(api.rooms.get, { code }, callback);
  }

  /**
   * Opens the room's command session. Join the room first (`createRoom` / `joinRoom`).
   * Every command ever submitted is replayed through `onCommand`, then new ones arrive live.
   */
  openSession<C>(code: string): ConvexSession<C> {
    return new ConvexSession<C>(this, code.trim().toUpperCase());
  }

  close(): void {
    if (this.ownsClient) void this.client.close();
  }
}

/** A `Session` stored and ordered by Convex. Create it with `lobby.openSession(code)`. */
export class ConvexSession<C> implements Session<C> {
  readonly onCommand = new Signal<[entry: CommandEntry<C>]>();
  readonly onPlayersChanged = new Signal<[players: readonly string[]]>();
  readonly onRejected = new Signal<[command: C, reason: string]>();
  readonly onClosed = new Signal<[reason: string]>();

  private playerList: string[] = [];
  private hostId = '';
  private entries: CommandEntry<C>[] = [];
  private cursor = -1;
  private closed = false;
  private stopCommands: (() => void) | null = null;
  private readonly stopRoom: () => void;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  /** @internal */
  constructor(
    private readonly lobby: ConvexLobby,
    readonly code: string,
  ) {
    this.stopRoom = lobby.watchRoom(code, (room) => this.roomChanged(room));
    this.subscribe();
    this.heartbeat = setInterval(() => {
      void lobby.client.mutation(api.rooms.heartbeat, { code, playerId: lobby.playerId }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  get localId(): string {
    return this.lobby.playerId;
  }

  get isHost(): boolean {
    return this.hostId === this.lobby.playerId;
  }

  get players(): readonly string[] {
    return this.playerList;
  }

  get log(): readonly CommandEntry<C>[] {
    return this.entries;
  }

  submit(command: C): void {
    if (this.closed) throw new Error('This session is closed.');
    this.lobby.client
      .mutation(api.commands.submit, { code: this.code, playerId: this.lobby.playerId, command })
      .catch((error: unknown) => {
        this.onRejected.emit(command, error instanceof Error ? error.message : String(error));
      });
  }

  /** Stops listening. The room and its log stay on the server; call `lobby.leaveRoom` to leave for good. */
  close(): void {
    this.shutDown('closed locally');
  }

  private subscribe(): void {
    this.stopCommands?.();
    this.stopCommands = this.lobby.client.onUpdate(api.commands.list, { code: this.code, after: this.cursor }, (rows) =>
      this.received(rows as CommandEntry<C>[]),
    );
  }

  private received(rows: CommandEntry<C>[]): void {
    if (this.closed) return;
    for (const row of rows) {
      // Each update repeats rows we already have; only the next number in line is new.
      if (row.seq !== this.entries.length) continue;
      this.entries.push(row);
      this.onCommand.emit(row);
    }
    const newest = this.entries.length - 1;
    if (newest - this.cursor >= CURSOR_STEP) {
      this.cursor = newest;
      this.subscribe();
    }
  }

  private roomChanged(room: RoomInfo | null): void {
    if (this.closed) return;
    if (!room || room.status === 'closed') {
      this.shutDown('The room was closed.');
      return;
    }
    this.hostId = room.hostId;
    const players = room.players.map((player) => player.id);
    if (players.join('|') !== this.playerList.join('|')) {
      this.playerList = players;
      this.onPlayersChanged.emit(players);
    }
  }

  private shutDown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.stopCommands?.();
    this.stopRoom();
    this.onClosed.emit(reason);
  }
}
