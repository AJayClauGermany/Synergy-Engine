import { Engine, MonoBehaviour } from '@synergy/engine';
import { Signal } from '@synergy/net';
import { NetworkBehaviour } from './NetworkBehaviour';
import { NetworkManager } from './NetworkManager';

/**
 * Makes a GameObject exist on every machine. Unity: `NetworkObject`. It is added for you
 * by `NetworkPrefab`; the server calls `spawn()` and clients get a copy.
 *
 *   const unit = instantiate(UnitPrefab, position);
 *   unit.getComponent(NetworkObject)?.spawnWithOwnership(clientId);
 *
 * Network objects must be spawned and despawned by the server. Destroying the server's
 * copy despawns it everywhere.
 */
export class NetworkObject extends MonoBehaviour {
  /**
   * When the owner disconnects, keep this object and hand it to the server instead of
   * destroying it. Unity: `DontDestroyWithOwner`.
   */
  dontDestroyWithOwner = false;

  /**
   * Server only. Return false to keep this object from a client. Checked when the object
   * spawns and when a client joins; call `updateVisibility()` after the answer changes.
   * Unity: `CheckObjectVisibility`.
   */
  checkObjectVisibility: ((clientId: number) => boolean) | null = null;

  /** Fires on every machine when the owner changes. */
  onOwnershipChanged = new Signal<[previous: number, current: number]>();

  /** @internal The engine this object was created in, so it finds its own manager even if several engines share a process. */
  readonly _engine: Engine | null = Engine.current;
  /** @internal The NetworkPrefab this was made from. */
  _prefabName = '';
  /** @internal */ _manager: NetworkManager | null = null;
  /** @internal */ _id = 0;
  /** @internal */ _owner = 0;
  /** @internal */ _player = false;
  /** @internal */ _destroyWithScene = false;
  /** @internal */ _spawned = false;
  /** @internal True while the server runs onNetworkSpawn, before clients have been told. */
  _spawning = false;
  /** @internal */ _behaviours: NetworkBehaviour[] = [];
  /** @internal Remote clients that currently have this object. The server always has it. */
  _visibleTo = new Set<number>();
  /** @internal Sends held back until the spawn message has gone out. */
  _heldSends: (() => void)[] = [];

  /** What `Debug.hierarchy()` says about this object. */
  override _summary(): string {
    if (!this._spawned) return 'not spawned';
    const owner = this._owner === 0 ? 'the server' : `client ${this._owner}`;
    const hidden = this._manager?.isServer ? `, visible to clients [${[...this._visibleTo].join(', ')}]` : '';
    const scene = this._destroyWithScene ? ', destroyed with its scene' : '';
    return `id ${this._id}, owned by ${owner}${this._player ? ', player object' : ''}${scene}${hidden}`;
  }

  /** Unity: `NetworkObjectId`. 0 until spawned. */
  get networkObjectId(): number {
    return this._id;
  }

  get ownerClientId(): number {
    return this._owner;
  }

  get isSpawned(): boolean {
    return this._spawned;
  }

  /** The local player owns this object. */
  get isOwner(): boolean {
    return this._spawned && this._manager !== null && this._owner === this._manager.localClientId;
  }

  get isOwnedByServer(): boolean {
    return this._spawned && this._owner === 0;
  }

  /** The owner's player object (the one made from `playerPrefab`, or spawned with `spawnAsPlayerObject`). */
  get isPlayerObject(): boolean {
    return this._player;
  }

  /** The local player's own player object. */
  get isLocalPlayer(): boolean {
    return this._player && this.isOwner;
  }

  /**
   * Whether the object goes away when the server loads another scene with
   * `networkManager.sceneManager.loadScene`. False by default, as in Unity: a spawned
   * object outlives scene changes unless it was spawned with `spawn(true)`.
   * Unity: `DestroyWithScene`.
   */
  get destroyWithScene(): boolean {
    return this._destroyWithScene;
  }

  /** The manager this object is spawned under. */
  get networkManager(): NetworkManager {
    if (!this._manager) throw new Error(`"${this.name}" is not spawned.`);
    return this._manager;
  }

  /** Name of the NetworkPrefab this object was made from. */
  get prefabName(): string {
    return this._prefabName;
  }

  /** Whether `clientId` currently has this object. Server only. */
  isNetworkVisibleTo(clientId: number): boolean {
    return clientId === 0 || this._visibleTo.has(clientId);
  }

  // ---- Server actions -------------------------------------------------------------------

  /**
   * Server only. Creates this object on every client, owned by the server. Unity:
   * `Spawn(destroyWithScene)`. Pass `true` for things that belong to the current scene
   * (a match's units): they are removed when the server loads another scene through
   * `networkManager.sceneManager`. Left out, the object outlives scene changes.
   */
  spawn(destroyWithScene = false): void {
    this._destroyWithScene = destroyWithScene;
    this.manager().spawnObject(this, 0, false);
  }

