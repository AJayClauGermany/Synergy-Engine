import { Engine, GameObject, instantiate, Vector3 } from '@synergy/engine';
import { LoopbackHub, type LoopbackTransport } from '@synergy/net';
import {
  NetworkBehaviour,
  NetworkList,
  NetworkManager,
  NetworkObject,
  NetworkPrefab,
  NetworkTransform,
  NetworkVariable,
  NetworkVariableReadPermission,
  NetworkVariableWritePermission,
  type RpcFunction,
  SendTo,
  Serializers,
} from '../src';

/** A scripted unit that exercises every kind of replicated member. */
export class Unit extends NetworkBehaviour {
  readonly hp = new NetworkVariable(100);
  readonly tags = new NetworkList<string>();
  /** Written by the owner. */
  readonly note = new NetworkVariable('', { write: NetworkVariableWritePermission.Owner });
  /** A list the owner writes. */
  readonly notes = new NetworkList<string>([], { write: NetworkVariableWritePermission.Owner });
  /** Readable by the owner only. */
  readonly secret = new NetworkVariable(0, { read: NetworkVariableReadPermission.Owner });
  readonly aim = new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 });

  /** What this copy of the object has seen, for assertions. */
  readonly seen: string[] = [];

  readonly hitRpc: RpcFunction<[amount: number]> = this.serverRpc((amount: number) => {
    this.seen.push(`hit ${amount} from ${this.rpcSenderClientId}`);
    this.hp.value -= amount;
  });
  readonly openRpc = this.rpc(SendTo.Server, (text: string) => this.seen.push(`open ${text} from ${this.rpcSenderClientId}`), {
    requireOwnership: false,
  });
  readonly shoutRpc = this.clientRpc((text: string) => this.seen.push(`shout ${text}`));
  readonly everyoneRpc = this.rpc(SendTo.Everyone, (text: string) => this.seen.push(`everyone ${text}`));
  readonly notMeRpc = this.rpc(SendTo.NotMe, (text: string) => this.seen.push(`notMe ${text}`));
  readonly ownerRpc = this.rpc(SendTo.Owner, (text: string) => this.seen.push(`owner ${text}`));
  readonly notOwnerRpc = this.rpc(SendTo.NotOwner, (text: string) => this.seen.push(`notOwner ${text}`));
  readonly notServerRpc = this.rpc(SendTo.NotServer, (text: string) => this.seen.push(`notServer ${text}`));
  readonly meRpc = this.rpc(SendTo.Me, (text: string) => this.seen.push(`me ${text}`));
  readonly pickRpc = this.rpc(SendTo.SpecifiedInParams, (text: string) => this.seen.push(`pick ${text}`));

  onNetworkSpawn() {
    this.seen.push(`spawn hp=${this.hp.value} owner=${this.ownerClientId}`);
  }

  onNetworkDespawn() {
    this.seen.push('despawn');
  }

  onGainedOwnership() {
    this.seen.push('gained');
  }

  onLostOwnership() {
    this.seen.push('lost');
  }
}

/** A server-spawned object that calls a ClientRpc while spawning. */
export class Announcer extends NetworkBehaviour {
  readonly seen: string[] = [];
  readonly helloRpc = this.clientRpc((text: string) => this.seen.push(text));
  onNetworkSpawn() {
    if (this.isServer) this.helloRpc('from onNetworkSpawn');
  }
}

export const PlayerPrefab = new NetworkPrefab('Player', (go) => {
  go.addComponent(Unit);
});

export const CratePrefab = new NetworkPrefab('Crate', (go) => {
  go.addComponent(Unit);
});

export const AnnouncerPrefab = new NetworkPrefab('Announcer', (go) => {
  go.addComponent(Announcer);
});

export const MoverPrefab = new NetworkPrefab('Mover', (go) => {
  go.addComponent(NetworkTransform);
});

export const OwnerMoverPrefab = new NetworkPrefab('OwnerMover', (go) => {
  go.addComponent(NetworkTransform).authority = 'owner';
});

