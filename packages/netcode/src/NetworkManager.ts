import { Debug, destroy, destroyImmediate, dontDestroyOnLoad, Engine, instantiate, MonoBehaviour, nameType, Quaternion, SceneManager, Time, Vector3 } from '@synergy/engine';
import { Signal, type Transport } from '@synergy/net';
import { CustomMessagingManager } from './CustomMessaging';
import type { NetworkBehaviour } from './NetworkBehaviour';
import { NetworkObject } from './NetworkObject';
import { type NetworkPrefab, NetworkPrefabs } from './NetworkPrefab';
import { NetworkSceneManager } from './NetworkSceneManager';
import { type NetworkVariableBase, NetworkVariableReadPermission, NetworkVariableWritePermission } from './NetworkVariable';
import {
  type ClientMessage,
  PROTOCOL_VERSION,
  type SceneRef,
  SERVER_CLIENT_ID,
  type ServerMessage,
  type SpawnData,
  type VarUpdate,
} from './protocol';
import { isRecipient, type RpcAudience, type RpcDefinition, SendTo } from './Rpc';

/** Settings shared by every machine. Unity: `NetworkConfig`. */
export interface NetworkConfig {
  /** Network updates per second. The server's value wins for clients. Default 30. */
  tickRate: number;
  /** Ask `connectionApprovalCallback` before admitting a client. Default false (admit everyone). */
  connectionApproval: boolean;
  /** Plain data a client sends with its connection request; the server sees it as `request.payload`. */
  connectionData: unknown;
  /** Created for every client that connects (and for the host). Registered automatically. */
  playerPrefab: NetworkPrefab | null;
  /** Refuse clients whose registered prefabs differ from the server's. Default true. */
  forceSamePrefabs: boolean;
  /** Most clients (not counting the host) the server admits. Default unlimited. */
  maxClients: number;
  /** Seconds a client waits for the server to answer before giving up. Default 10. */
  connectTimeout: number;
  /**
   * The version of the game this machine runs. A client whose value differs from the
   * server's is refused, with both values in the reason. Set it to something that changes
   * with every build (the sample game uses a hash of its source) so that two builds never
   * play together: that is the only complete protection against a prefab meaning one
   * thing on the host and another on a client. Default '' (not checked beyond being equal).
   * Unity: `NetworkConfig.ProtocolVersion`.
   */
  protocolVersion: string;
  /**
   * Seconds the server waits for clients to finish loading a scene before
   * `sceneManager.onLoadEventCompleted` reports them as timed out. Default 120.
   * Unity: `NetworkConfig.LoadSceneTimeOut`.
   */
  loadSceneTimeOut: number;
}

/** A scene load in progress on the server: who was asked, who has answered. */
interface SceneEvent extends SceneRef {
  waiting: Set<number>;
  done: number[];
  startedAt: number;
}

/** Passed to `connectionApprovalCallback`. Unity: `ConnectionApprovalRequest`. */
export interface ConnectionApprovalRequest {
  /** The client id this connection would get. */
  clientNetworkId: number;
  /** `networkConfig.connectionData` as the client set it. */
  payload: unknown;
}

/** Fill this in from `connectionApprovalCallback`. Unity: `ConnectionApprovalResponse`. */
export interface ConnectionApprovalResponse {
  /** Must be set to true to admit the client. */
  approved: boolean;
  /** Spawn the player prefab for this client. Default true. */
  createPlayerObject: boolean;
  /** Where the player object appears. */
  position?: Vector3;
  rotation?: Quaternion;
  /** Shown to the client when `approved` is false. */
  reason: string;
}

/** A point on the network clock. Unity: `NetworkTime`. */
export interface NetworkTime {
  tick: number;
  /** Seconds, `tick / tickRate`. */
  time: number;
}

/** A connected player, as the server sees them. Unity: `NetworkClient`. */
export class NetworkClient {
  constructor(
    readonly clientId: number,
    private readonly manager: NetworkManager,
  ) {}

  /** Their player object, if one has been spawned. */
  get playerObject(): NetworkObject | null {
    return this.manager.spawnManager.getPlayerNetworkObject(this.clientId);
  }

  /** Everything they own. */
  get ownedObjects(): NetworkObject[] {
    return [...this.manager.spawnManager.spawnedObjects.values()].filter((object) => object.ownerClientId === this.clientId);
  }
}

/** Looks up spawned objects. Unity: `NetworkManager.SpawnManager`. */
export class SpawnManager {
  /** Every object spawned on this machine, by NetworkObjectId. */
  readonly spawnedObjects = new Map<number, NetworkObject>();

  constructor(private readonly manager: NetworkManager) {}

  getPlayerNetworkObject(clientId: number): NetworkObject | null {
    for (const object of this.spawnedObjects.values()) {
      if (object.isPlayerObject && object.ownerClientId === clientId) return object;
    }
    return null;
  }

  getLocalPlayerObject(): NetworkObject | null {
    return this.getPlayerNetworkObject(this.manager.localClientId);
  }
}

type Role = 'none' | 'server' | 'host' | 'client';
type InboxItem = { peer: string; message: unknown } | { peer: string; left: true };

/** Keyed by PlayCanvas app so that several engines can share a process (tests). A game has just one. */
const managers = new WeakMap<object, NetworkManager>();

/**
 * Starts, runs and stops networking. Unity: `NetworkManager`. Add it to a GameObject in
 * your first scene, register your prefabs, then host or join:
 *
 *   const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
 *   manager.networkConfig.playerPrefab = PlayerPrefab;
 *   manager.networkPrefabs.add(UnitPrefab);
 *
 *   // one player hosts: server and client in one
 *   manager.startHost(await PeerJsTransport.host());
 *   // everyone else joins that host
 *   manager.startClient(await PeerJsTransport.join(code));
 *
 * The topology is a star: the host is the server, and clients talk only to it. The host
 * decides everything (it owns the truth, so it can also play), which is simple and fast
 * to build with; it also means a modified client can lie to its own host. That is an
 * accepted trade for prototypes.
 *
 * Create the manager before the scripts that depend on it: its `update` receives the
 * network's messages, so it should run first in the frame (Unity: script execution order).
 */
export class NetworkManager extends MonoBehaviour {
  /** The manager of the running game. Unity: `NetworkManager.Singleton`. */
  static get singleton(): NetworkManager | null {
    const engine = Engine.current;
    return (engine && managers.get(engine.app)) ?? null;
  }

  /** @internal The manager of the engine a GameObject lives in. */
  static _of(app: object): NetworkManager | null {
    return managers.get(app) ?? null;
  }