  /** Server only. Spawns with a client as owner. Unity: `SpawnWithOwnership(clientId, destroyWithScene)`. */
  spawnWithOwnership(clientId: number, destroyWithScene = false): void {
    this._destroyWithScene = destroyWithScene;
    this.manager().spawnObject(this, clientId, false);
  }

  /** Server only. Spawns as `clientId`'s player object. Unity: `SpawnAsPlayerObject(clientId, destroyWithScene)`. */
  spawnAsPlayerObject(clientId: number, destroyWithScene = false): void {
    this._destroyWithScene = destroyWithScene;
    this.manager().spawnObject(this, clientId, true);
  }

  /**
   * Server only. Removes the object from every client, and destroys it here too unless
   * `destroy` is false (then it stays as an ordinary GameObject). Unity: `Despawn(destroy)`.
   */
  despawn(destroy = true): void {
    this.manager().despawnObject(this, destroy);
  }

  /** Server only. Unity: `ChangeOwnership(clientId)`. */
  changeOwnership(clientId: number): void {
    this.manager().changeOwnership(this, clientId);
  }

  /** Server only. Gives the object back to the server. Unity: `RemoveOwnership()`. */
  removeOwnership(): void {
    this.manager().changeOwnership(this, 0);
  }

  /** Server only. Sends the object to a client that was not seeing it. Unity: `NetworkShow(clientId)`. */
  networkShow(clientId: number): void {
    this.manager().showObject(this, clientId);
  }

  /** Server only. Removes the object from a client without despawning it elsewhere. Unity: `NetworkHide(clientId)`. */
  networkHide(clientId: number): void {
    this.manager().hideObject(this, clientId);
  }

  /** Server only. Shows or hides the object for every client according to `checkObjectVisibility`. */
  updateVisibility(): void {
    this.manager().updateVisibility(this);
  }

  private manager(): NetworkManager {
    const manager = this._manager ?? (this._engine && NetworkManager._of(this._engine.app));
    if (!manager) throw new Error('There is no NetworkManager. Add one to the scene before spawning.');
    return manager;
  }

  // ---- Engine plumbing ------------------------------------------------------------------

  /**
   * @internal The NetworkBehaviours that belong to this object: those on its GameObject
   * and its children. Another NetworkObject below it is refused, as in Unity.
   */
  _collectBehaviours(): NetworkBehaviour[] {
    const found: NetworkBehaviour[] = [];
    const visit = (transform: NetworkObject['transform'], root: boolean): void => {
      const gameObject = transform.gameObject;
      if (!root && gameObject.getComponent(NetworkObject)) {
        throw new Error(
          `"${gameObject.name}" has a NetworkObject but sits inside "${this.name}", which is also a NetworkObject. ` +
            'Nested NetworkObjects are not supported: make them separate prefabs and parent them in your own code.',
        );
      }
      found.push(...gameObject.getComponents(NetworkBehaviour));
      for (let i = 0; i < transform.childCount; i++) visit(transform.getChild(i), false);
    };
    visit(this.transform, true);
    return found;
  }

  /** @internal */
  _initBehaviours(): void {
    this._behaviours = this._collectBehaviours();
    this._behaviours.forEach((behaviour, index) => behaviour._netInit(this, index));
  }

  /**
   * @internal What this object is made of, as text: for each NetworkBehaviour, the names
   * of its variables and RPCs. The server sends it with a spawn and the client compares
   * it with its own copy, so builds that disagree say so instead of putting values in
   * the wrong variables. (Field names survive minification; class names do not, which is
   * why they are left out. Two builds that differ only in the order of behaviours with
   * identical members are told apart by `networkConfig.protocolVersion`.)
   */
  _layout(): string {
    return this._behaviours
      .map((behaviour) => `${[...behaviour._variables.keys()].sort().join(',')}|${[...behaviour._rpcs.keys()].sort().join(',')}`)
      .join(';');
  }

  /** @internal */
  _notifySpawn(): void {
    for (const behaviour of this._behaviours) behaviour._netCall('onNetworkSpawn');
  }

  /** @internal The object is leaving the network: tell its scripts and let go of its variables. */
  _release(): void {
    if (!this._spawned) return;
    this._spawned = false;
    for (const behaviour of this._behaviours) behaviour._netCall('onNetworkDespawn');
    for (const behaviour of this._behaviours) behaviour._netRelease();
    this._visibleTo.clear();
    this._heldSends = [];
  }

  /** The engine calls this. Destroying a spawned object removes it from the network. */
  onDestroy(): void {
    if (this._spawned) this._manager?.objectDestroyed(this);
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    const signal = this.onOwnershipChanged;
    super._copyFrom(source, remap);
    this.onOwnershipChanged = signal;
  }
}