/** A prefab whose scripts live on children. */
export class Wheel extends NetworkBehaviour {
  readonly spin = new NetworkVariable(0);
}
export const CarPrefab = new NetworkPrefab('Car', (go) => {
  go.addComponent(Unit);
  const wheel = new GameObject('Wheel');
  wheel.transform.setParent(go.transform, false);
  wheel.addComponent(Wheel);
});

/** A mistake: a NetworkObject inside a NetworkObject. */
export const NestedPrefab = new NetworkPrefab('Nested', (go) => {
  const inner = new GameObject('Inner');
  inner.transform.setParent(go.transform, false);
  inner.addComponent(NetworkObject);
});

/** One simulated computer: its own engine, its own scene, its own NetworkManager. */
export class Machine {
  constructor(
    readonly id: string,
    readonly engine: Engine,
    readonly manager: NetworkManager,
    readonly transport: LoopbackTransport,
  ) {}

  run<T>(action: () => T): T {
    return this.engine.run(action);
  }

  step(frames = 1, deltaTime = 1 / 30): void {
    this.engine.stepFrames(frames, deltaTime);
  }

  /** Objects this machine has spawned, by NetworkObjectId. */
  object(id: number): NetworkObject {
    const found = this.manager.spawnManager.spawnedObjects.get(id);
    if (!found) throw new Error(`${this.id} has no object ${id}`);
    return found;
  }

  has(id: number): boolean {
    return this.manager.spawnManager.spawnedObjects.has(id);
  }

  unit(id: number): Unit {
    const unit = this.object(id).getComponent(Unit);
    if (!unit) throw new Error(`${this.id}: object ${id} has no Unit`);
    return unit;
  }

  /** The player object of a client, as this machine sees it. */
  player(clientId: number): Unit {
    const object = this.manager.spawnManager.getPlayerNetworkObject(clientId);
    if (!object) throw new Error(`${this.id} has no player object for client ${clientId}`);
    return object.getComponent(Unit) as Unit;
  }

  /** Makes an object from a prefab in this machine's scene (use before `spawn()`). */
  make(prefab: NetworkPrefab, position = Vector3.zero): NetworkObject {
    return this.run(() => instantiate(prefab, position).getComponent(NetworkObject) as NetworkObject);
  }
}

export interface MachineOptions {
  /** Called with the manager before anything starts, to change its configuration. */
  configure?: (manager: NetworkManager) => void;
}

/** Several machines joined by an in-memory network that delivers only when told to. */
export class TestNetwork {
  readonly hub = new LoopbackHub({ manual: true });
  readonly machines: Machine[] = [];

  create(id: string, options: MachineOptions = {}): Machine {
    const engine = Engine.createHeadless();
    const transport = this.hub.connect(id);
    const manager = engine.run(() => {
      const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
      manager.networkConfig.playerPrefab = PlayerPrefab;
      manager.networkPrefabs.add(CratePrefab).add(AnnouncerPrefab).add(CarPrefab).add(NestedPrefab).add(MoverPrefab).add(OwnerMoverPrefab);
      options.configure?.(manager);
      return manager;
    });
    const machine = new Machine(id, engine, manager, transport);
    this.machines.push(machine);
    return machine;
  }

  host(id = 'host', options: MachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startHost(machine.transport));
    return machine;
  }

  server(id = 'server', options: MachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startServer(machine.transport));
    return machine;
  }

  client(id: string, serverId = 'host', options: MachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startClient(machine.transport, serverId));
    return machine;
  }

  /** Runs frames on every machine, delivering messages between them each frame. */
  pump(frames = 8, deltaTime = 1 / 30): void {
    for (let i = 0; i < frames; i++) {
      this.hub.flush();
      for (const machine of this.machines) machine.step(1, deltaTime);
    }
    this.hub.flush();
  }

  dispose(): void {
    for (const machine of this.machines) machine.engine.dispose();
    this.machines.length = 0;
  }
}