  /** Unity: `NetworkManager.ServerClientId`. */
  static readonly serverClientId = SERVER_CLIENT_ID;

  readonly networkConfig: NetworkConfig = {
    tickRate: 30,
    connectionApproval: false,
    connectionData: undefined,
    playerPrefab: null,
    forceSamePrefabs: true,
    maxClients: Number.POSITIVE_INFINITY,
    connectTimeout: 10,
    protocolVersion: '',
    loadSceneTimeOut: 120,
  };

  /** Everything that can be spawned. Register the same prefabs on every machine. */
  readonly networkPrefabs = new NetworkPrefabs();

  /**
   * Called on the server for each connection request when `networkConfig.connectionApproval`
   * is on. Fill in `response` (`approved = true` to admit); it may return a Promise.
   */
  connectionApprovalCallback: ((request: ConnectionApprovalRequest, response: ConnectionApprovalResponse) => void | Promise<void>) | null = null;

  readonly spawnManager = new SpawnManager(this);
  readonly customMessagingManager = new CustomMessagingManager(this);
  /** Loads a scene on every machine and says when all of them are ready. Unity: `NetworkManager.SceneManager`. */
  readonly sceneManager = new NetworkSceneManager(this);

  // ---- Events (Unity: the On...Callback delegates) --------------------------------------

  readonly onServerStarted = new Signal<[]>();
  /** `wasHost` is true when the machine was also a client. */
  readonly onServerStopped = new Signal<[wasHost: boolean]>();
  readonly onClientStarted = new Signal<[]>();
  readonly onClientStopped = new Signal<[wasHost: boolean]>();
  /** Server: a client was admitted (and the host itself at startup). Client: this client was admitted, with its own id. */
  readonly onClientConnectedCallback = new Signal<[clientId: number]>();
  /** Server: a client left. Client: this client lost the connection (see `disconnectReason`). */
  readonly onClientDisconnectCallback = new Signal<[clientId: number]>();
  /** The transport reported an error, or the connection could not be made. */
  readonly onTransportFailure = new Signal<[message: string]>();
  /**
   * Fires once for every network tick, in order. When a slow frame spans several ticks
   * it fires for each of them, one after another, before the changes are sent.
   * Unity: `NetworkTickSystem.Tick`.
   */
  readonly onTick = new Signal<[tick: number]>();

  /** Why this client was disconnected, as the server or the network reported it. Empty otherwise. */
  disconnectReason = '';

  // ---- State ------------------------------------------------------------------------------

  private engine: Engine | null = null;
  private role: Role = 'none';
  private connected = false;
  private transport: Transport | null = null;
  private serverPeer: string | null = null;
  private clientId = SERVER_CLIENT_ID;
  private inbox: InboxItem[] = [];
  private readonly offs: (() => void)[] = [];
  private readonly clientRecords = new Map<number, NetworkClient>();
  private readonly clientsByPeer = new Map<string, number>();
  private readonly peerOfClient = new Map<number, string>();
  private readonly pendingPeers = new Set<string>();
  private readonly dirtyVariables = new Set<NetworkVariableBase>();
  private readonly rpcSenders: number[] = [];
  private nextClientId = 1;
  private nextObjectId = 1;

  private clock = 0;
  private frameDelta = 0;
  private tickAccumulator = 0;
  private tick = 0;
  private lastHeartbeatTick = 0;
  private connectStartedAt = 0;
  private serverTickAtSync = 0;
  private clockAtSync = 0;

  /** @internal The scene the server last loaded for everyone. */
  _networkScene: SceneRef | null = null;
  /** @internal This machine is in the middle of a networked scene load. */
  _sceneLoading = false;
  private sceneEvent: SceneEvent | null = null;
  private nextSceneEvent = 1;

  // ---- Reading state ----------------------------------------------------------------------

  /** This machine is the server or the host. */
  get isServer(): boolean {
    return this.role === 'server' || this.role === 'host';
  }

  /** This machine is a client or the host. */
  get isClient(): boolean {
    return this.role === 'client' || this.role === 'host';
  }

  /** The server and a client in one: the machine that runs the game and also plays it. */
  get isHost(): boolean {
    return this.role === 'host';
  }

  /** Started as a server, host or client (a client counts while it is still connecting). */
  get isListening(): boolean {
    return this.role !== 'none';
  }

  /** The server has admitted this client. True for the host once started. */
  get isConnectedClient(): boolean {
    return this.isClient && this.connected;
  }

  /** This machine's client id. 0 for the host or server. */
  get localClientId(): number {
    return this.clientId;
  }

  /** The connected clients' ids. A client only knows its own. */
  get connectedClientsIds(): number[] {
    if (this.isServer) return [...this.clientRecords.keys()];
    return this.connected ? [this.clientId] : [];
  }

  /** Server only: the connected clients, including the host. */
  get connectedClients(): ReadonlyMap<number, NetworkClient> {
    return this.clientRecords;
  }

  get localClient(): NetworkClient | null {
    return this.connected ? new NetworkClient(this.clientId, this) : null;
  }

  /** The tick this machine is on. */
  get localTime(): NetworkTime {
    return { tick: this.tick, time: this.tick / this.networkConfig.tickRate };
  }

  /** The server's tick: exact on the server, a good estimate on clients. */
  get serverTime(): NetworkTime {
    if (this.isServer) return this.localTime;
    const rate = this.networkConfig.tickRate;
    const tick = this.serverTickAtSync + Math.floor((this.clock - this.clockAtSync) * rate + 1e-9);
    return { tick, time: tick / rate };
  }

  /** What `Debug.hierarchy()` says about the manager. */
  override _summary(): string {
    if (this.role === 'none') return 'not started';
    if (!this.connected) return `${this.role}, connecting`;
    const clients = this.isServer ? `, clients [${this.connectedClientsIds.join(', ')}]` : `, client id ${this.clientId}`;
    return `${this.role}${clients}, ${this.spawnManager.spawnedObjects.size} spawned, tick ${this.tick}`;
  }

  /** @internal Inside an RPC handler: the client that called it. -1 outside one. */
  get currentRpcSender(): number {
    return this.rpcSenders[this.rpcSenders.length - 1] ?? -1;
  }

  /** @internal Network clock in seconds, used to time-stamp snapshots. */
  get networkClock(): number {
    return this.clock;
  }

  // ---- Starting and stopping --------------------------------------------------------------

