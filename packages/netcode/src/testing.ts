// Several simulated computers in one process, for testing networked game code without a
// browser or a real network. Import from '@synergy/netcode/testing' in tests only.
import { Engine, GameObject, instantiate, Vector3 } from '@synergy/engine';
import { LoopbackHub, type LoopbackTransport } from '@synergy/net';
import { NetworkManager } from './NetworkManager';
import { NetworkObject } from './NetworkObject';
import type { NetworkPrefab } from './NetworkPrefab';

/** One simulated computer: its own engine, its own scene, its own NetworkManager. */
export class TestMachine {
  constructor(
    /** Its id on the simulated network: what `client(id)` was given. */
    readonly id: string,
    readonly engine: Engine,
    readonly manager: NetworkManager,
    readonly transport: LoopbackTransport,
  ) {}

  /**
   * Runs `action` as this machine. Anything that touches the scene (`new GameObject`,
   * `instantiate`, `GameObject.find`, `Time`) must happen inside, because each machine
   * has its own engine and only one is current at a time.
   */
  run<T>(action: () => T): T {
    return this.engine.run(action);
  }

  step(frames = 1, deltaTime = 1 / 30): void {
    this.engine.stepFrames(frames, deltaTime);
  }

  /** This machine's copy of a spawned object, by NetworkObjectId. Throws if it has none. */
  object(id: number): NetworkObject {
    const found = this.manager.spawnManager.spawnedObjects.get(id);
    if (!found) throw new Error(`${this.id} has no object ${id}`);
    return found;
  }

  /** Whether this machine has a copy of the object: false for one hidden from it. */
  has(id: number): boolean {
    return this.manager.spawnManager.spawnedObjects.has(id);
  }

  /** Every spawned object on this machine made from the named prefab. */
  objectsOf(prefab: NetworkPrefab | string): NetworkObject[] {
    const name = typeof prefab === 'string' ? prefab : prefab.name;
    return [...this.manager.spawnManager.spawnedObjects.values()].filter((object) => object.prefabName === name);
  }

  /** Makes an object from a prefab in this machine's scene. On the server, call `spawn()` on it next. */
  make(prefab: NetworkPrefab, position = Vector3.zero): NetworkObject {
    return this.run(() => instantiate(prefab, position).getComponent(NetworkObject) as NetworkObject);
  }
}

export interface TestMachineOptions {
  /** Called with the manager before it starts, to change this machine's configuration. */
  configure?: (manager: NetworkManager) => void;
}

/**
 * Simulated machines joined by an in-memory network that delivers only when told to.
 *
 *   const net = new TestNetwork((manager) => {
 *     manager.networkConfig.playerPrefab = PlayerPrefab;      // what every machine registers
 *     manager.networkPrefabs.add(UnitPrefab);
 *   });
 *   const host = net.host();
 *   const guest = net.client('guest');
 *   net.pump();                                               // let them connect
 *
 *   const unit = host.make(UnitPrefab);
 *   host.run(() => unit.spawn());
 *   net.pump();
 *   expect(guest.has(unit.networkObjectId)).toBe(true);
 *
 *   afterEach(() => net.dispose());
 *
 * Messages travel through JSON, as on a real connection, so a value that would not
 * survive the network fails here too.
 */
export class TestNetwork<Machine extends TestMachine = TestMachine> {
  readonly hub = new LoopbackHub({ manual: true });
  readonly machines: Machine[] = [];

  /** `setup` configures the manager of every machine: register the same prefabs everywhere. */
  constructor(private readonly setup: (manager: NetworkManager) => void = () => {}) {}

  /** Override to hand out a subclass of `TestMachine` with helpers of your own. */
  protected wrap(id: string, engine: Engine, manager: NetworkManager, transport: LoopbackTransport): Machine {
    return new TestMachine(id, engine, manager, transport) as Machine;
  }

  /** A machine that has not started networking yet. `host`, `server` and `client` start it for you. */
  create(id: string, options: TestMachineOptions = {}): Machine {
    const engine = Engine.createHeadless();
    const transport = this.hub.connect(id);
    const manager = engine.run(() => {
      const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
      this.setup(manager);
      options.configure?.(manager);
      return manager;
    });
    const machine = this.wrap(id, engine, manager, transport);
    this.machines.push(machine);
    return machine;
  }

  /** A machine that is the server and a player at once (client 0). */
  host(id = 'host', options: TestMachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startHost(machine.transport));
    return machine;
  }

  /** A server that does not play. */
  server(id = 'server', options: TestMachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startServer(machine.transport));
    return machine;
  }

  /** A machine that joins `serverId`. It is connected after the next `pump()`. */
  client(id: string, serverId = 'host', options: TestMachineOptions = {}): Machine {
    const machine = this.create(id, options);
    machine.run(() => machine.manager.startClient(machine.transport, serverId));
    return machine;
  }

  /** Runs frames on every machine, delivering the messages between them each frame. */
  pump(frames = 8, deltaTime = 1 / 30): void {
    for (let i = 0; i < frames; i++) {
      this.hub.flush();
      for (const machine of this.machines) machine.step(1, deltaTime);
    }
    this.hub.flush();
  }

  /**
   * Like `pump`, but also lets promises settle between frames. Use it after anything
   * asynchronous: a networked scene load, an approval callback that returns a promise.
   */
  async settle(rounds = 6, deltaTime = 1 / 30): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      this.pump(2, deltaTime);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.pump(2, deltaTime);
  }

  /** Disposes every machine. Call it in `afterEach`. */
  dispose(): void {
    for (const machine of this.machines) machine.engine.dispose();
    this.machines.length = 0;
  }
}
