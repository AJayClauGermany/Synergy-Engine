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
  /** @internal */ _spawned = false;
  /** @internal True while the server runs onNetworkSpawn, before clients have been told. */
  _spawning = false;
  /** @internal */ _behaviours: NetworkBehaviour[] = [];
  /** @internal Remote clients that currently have this object. The server always has it. */
  _visibleTo = new Set<number>();
  /** @internal Sends held back until the spawn message has gone out. */
  _heldSends: (() => void)[] = [];

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

  /** Server only. Creates this object on every client, owned by the server. Unity: `Spawn()`. */
  spawn(): void {
    this.manager().spawnObject(this, 0, false);
  }

  /** Server only. Spawns with a client as owner. Unity: `SpawnWithOwnership(clientId)`. */
  spawnWithOwnership(clientId: number): void {
    this.manager().spawnObject(this, clientId, false);
  }

  /** Server only. Spawns as `clientId`'s player object. Unity: `SpawnAsPlayerObject(clientId)`. */
  spawnAsPlayerObject(clientId: number): void {
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