  /**
   * Starts as the server and a client at once. Unity: `StartHost()`. The transport is
   * how others reach you: `PeerJsTransport.host()` online, `hub.connect('host')` in tests.
   */
  startHost(transport: Transport): boolean {
    return this.scoped(() => {
      this.begin('host', transport);
      this.connected = true;
      this.clientRecords.set(SERVER_CLIENT_ID, new NetworkClient(SERVER_CLIENT_ID, this));
      this.onServerStarted.emit();
      this.onClientStarted.emit();
      this.createPlayerObject(SERVER_CLIENT_ID);
      this.onClientConnectedCallback.emit(SERVER_CLIENT_ID);
      return true;
    });
  }

  /** Starts as a server that does not play (a dedicated server). Unity: `StartServer()`. */
  startServer(transport: Transport): boolean {
    return this.scoped(() => {
      this.begin('server', transport);
      this.connected = true;
      this.clientRecords.set(SERVER_CLIENT_ID, new NetworkClient(SERVER_CLIENT_ID, this));
      this.onServerStarted.emit();
      return true;
    });
  }

  /**
   * Connects to a host or server. Unity: `StartClient()`. The connection finishes a few
   * frames later; wait for `onClientConnectedCallback`. `serverId` is the host's id on the
   * transport; `PeerJsTransport` supplies it as `hostId`.
   */
  startClient(transport: Transport, serverId?: string): boolean {
    const server = serverId ?? (transport as { hostId?: string }).hostId;
    if (!server) {
      throw new Error("startClient needs the server's id. Pass it, or use a transport that knows its host (PeerJsTransport).");
    }
    return this.scoped(() => {
      this.begin('client', transport);
      this.serverPeer = server;
      this.connectStartedAt = this.clock;
      this.onClientStarted.emit();
      transport.send(server, {
        t: 'connect',
        proto: PROTOCOL_VERSION,
        cfg: this.networkPrefabs.hash,
        ver: String(this.networkConfig.protocolVersion),
        payload: this.networkConfig.connectionData,
      } satisfies ClientMessage);
      return true;
    });
  }

  /**
   * Stops networking and closes the transport. Every spawned object is destroyed on this
   * machine, and clients are told the server went away. Unity: `Shutdown()`.
   */
  shutdown(): void {
    this.scoped(() => this.stop());
  }

  /** Server only. Removes a client. Unity: `DisconnectClient(clientId, reason)`. */
  disconnectClient(clientId: number, reason = 'You were disconnected by the server.'): void {
    this.requireServer('disconnect a client');
    if (clientId === SERVER_CLIENT_ID) throw new Error('The server cannot disconnect itself. Call shutdown().');
    if (!this.clientRecords.has(clientId)) return;
    this.sendTo(clientId, { t: 'disconnect', reason });
    this.scoped(() => this.removeClient(clientId));
  }

  private begin(role: Role, transport: Transport): void {
    if (this.role !== 'none') throw new Error('NetworkManager is already running. Call shutdown() first.');
    const playerPrefab = this.networkConfig.playerPrefab;
    if (playerPrefab) this.networkPrefabs.add(playerPrefab);
    this.role = role;
    this.transport = transport;
    this.connected = false;
    this.disconnectReason = '';
    this.clientId = SERVER_CLIENT_ID;
    this.inbox = [];
    this.tick = 0;
    this.tickAccumulator = 0;
    this.lastHeartbeatTick = 0;
    this.serverTickAtSync = 0;
    this.clockAtSync = this.clock;
    this.nextClientId = 1;
    this.nextObjectId = 1;
    this._networkScene = null;
    this._sceneLoading = false;
    this.sceneEvent = null;
    this.nextSceneEvent = 1;
    this.offs.push(
      transport.onMessage.add((peer, message) => this.inbox.push({ peer, message })),
      transport.onPeerLeft.add((peer) => this.inbox.push({ peer, left: true })),
    );
    const failures = (transport as { onError?: Signal<[Error]> }).onError;
    if (failures) this.offs.push(failures.add((error) => this.onTransportFailure.emit(error.message)));
  }

  private stop(): void {
    if (this.role === 'none') return;
    const wasServer = this.isServer;
    const wasClient = this.isClient;
    const wasHost = this.isHost;
    const wasConnectedClient = this.role === 'client' && this.connected;
    const localId = this.clientId;

    if (wasServer) {
      for (const id of this.remoteClientIds()) this.sendTo(id, { t: 'disconnect', reason: 'The server shut down.' });
    }
    for (const object of [...this.spawnManager.spawnedObjects.values()]) this.removeObject(object, true);
    for (const off of this.offs.splice(0)) off();
    this.transport?.close();

    this.role = 'none';
    this.connected = false;
    this.transport = null;
    this.serverPeer = null;
    this.clientId = SERVER_CLIENT_ID;
    this.inbox = [];
    this.clientRecords.clear();
    this.clientsByPeer.clear();
    this.peerOfClient.clear();
    this.pendingPeers.clear();
    this.dirtyVariables.clear();
    this.rpcSenders.length = 0;
    this._networkScene = null;
    this._sceneLoading = false;
    this.sceneEvent = null;

    if (wasConnectedClient) this.onClientDisconnectCallback.emit(localId);
    if (wasServer) this.onServerStopped.emit(wasHost);
    if (wasClient) this.onClientStopped.emit(wasHost);
  }

  // ---- The frame ----------------------------------------------------------------------------

  awake(): void {
    this.engine = Engine.current;
    if (this.engine) managers.set(this.engine.app, this);
  }

  onDestroy(): void {
    this.scoped(() => this.stop());
    if (this.engine && managers.get(this.engine.app) === this) managers.delete(this.engine.app);
  }

  /** Receives what arrived since the last frame. */
  update(): void {
    this.frameDelta = Time.unscaledDeltaTime;
    this.clock += this.frameDelta;
    if (this.role === 'client' && !this.connected && this.clock - this.connectStartedAt > this.networkConfig.connectTimeout) {
      this.disconnectReason = 'The server did not answer in time.';
      this.onTransportFailure.emit(this.disconnectReason);
      this.stop();
      return;
    }
    const event = this.sceneEvent;
    if (event && this.clock - event.startedAt > this.networkConfig.loadSceneTimeOut) this.finishSceneEvent(event);
    // A client loading a scene handles nothing else until it is loaded: what follows in
    // the queue (objects spawned into the new scene) needs the scene to be there.
    if (this._sceneLoading && this.role === 'client') return;

    const queue = this.inbox;
    this.inbox = [];
    for (let i = 0; i < queue.length && this.role !== 'none'; i++) {
      const item = queue[i] as InboxItem;
      try {
        this.process(item);
      } catch (error) {
        const engine = Engine.current;
        if (!engine) throw error;
        engine.reportError(error, `NetworkManager handling a message from "${item.peer}"`);
      }
      if (this._sceneLoading && this.role === 'client') {
        // That message started a scene load. Keep the rest, in order, for when it is done.
        this.inbox = [...queue.slice(i + 1), ...this.inbox];
        break;
      }
    }
  }

