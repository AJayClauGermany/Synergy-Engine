import { Engine, MonoBehaviour, type UseCamelCase } from '@synergy/engine';
import type { NetworkManager } from './NetworkManager';
import { NetworkObject } from './NetworkObject';
import { NetworkVariableBase } from './NetworkVariable';
import { createRpc, type RpcDefinition, type RpcFunction, type RpcOptions, rpcDefinitionOf, SendTo } from './Rpc';

type NetworkMessage = 'onNetworkSpawn' | 'onNetworkDespawn' | 'onGainedOwnership' | 'onLostOwnership';

/**
 * A script that takes part in networking. Unity: `NetworkBehaviour`. Put it on a
 * `NetworkPrefab`; its `NetworkVariable` and RPC fields are found automatically.
 *
 *   export class Unit extends NetworkBehaviour {
 *     readonly health = new NetworkVariable(100);
 *
 *     // Clients ask; the server decides. Runs on the server.
 *     readonly attackRpc = this.serverRpc((targetId: number) => {
 *       const target = this.networkManager.spawnManager.spawnedObjects.get(targetId);
 *       target?.getComponent(Unit)?.takeDamage(10);
 *     });
 *
 *     // Server tells every client (and the host) to play the effect.
 *     readonly hitEffectRpc = this.clientRpc((x: number, y: number) => spawnSpark(x, y));
 *
 *     onNetworkSpawn() {
 *       if (this.isOwner) this.enableControls();
 *     }
 *
 *     takeDamage(amount: number) {
 *       if (this.isServer) this.health.value -= amount;
 *     }
 *   }
 *
 * Declare variables and RPCs as fields (so they exist on every machine in the same order)
 * and give each a unique field name; that name identifies it on the wire.
 */
export abstract class NetworkBehaviour extends MonoBehaviour {
  /** @internal Adds the network messages to the ones the engine checks the spelling of. */
  static override readonly _messageNames: readonly string[] = [
    ...MonoBehaviour._messageNames,
    'onNetworkSpawn',
    'onNetworkDespawn',
    'onGainedOwnership',
    'onLostOwnership',
  ];

  /** @internal */ _networkObject: NetworkObject | null = null;
  /** @internal */ _behaviourIndex = -1;
  /** @internal */ _variables = new Map<string, NetworkVariableBase>();
  /** @internal */ _rpcs = new Map<string, RpcDefinition>();

  // ---- Messages (all optional) ----------------------------------------------------------

  /**
   * The object has just spawned on this machine and its variables hold their initial
   * values. Subscribe to changes and set up owner-only things here, not in `awake`.
   */
  protected onNetworkSpawn?(): void;
  /** The object is about to be despawned (or the connection ended). */
  protected onNetworkDespawn?(): void;
  /** This machine's player became the owner. */
  protected onGainedOwnership?(): void;
  /** This machine's player stopped being the owner. */
  protected onLostOwnership?(): void;

  // Unity's spellings are type errors, as in MonoBehaviour: they would never be called.
  /** @deprecated Write `onNetworkSpawn()`. */
  declare protected OnNetworkSpawn?: UseCamelCase<'onNetworkSpawn'>;
  /** @deprecated Write `onNetworkDespawn()`. */
  declare protected OnNetworkDespawn?: UseCamelCase<'onNetworkDespawn'>;
  /** @deprecated Write `onGainedOwnership()`. */
  declare protected OnGainedOwnership?: UseCamelCase<'onGainedOwnership'>;
  /** @deprecated Write `onLostOwnership()`. */
  declare protected OnLostOwnership?: UseCamelCase<'onLostOwnership'>;

  // ---- Where am I? ----------------------------------------------------------------------

  /** The NetworkObject this script belongs to. */
  get networkObject(): NetworkObject {
    const object = this._networkObject ?? this.gameObject.getComponentInParent(NetworkObject);
    if (!object)
      throw new Error(`"${this.name}" has a NetworkBehaviour but no NetworkObject. Make it from a NetworkPrefab.`);
    return object;
  }

  /** The manager this object is spawned under. */
  get networkManager(): NetworkManager {
    const manager = this._networkObject?._manager;
    if (!manager)
      throw new Error(`"${this.name}" is not spawned, so it has no NetworkManager yet. Wait for onNetworkSpawn.`);
    return manager;
  }

  get isSpawned(): boolean {
    return this._networkObject?.isSpawned ?? false;
  }

  /** This machine is the server or the host. False until spawned. */
  get isServer(): boolean {
    return this._networkObject?._manager?.isServer ?? false;
  }

  /** This machine is a client or the host. False until spawned. */
  get isClient(): boolean {
    return this._networkObject?._manager?.isClient ?? false;
  }