  /** Advances the network clock and sends what changed, once per tick. */
  lateUpdate(): void {
    if (this.role === 'none') return;
    const interval = 1 / this.networkConfig.tickRate;
    this.tickAccumulator += this.frameDelta;
    let advanced = false;
    // A listener may shut the network down, so look again after each tick.
    while (this.tickAccumulator + 1e-9 >= interval && this.isListening) {
      this.tickAccumulator -= interval;
      this.tick++;
      advanced = true;
      this.onTick.emit(this.tick);
    }
    if (advanced && this.isListening) this.flush();
  }

  private flush(): void {
    if (!this.connected) return;
    if (this.isServer) this.flushServer();
    else this.flushClient();
  }

  private flushServer(): void {
    const perClient = new Map<number, VarUpdate[]>();
    for (const variable of this.dirtyVariables) {
      if (!variable._dirty) continue;
      const behaviour = variable._behaviour;
      const object = behaviour?._networkObject;
      if (!behaviour || !object?._spawned) {
        variable._resetDirty();
        continue;
      }
      const update: VarUpdate = [object._id, behaviour._behaviourIndex, variable._name, variable._writeDelta()];
      for (const id of object._visibleTo) {
        if (id === variable._origin || !variable.canClientRead(id)) continue;
        const list = perClient.get(id);
        if (list) list.push(update);
        else perClient.set(id, [update]);
      }
      variable._resetDirty();
    }
    this.dirtyVariables.clear();

    // With nothing to say, still tell clients what tick it is now and then.
    const heartbeat = this.tick - this.lastHeartbeatTick >= this.networkConfig.tickRate;
    if (heartbeat) this.lastHeartbeatTick = this.tick;
    for (const id of this.remoteClientIds()) {
      const updates = perClient.get(id);
      if (updates || heartbeat) this.sendTo(id, { t: 'sync', tick: this.tick, u: updates ?? [] });
    }
  }

  private flushClient(): void {
    const updates: VarUpdate[] = [];
    for (const variable of this.dirtyVariables) {
      if (!variable._dirty) continue;
      const behaviour = variable._behaviour;
      const object = behaviour?._networkObject;
      if (behaviour && object?._spawned && variable.canClientWrite(this.clientId)) {
        updates.push([object._id, behaviour._behaviourIndex, variable._name, variable._writeDelta()]);
      }
      variable._resetDirty();
    }
    this.dirtyVariables.clear();
    if (updates.length > 0) this.sendToServer({ t: 'vars', u: updates });
  }

  /** @internal A spawned variable changed; send it at the next tick. */
  _variableDirtied(variable: NetworkVariableBase): void {
    this.dirtyVariables.add(variable);
  }

  // ---- Incoming messages --------------------------------------------------------------------

  private process(item: InboxItem): void {
    if ('left' in item) {
      this.peerLeft(item.peer);
      return;
    }
    const message = item.message as { t?: unknown } | null;
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return;
    if (this.isServer) this.onServerMessage(item.peer, message as ClientMessage);
    else if (this.role === 'client' && item.peer === this.serverPeer) this.onClientMessage(message as ServerMessage);
  }

  private peerLeft(peer: string): void {
    this.pendingPeers.delete(peer);
    if (this.isServer) {
      const id = this.clientsByPeer.get(peer);
      if (id !== undefined) this.removeClient(id);
    } else if (peer === this.serverPeer) {
      this.disconnectReason ||= 'The connection to the server was lost.';
      this.stop();
    }
  }

  private onServerMessage(peer: string, message: ClientMessage): void {
    if (message.t === 'connect') {
      this.onConnectionRequest(peer, message);
      return;
    }
    const id = this.clientsByPeer.get(peer);
    if (id === undefined) return; // not admitted
    switch (message.t) {
      case 'vars':
        if (Array.isArray(message.u)) for (const update of message.u) this.applyUpdate(update, id);
        break;
      case 'rpc':
        this.onClientRpc(id, message);
        break;
      case 'msg':
        this.customMessagingManager._deliver(message.n, id, message.d);
        break;
      case 'sceneLoaded':
        this.clientLoadedScene(id, message.e);
        break;
    }
  }

  private onClientMessage(message: ServerMessage): void {
    if (!this.connected) {
      if (message.t === 'approved') this.onApproved(message);
      else if (message.t === 'disconnect') {
        this.disconnectReason = message.reason;
        this.stop();
      }
      return;
    }
    switch (message.t) {
      case 'disconnect':
        this.disconnectReason = message.reason;
        this.stop();
        break;
      case 'spawn':
        this.clientSpawn(message.obj);
        break;
      case 'despawn': {
        const object = this.spawnManager.spawnedObjects.get(message.o);
        if (object) {
          this.removeObject(object, true);
        }
        break;
      }
      case 'owner': {
        const object = this.spawnManager.spawnedObjects.get(message.o);
        if (object) this.setOwner(object, message.w);
        break;
      }
      case 'sync':
        this.serverTickAtSync = message.tick;
        this.clockAtSync = this.clock;
        for (const update of message.u) this.applyUpdate(update, null);
        break;
      case 'rpc': {
        const object = this.spawnManager.spawnedObjects.get(message.o);
        if (object && Array.isArray(message.a)) this.runRpc(object, message.b, message.n, message.a, message.from);
        break;
      }
      case 'msg':
        this.customMessagingManager._deliver(message.n, message.from, message.d);
        break;
      case 'scene':
        this.loadSceneAsClient({ n: message.n, e: message.e });
        break;
      case 'sceneDone':
        this.sceneManager.onLoadEventCompleted.emit(message.n, message.ok, message.late);
        break;
    }
  }

  /** `from` is the client that sent it when the server is receiving; null for the server's own broadcasts. */
  private applyUpdate(update: VarUpdate, from: number | null): void {
    if (!Array.isArray(update)) return;
    const [objectId, behaviourIndex, name, data, full] = update;
    const object = this.spawnManager.spawnedObjects.get(objectId);
    const variable = object?._behaviours[behaviourIndex]?._variables.get(name);
    if (!object || !variable) return;
    if (from !== null) {
      const allowed =
        variable.writePermission === NetworkVariableWritePermission.Owner &&
        object.ownerClientId === from &&
        object.isNetworkVisibleTo(from);
      if (!allowed) {
        Debug.logWarning(`Client ${from} may not write NetworkVariable "${name}" on "${object.name}"; the change was ignored.`);
        return;
      }
      variable._readDelta(data, from);
    } else if (full) {
      variable._readFull(data, true);
    } else {
      variable._readDelta(data, null);
    }
  }