  get isHost(): boolean {
    return this._networkObject?._manager?.isHost ?? false;
  }

  /** The local player owns this object. */
  get isOwner(): boolean {
    return this._networkObject?.isOwner ?? false;
  }

  get isOwnedByServer(): boolean {
    return this._networkObject?.isOwnedByServer ?? false;
  }

  /** This is the local player's own player object. */
  get isLocalPlayer(): boolean {
    return this._networkObject?.isLocalPlayer ?? false;
  }

  get ownerClientId(): number {
    return this._networkObject?.ownerClientId ?? 0;
  }

  get networkObjectId(): number {
    return this._networkObject?.networkObjectId ?? 0;
  }

  /** This script's position among the NetworkBehaviours of its NetworkObject. */
  get networkBehaviourId(): number {
    return this._behaviourIndex;
  }

  /** Inside an RPC handler: the client that called it. Unity: `ServerRpcParams.Receive.SenderClientId`. */
  protected get rpcSenderClientId(): number {
    return this.networkManager.currentRpcSender;
  }

  // ---- Declaring RPCs -------------------------------------------------------------------

  /**
   * Declares an RPC: a method you call on one machine that runs on others. Unity:
   * `[Rpc(SendTo.X)]`. Call it as a function; arguments must be plain JSON data.
   *
   *   readonly pingRpc = this.rpc(SendTo.Everyone, (message: string) => console.log(message));
   *   this.pingRpc('hello');
   */
  protected rpc<A extends unknown[]>(
    to: SendTo,
    handler: (...args: A) => void,
    options: RpcOptions = {},
  ): RpcFunction<A> {
    return createRpc(this, to, handler, { requireOwnership: options.requireOwnership ?? false, serverOnly: false });
  }

  /**
   * A request from a client to the server. Unity: `[ServerRpc]`. The handler runs on the
   * server (the host); on the server itself, calling it just runs it. By default only the
   * owner may call it; pass `{ requireOwnership: false }` to let any client.
   */
  protected serverRpc<A extends unknown[]>(handler: (...args: A) => void, options: RpcOptions = {}): RpcFunction<A> {
    return createRpc(this, SendTo.Server, handler, {
      requireOwnership: options.requireOwnership ?? true,
      serverOnly: false,
    });
  }

  /**
   * An order from the server to every client, host included. Unity: `[ClientRpc]`. Only
   * the server may call it. Use `.sendTo([clientId], ...)` to reach specific clients.
   */
  protected clientRpc<A extends unknown[]>(handler: (...args: A) => void): RpcFunction<A> {
    return createRpc(this, SendTo.ClientsAndHost, handler, { requireOwnership: false, serverOnly: true });
  }

  // ---- Engine plumbing ------------------------------------------------------------------

  /** @internal Finds this script's variables and RPCs; called when the object spawns. */
  _netInit(object: NetworkObject, index: number): void {
    this._networkObject = object;
    this._behaviourIndex = index;
    this._variables.clear();
    this._rpcs.clear();
    for (const [name, value] of Object.entries(this)) {
      if (value instanceof NetworkVariableBase) {
        value._bind(this, name);
        this._variables.set(name, value);
        continue;
      }
      const definition = rpcDefinitionOf(value);
      if (definition) {
        definition.name = name;
        this._rpcs.set(name, definition);
      }
    }
  }

  /** @internal */
  _netRelease(): void {
    for (const variable of this._variables.values()) variable._unbind();
  }

  /** @internal Calls one of the NetworkBehaviour messages, reporting exceptions like the engine does. */
  _netCall(message: NetworkMessage): void {
    const handler = (this as unknown as Record<NetworkMessage, (() => void) | undefined>)[message];
    if (typeof handler !== 'function') return;
    try {
      handler.call(this);
    } catch (error) {
      const context = `${this.constructor.name}.${message} on "${this.name}"`;
      const engine = Engine.current;
      if (engine) engine.reportError(error, context);
      else throw error;
    }
  }

  /** @internal */
  _invokeRpc(definition: RpcDefinition, args: unknown[], targets: readonly number[] | undefined): void {
    this.networkManager._invokeRpc(this, definition, args, targets);
  }

  /**
   * Cloning (`instantiate(someObject)`) copies public fields. Variables and RPCs belong
   * to one instance, so each clone keeps the ones its own field initialisers created.
   */
  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    const own = Object.entries(this).filter(
      ([, value]) => value instanceof NetworkVariableBase || rpcDefinitionOf(value),
    );
    super._copyFrom(source, remap);
    for (const [key, value] of own) (this as Record<string, unknown>)[key] = value;
  }
}