  // ---- Connecting -----------------------------------------------------------------------------

  private onConnectionRequest(peer: string, request: Extract<ClientMessage, { t: 'connect' }>): void {
    if (this.clientsByPeer.has(peer) || this.pendingPeers.has(peer)) return;
    const refuse = (reason: string) => this.transport?.send(peer, { t: 'disconnect', reason } satisfies ServerMessage);
    if (request.proto !== PROTOCOL_VERSION) {
      refuse('This client was built with a different version of the network protocol.');
      return;
    }
    const version = String(this.networkConfig.protocolVersion);
    if ((request.ver ?? '') !== version) {
      refuse(
        `This game is version "${version}" on the server and "${request.ver ?? ''}" here. ` +
          'Both must run the same build: reload the page, or update, and join again.',
      );
      return;
    }
    if (this.networkConfig.forceSamePrefabs && request.cfg !== this.networkPrefabs.hash) {
      refuse('Network configuration mismatch: the client and the server have different NetworkPrefabs registered.');
      return;
    }
    if (this.remoteClientIds().length >= this.networkConfig.maxClients) {
      refuse('The server is full.');
      return;
    }

    const response: ConnectionApprovalResponse = { approved: true, createPlayerObject: true, reason: '' };
    // Reserve the id now, so requests being approved at the same time each see their own.
    const clientId = this.nextClientId++;
    const finish = () => {
      this.pendingPeers.delete(peer);
      // The player may have left while the callback was thinking.
      if (this.role === 'none' || !this.isServer || !this.transport?.peers.includes(peer)) return;
      if (!response.approved) refuse(response.reason || 'The server did not approve the connection.');
      else this.admit(peer, clientId, response);
    };

    const callback = this.connectionApprovalCallback;
    if (this.networkConfig.connectionApproval && callback) {
      response.approved = false;
      const approvalRequest: ConnectionApprovalRequest = { clientNetworkId: clientId, payload: request.payload };
      const result = callback(approvalRequest, response);
      if (result instanceof Promise) {
        this.pendingPeers.add(peer);
        result.then(
          () => this.scoped(finish),
          (error: unknown) => {
            response.approved = false;
            response.reason = 'The server failed while approving the connection.';
            this.scoped(finish);
            Engine.current?.reportError(error, 'connectionApprovalCallback');
          },
        );
        return;
      }
    }
    finish();
  }

  private admit(peer: string, id: number, response: ConnectionApprovalResponse): void {
    this.clientsByPeer.set(peer, id);
    this.peerOfClient.set(id, peer);
    this.clientRecords.set(id, new NetworkClient(id, this));

    const objects: SpawnData[] = [];
    for (const object of [...this.spawnManager.spawnedObjects.values()].sort((a, b) => a._id - b._id)) {
      if (object.checkObjectVisibility && !object.checkObjectVisibility(id)) continue;
      object._visibleTo.add(id);
      objects.push(this.snapshot(object, id));
    }
    const scene = this._networkScene ?? undefined;
    this.sendTo(id, { t: 'approved', id, tick: this.tick, rate: this.networkConfig.tickRate, objs: objects, scene });

    if (response.createPlayerObject) {
      try {
        this.createPlayerObject(id, response.position, response.rotation);
      } catch (error) {
        // Do not leave a client admitted without the player it was promised.
        this.sendTo(id, { t: 'disconnect', reason: 'The server could not create your player.' });
        this.removeClient(id);
        throw error;
      }
    }
    this.onClientConnectedCallback.emit(id);
  }

  private onApproved(message: Extract<ServerMessage, { t: 'approved' }>): void {
    this.clientId = message.id;
    this.connected = true;
    this.networkConfig.tickRate = message.rate;
    this.tick = message.tick;
    this.serverTickAtSync = message.tick;
    this.clockAtSync = this.clock;
    const enter = () => {
      for (const data of message.objs) this.clientSpawn(data);
      this.onClientConnectedCallback.emit(message.id);
    };
    // The match may already be in a scene: load it first, so the objects have somewhere to go.
    if (message.scene) this.loadSceneAsClient(message.scene, enter);
    else enter();
  }

  private createPlayerObject(clientId: number, position?: Vector3, rotation?: Quaternion): void {
    const prefab = this.networkConfig.playerPrefab;
    if (!prefab) return;
    const root = instantiate(prefab, position ?? Vector3.zero, rotation ?? Quaternion.identity);
    const object = root.getComponent(NetworkObject);
    if (!object) throw new Error(`The player prefab "${prefab.name}" has no NetworkObject. Make it with new NetworkPrefab(...).`);
    this.spawnObject(object, clientId, true);
  }

  private removeClient(clientId: number): void {
    const peer = this.peerOfClient.get(clientId);
    if (peer !== undefined) this.clientsByPeer.delete(peer);
    this.peerOfClient.delete(clientId);
    this.clientRecords.delete(clientId);
    for (const object of this.spawnManager.spawnedObjects.values()) object._visibleTo.delete(clientId);
    // A scene load does not wait for someone who has left.
    const event = this.sceneEvent;
    if (event?.waiting.delete(clientId) && event.waiting.size === 0) this.finishSceneEvent(event);

    for (const object of [...this.spawnManager.spawnedObjects.values()]) {
      if (object.ownerClientId !== clientId) continue;
      if (!object.isPlayerObject && object.dontDestroyWithOwner) this.changeOwnership(object, SERVER_CLIENT_ID);
      else this.despawnObject(object, true);
    }
    this.onClientDisconnectCallback.emit(clientId);
  }

  // ---- Spawning ---------------------------------------------------------------------------------

  /** @internal Use `NetworkObject.spawn()`. */
  spawnObject(object: NetworkObject, owner: number, isPlayer: boolean): void {
    this.scoped(() => {
      this.requireServer('spawn objects');
      if (object._spawned) throw new Error(`"${object.name}" is already spawned.`);
      if (!object._prefabName) {
        throw new Error(`"${object.name}" was not made from a NetworkPrefab, so clients cannot create it. Use new NetworkPrefab(...).`);
      }
      if (!this.networkPrefabs.has(object._prefabName)) {
        throw new Error(`NetworkPrefab "${object._prefabName}" is not registered. Call networkManager.networkPrefabs.add(prefab) on the server and every client.`);
      }
      if (owner !== SERVER_CLIENT_ID && !this.clientRecords.has(owner)) {
        throw new Error(`Cannot spawn "${object.name}" for client ${owner}: that client is not connected.`);
      }
      if (isPlayer && this.spawnManager.getPlayerNetworkObject(owner)) {
        throw new Error(`Client ${owner} already has a player object.`);
      }

      object._initBehaviours(); // may refuse the object, so do it before anything is claimed
      object._manager = this;
      object._id = this.nextObjectId++;
      object._owner = owner;
      object._player = isPlayer;
      for (const id of this.remoteClientIds()) {
        if (!object.checkObjectVisibility || object.checkObjectVisibility(id)) object._visibleTo.add(id);
      }
      object._spawned = true;
      object._spawning = true;
      this.spawnManager.spawnedObjects.set(object._id, object);

      // The server's own scripts go first, so what they set in onNetworkSpawn is in the snapshot.
      object._notifySpawn();
      for (const id of object._visibleTo) this.sendTo(id, { t: 'spawn', obj: this.snapshot(object, id) });
      for (const behaviour of object._behaviours) {
        for (const variable of behaviour._variables.values()) variable._resetDirty();
      }
      object._spawning = false;
      // RPCs called from onNetworkSpawn were held until clients knew the object.
      const deferred = object._heldSends;
      object._heldSends = [];
      for (const send of deferred) send();
    });
  }

  /** @internal Use `NetworkObject.despawn()`. */
  despawnObject(object: NetworkObject, destroyObject: boolean): void {
    this.scoped(() => {
      this.requireServer('despawn objects');
      if (!object._spawned) throw new Error(`"${object.name}" is not spawned.`);
      for (const id of object._visibleTo) this.sendTo(id, { t: 'despawn', o: object._id });
      this.removeObject(object, destroyObject);
    });
  }

  /** @internal The game destroyed a spawned object without despawning it. */
  objectDestroyed(object: NetworkObject): void {
    if (this.role === 'none') return;
    if (this.isServer) {
      for (const id of object._visibleTo) this.sendTo(id, { t: 'despawn', o: object._id });
    } else if (!this._sceneLoading && !this.engine?.isDisposed) {
      // (During a networked scene load the old scene's objects go with it; the server's
      // despawns follow. And when the whole engine is shutting down, everything goes.)
      Debug.logWarning(`"${object.name}" was destroyed on a client. Only the server may destroy spawned objects; ask it with an RPC.`);
    }
    this.removeObject(object, false);
  }

  /** Takes an object off the network here, and destroys its GameObject if asked to. */
  private removeObject(object: NetworkObject, destroyObject: boolean): void {
    this.spawnManager.spawnedObjects.delete(object._id);
    object._release();
    if (destroyObject && !object.gameObject.isDestroyed) destroy(object.gameObject);
  }

  private clientSpawn(data: SpawnData): void {
    if (this.spawnManager.spawnedObjects.has(data.o)) return;
    const prefab = this.networkPrefabs.get(data.p);
    if (!prefab) {
      Debug.logError(`The server spawned NetworkPrefab "${data.p}", which is not registered on this client.`);
      return;
    }
    const root = instantiate(prefab, new Vector3(...data.pos), new Quaternion(...data.rot));
    root.transform.localScale = new Vector3(...data.sc);
    const object = root.getComponent(NetworkObject);
    if (!object) {
      Debug.logError(`NetworkPrefab "${data.p}" has no NetworkObject.`);
      return;
    }
    object._manager = this;
    object._id = data.o;
    object._owner = data.w;
    object._player = data.pl;
    object._destroyWithScene = data.ds === 1;
    object.dontDestroyWithOwner = data.k;
    object._initBehaviours();
    if (data.sig !== undefined && data.sig !== object._layout()) {
      // Carrying on would put the server's values into whichever variables happen to line up.
      destroyImmediate(root);
      throw new Error(
        `NetworkPrefab "${data.p}" is not the same here as on the server: its NetworkBehaviours have different ` +
          `variables or RPCs (server: ${data.sig || 'none'}; here: ${object._layout() || 'none'}). ` +
          'The two machines are running different builds; reload both. The object was not created.',
      );
    }
    for (const [behaviourIndex, name, state] of data.vars) {
      object._behaviours[behaviourIndex]?._variables.get(name)?._readFull(state, false);
    }
    object._spawned = true;
    this.spawnManager.spawnedObjects.set(object._id, object);
    object._notifySpawn();
  }

  private snapshot(object: NetworkObject, forClient: number): SpawnData {
    const vars: SpawnData['vars'] = [];
    object._behaviours.forEach((behaviour, index) => {
      for (const [name, variable] of behaviour._variables) {
        if (variable.canClientRead(forClient)) vars.push([index, name, variable._writeFull()]);
      }
    });
    const { transform } = object;
    return {
      o: object._id,
      p: object._prefabName,
      w: object._owner,
      pl: object._player,
      k: object.dontDestroyWithOwner,
      ds: object._destroyWithScene ? 1 : undefined,
      sig: object._layout(),
      pos: transform.position.toArray(),
      rot: transform.rotation.toArray(),
      sc: transform.localScale.toArray(),
      vars,
    };
  }

  // ---- Ownership and visibility -------------------------------------------------------------------

  /** @internal Use `NetworkObject.changeOwnership()`. */
  changeOwnership(object: NetworkObject, newOwner: number): void {
    this.requireServer('change ownership');
    if (!object._spawned) throw new Error(`"${object.name}" is not spawned.`);
    if (object._player) throw new Error(`"${object.name}" is a player object, so its owner cannot change. Despawn it and spawn another.`);
    if (newOwner !== SERVER_CLIENT_ID && !this.clientRecords.has(newOwner)) {
      throw new Error(`Cannot give "${object.name}" to client ${newOwner}: that client is not connected.`);
    }
    const previous = object._owner;
    if (previous === newOwner) return;
    this.setOwner(object, newOwner);
    for (const id of object._visibleTo) this.sendTo(id, { t: 'owner', o: object._id, w: newOwner });

    // The new owner may now read variables that were owner-only for someone else.
    if (newOwner !== SERVER_CLIENT_ID && object._visibleTo.has(newOwner)) {
      const updates: VarUpdate[] = [];
      object._behaviours.forEach((behaviour, index) => {
        for (const [name, variable] of behaviour._variables) {
          if (variable.readPermission === NetworkVariableReadPermission.Owner) {
            updates.push([object._id, index, name, variable._writeFull(), 1]);
          }
        }
      });
      if (updates.length > 0) this.sendTo(newOwner, { t: 'sync', tick: this.tick, u: updates });
    }
  }

  private setOwner(object: NetworkObject, newOwner: number): void {
    const previous = object._owner;
    if (previous === newOwner) return;
    object._owner = newOwner;
    for (const behaviour of object._behaviours) {
      if (previous === this.clientId) behaviour._netCall('onLostOwnership');
      if (newOwner === this.clientId) behaviour._netCall('onGainedOwnership');
    }
    object.onOwnershipChanged.emit(previous, newOwner);
  }

  /** @internal Use `NetworkObject.networkShow()`. */
  showObject(object: NetworkObject, clientId: number): void {
    this.requireServer('show objects');
    if (!object._spawned) throw new Error(`"${object.name}" is not spawned.`);
    if (clientId === SERVER_CLIENT_ID || object._visibleTo.has(clientId)) return;
    if (!this.clientRecords.has(clientId)) throw new Error(`Client ${clientId} is not connected.`);
    object._visibleTo.add(clientId);
    this.sendTo(clientId, { t: 'spawn', obj: this.snapshot(object, clientId) });
  }

  /** @internal Use `NetworkObject.networkHide()`. */
  hideObject(object: NetworkObject, clientId: number): void {
    this.requireServer('hide objects');
    if (!object._spawned) throw new Error(`"${object.name}" is not spawned.`);
    if (clientId === SERVER_CLIENT_ID) throw new Error('An object cannot be hidden from the server.');
    if (object._visibleTo.delete(clientId)) this.sendTo(clientId, { t: 'despawn', o: object._id });
  }

  /** @internal Use `NetworkObject.updateVisibility()`. */
  updateVisibility(object: NetworkObject): void {
    for (const id of this.remoteClientIds()) {
      if (!object.checkObjectVisibility || object.checkObjectVisibility(id)) this.showObject(object, id);
      else this.hideObject(object, id);
    }
  }

  // ---- Scenes ---------------------------------------------------------------------------------------

  /** @internal Use `sceneManager.loadScene()`. */
  _loadNetworkScene(name: string): Promise<void> {
    return this.scoped(() => {
      this.requireServer('load a scene for everyone');
      if (!SceneManager.isRegistered(name)) {
        throw new Error(`Scene "${name}" is not registered. Call SceneManager.register("${name}", ...) on the server and every client.`);
      }
      if (this._sceneLoading) throw new Error(`"${this._networkScene?.n}" is still loading. Wait for it before loading "${name}".`);

      const event: SceneEvent = {
        n: name,
        e: this.nextSceneEvent++,
        waiting: new Set(this.participantIds()),
        done: [],
        startedAt: this.clock,
      };
      this.sceneEvent = event;
      this._networkScene = { n: event.n, e: event.e };
      this._sceneLoading = true;
      // Clients hear about the scene before anything that will be spawned into it.
      for (const id of this.remoteClientIds()) this.sendTo(id, { t: 'scene', n: event.n, e: event.e });
      this.keepAcrossScenes();

      const loaded = () =>
        this.scoped(() => {
          this._sceneLoading = false;
          if (this.role !== 'none') this.clientLoadedScene(SERVER_CLIENT_ID, event.e);
        });
      return SceneManager.loadScene(name).then(loaded, (error: unknown) => {
        loaded();
        throw error;
      });
    });
  }

  /** @internal */
  _clientsLoading(): number[] {
    return this.sceneEvent ? [...this.sceneEvent.waiting] : [];
  }

  /** A client: load the scene the server named, holding everything else until it is there. */
  private loadSceneAsClient(scene: SceneRef, then?: () => void): void {
    this._networkScene = scene;
    this._sceneLoading = true;
    this.keepAcrossScenes();
    const loaded = () =>
      this.scoped(() => {
        if (this.role !== 'client' || this._networkScene?.e !== scene.e) return; // disconnected meanwhile
        this._sceneLoading = false;
        then?.();
        this.sendToServer({ t: 'sceneLoaded', e: scene.e });
        this.sceneManager.onLoadComplete.emit(this.clientId, scene.n);
      });
    if (!SceneManager.isRegistered(scene.n)) {
      Debug.logError(
        `The server loaded the scene "${scene.n}", which is not registered here. ` +
          `Call SceneManager.register("${scene.n}", ...) on every machine. Staying in the current scene.`,
      );
      loaded();
      return;
    }
    SceneManager.loadScene(scene.n).then(loaded, (error: unknown) => {
      Engine.current?.reportError(error, `loading the scene "${scene.n}" the server asked for`);
      loaded();
    });
  }

  /** Server: a machine reports that it has the scene. */
  private clientLoadedScene(clientId: number, eventId: number): void {
    const scene = this._networkScene;
    if (!scene || scene.e !== eventId) return; // an answer to an older load
    const event = this.sceneEvent;
    this.sceneManager.onLoadComplete.emit(clientId, scene.n);
    if (event?.waiting.delete(clientId)) {
      event.done.push(clientId);
      if (event.waiting.size === 0) this.finishSceneEvent(event);
    } else if (clientId !== SERVER_CLIENT_ID) {
      // It joined after the load began, so nobody was waiting for it: it has now caught up.
      this.sceneManager.onSynchronizeComplete.emit(clientId);
    }
  }

  /** Server: everyone has answered, left, or run out of time. */
  private finishSceneEvent(event: SceneEvent): void {
    if (this.sceneEvent !== event) return;
    this.sceneEvent = null;
    const timedOut = [...event.waiting];
    for (const id of this.remoteClientIds()) this.sendTo(id, { t: 'sceneDone', n: event.n, ok: event.done, late: timedOut });
    this.sceneManager.onLoadEventCompleted.emit(event.n, event.done, timedOut);
  }

  /**
   * Before a scene change: this manager, and every spawned object that is not marked to
   * die with its scene, move to DontDestroyOnLoad (Unity does the same). Objects parented
   * under something else stay with their parent.
   */
  private keepAcrossScenes(): void {
    if (!this.transform.parent) dontDestroyOnLoad(this.gameObject);
    for (const object of this.spawnManager.spawnedObjects.values()) {
      if (!object._destroyWithScene && !object.transform.parent) dontDestroyOnLoad(object.gameObject);
    }
  }

  // ---- RPCs ---------------------------------------------------------------------------------------

  /** @internal Called by an RPC field. */
  _invokeRpc(behaviour: NetworkBehaviour, definition: RpcDefinition, args: unknown[], targets: readonly number[] | undefined): void {
    const object = behaviour._networkObject;
    const name = definition.name;
    if (!object?._spawned || !this.connected) {
      throw new Error(`Cannot call RPC "${name}": "${behaviour.name}" is not spawned on a connected NetworkManager.`);
    }
    let mode = definition.mode;
    if (targets) {
      if (mode !== SendTo.SpecifiedInParams && !definition.serverOnly) {
        throw new Error(`"${name}".sendTo(...) only works on a clientRpc, or an rpc declared with SendTo.SpecifiedInParams.`);
      }
      mode = SendTo.SpecifiedInParams;
    } else if (mode === SendTo.SpecifiedInParams) {
      throw new Error(`"${name}" was declared with SendTo.SpecifiedInParams. Call ${name}.sendTo([clientIds], ...) instead.`);
    }
    if (definition.serverOnly && !this.isServer) {
      throw new Error(`"${name}" is a clientRpc, so only the server can call it. Use a serverRpc to ask the server.`);
    }
    if (!this.isServer && definition.mode === SendTo.Server && definition.requireOwnership && !object.isOwner) {
      throw new Error(`Only the owner can call "${name}" (it is owned by client ${object.ownerClientId}). Declare it with { requireOwnership: false } to allow anyone.`);
    }

    const sender = this.clientId;
    const audience: RpcAudience = { sender, owner: object._owner, hostIsClient: this.isHost, targets };
    const index = behaviour._behaviourIndex;
    if (this.isServer) {
      // The server knows everyone, so it decides who hears this and delivers to each.
      for (const id of this.participantIds()) {
        if (!isRecipient(mode, id, audience)) continue;
        if (id === SERVER_CLIENT_ID) this.runRpc(object, index, name, args, sender);
        else if (object._visibleTo.has(id)) this.sendTo(id, { t: 'rpc', o: object._id, b: index, n: name, a: args, from: sender }, object);
      }
      return;
    }
    if (isRecipient(mode, sender, audience)) this.runRpc(object, index, name, args, sender);
    if (mode !== SendTo.Me) {
      this.sendToServer({ t: 'rpc', o: object._id, b: index, n: name, a: args, ids: targets ? [...targets] : undefined });
    }
  }

  /** The server received an RPC from a client: check it, then run it here and pass it on. */
  private onClientRpc(senderId: number, message: Extract<ClientMessage, { t: 'rpc' }>): void {
    const object = this.spawnManager.spawnedObjects.get(message.o);
    const definition = object?._behaviours[message.b]?._rpcs.get(message.n);
    if (!object || !definition || !Array.isArray(message.a) || !object.isNetworkVisibleTo(senderId)) return;
    if (definition.serverOnly) {
      Debug.logWarning(`Client ${senderId} called the clientRpc "${message.n}", which only the server may call.`);
      return;
    }
    if (definition.mode === SendTo.Server && definition.requireOwnership && object.ownerClientId !== senderId) {
      Debug.logWarning(`Client ${senderId} called "${message.n}" on "${object.name}" without owning it; the call was ignored.`);
      return;
    }
    // The audience comes from the server's own declaration, never from the message.
    const mode = definition.mode;
    const targets = mode === SendTo.SpecifiedInParams && Array.isArray(message.ids) ? message.ids.filter(Number.isInteger) : undefined;
    const audience: RpcAudience = { sender: senderId, owner: object.ownerClientId, hostIsClient: this.isHost, targets };
    for (const id of this.participantIds()) {
      if (id === senderId || !isRecipient(mode, id, audience)) continue; // the caller already ran it
      if (id === SERVER_CLIENT_ID) this.runRpc(object, message.b, message.n, message.a, senderId);
      else if (object._visibleTo.has(id)) this.sendTo(id, { t: 'rpc', o: object._id, b: message.b, n: message.n, a: message.a, from: senderId }, object);
    }
  }

  private runRpc(object: NetworkObject, behaviourIndex: number, name: string, args: unknown[], from: number): void {
    const definition = object._behaviours[behaviourIndex]?._rpcs.get(name);
    if (!definition) return;
    this.rpcSenders.push(from);
    try {
      definition.handler(...args);
    } catch (error) {
      const engine = Engine.current;
      if (!engine) throw error;
      engine.reportError(error, `RPC ${name} on "${object.name}"`);
    } finally {
      this.rpcSenders.pop();
    }
  }

  // ---- Custom messages ------------------------------------------------------------------------------

  /** @internal */
  _sendNamed(name: string, data: unknown, targetClientId: number): void {
    if (!this.connected) throw new Error('Not connected.');
    if (targetClientId === this.clientId) {
      this.customMessagingManager._deliver(name, this.clientId, data);
    } else if (this.isServer) {
      if (!this.clientRecords.has(targetClientId)) throw new Error(`Client ${targetClientId} is not connected.`);
      this.sendTo(targetClientId, { t: 'msg', n: name, d: data, from: SERVER_CLIENT_ID });
    } else if (targetClientId === SERVER_CLIENT_ID) {
      this.sendToServer({ t: 'msg', n: name, d: data });
    } else {
      throw new Error('A client can only send messages to the server (client 0).');
    }
  }

  // ---- Plumbing ---------------------------------------------------------------------------------------

  /** Remote clients (everyone but the host or server). */
  private remoteClientIds(): number[] {
    return [...this.clientRecords.keys()].filter((id) => id !== SERVER_CLIENT_ID);
  }

  /** The server first, then every remote client. */
  private participantIds(): number[] {
    return [SERVER_CLIENT_ID, ...this.remoteClientIds()];
  }

  /** Sends to a client. While an object is still spawning, messages about it wait until its spawn has gone out. */
  private sendTo(clientId: number, message: ServerMessage, about?: NetworkObject): void {
    if (about?._spawning) {
      about._heldSends.push(() => this.sendTo(clientId, message));
      return;
    }
    const peer = this.peerOfClient.get(clientId);
    if (peer !== undefined) this.transport?.send(peer, message);
  }

  private sendToServer(message: ClientMessage): void {
    if (this.serverPeer !== null) this.transport?.send(this.serverPeer, message);
  }

  private requireServer(action: string): void {
    if (!this.isServer) throw new Error(`Only the server can ${action}. Ask it with a serverRpc.`);
  }

  /** Runs `action` with this manager's engine current, so the manager works even when several engines share a process. */
  private scoped<T>(action: () => T): T {
    return this.engine ? this.engine.run(action) : action();
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(NetworkManager, 'NetworkManager');
