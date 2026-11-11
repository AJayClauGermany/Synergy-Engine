import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Engine, GameObject, SceneManager } from '@synergy/engine';
import { NetworkBehaviour, NetworkPrefab, NetworkVariable } from '../src';
import { TestNetwork as BaseTestNetwork } from '../src/testing';
import { CratePrefab, PlayerPrefab, TestNetwork } from './harness';

let net: BaseTestNetwork;
afterEach(() => {
  net.dispose();
  slowLoads.length = 0;
});

// Scenes are registered once per process, like prefabs: every simulated machine sees them.
SceneManager.register('Lobby', () => {
  new GameObject('Lobby Sign');
});
SceneManager.register('Match', () => {
  new GameObject('Arena');
});
// Stands in for a scene whose assets take a while to arrive. Each machine that loads it
// waits here until the test lets it through, in the order they started loading.
const slowLoads: (() => void)[] = [];
SceneManager.register('SlowMatch', {
  preload: () => new Promise<void>((resolve) => slowLoads.push(resolve)),
  build: () => {
    new GameObject('Arena');
  },
});

/** A scene that cannot be built on one particular machine: a broken build, a missing asset. */
let brokenOn: Engine | null = null;
SceneManager.register('BrokenForOne', () => {
  if (Engine.current === brokenOn) throw new Error('this machine cannot build the scene');
  new GameObject('Arena');
});

function threeMachines() {
  const network = new TestNetwork();
  net = network;
  const host = network.host();
  const alice = network.client('alice');
  const bob = network.client('bob');
  network.pump();
  return { host, alice, bob };
}

describe('loading a scene for everyone', () => {
  test('every machine ends up in the scene, and the server hears from each of them', async () => {
    const { host, alice, bob } = threeMachines();
    const completed: number[] = [];
    const finished: [string, number[], number[]][] = [];
    host.manager.sceneManager.onLoadComplete.add((clientId) => completed.push(clientId));
    host.manager.sceneManager.onLoadEventCompleted.add((scene, loaded, timedOut) =>
      finished.push([scene, loaded, timedOut]),
    );
    const heardByAlice: string[] = [];
    alice.manager.sceneManager.onLoadComplete.add((clientId, scene) =>
      heardByAlice.push(`loaded ${scene} as ${clientId}`),
    );
    alice.manager.sceneManager.onLoadEventCompleted.add((scene, loaded) =>
      heardByAlice.push(`${scene} ready for ${loaded.join(',')}`),
    );

    const loading = host.run(() => host.manager.sceneManager.loadScene('Match'));
    expect(host.manager.sceneManager.clientsLoading).toEqual([0, 1, 2]);
    await loading;
    await net.settle();

    for (const machine of [host, alice, bob]) {
      expect(machine.run(() => GameObject.find('Arena'))).not.toBeNull();
      expect(machine.manager.sceneManager.sceneName).toBe('Match');
      expect(machine.manager.sceneManager.isLoading).toBe(false);
      // The manager itself was carried over.
      expect(machine.manager.isListening).toBe(true);
    }
    expect(completed.sort()).toEqual([0, 1, 2]);
    expect(finished).toEqual([['Match', [0, 1, 2], []]]);
    expect(host.manager.sceneManager.clientsLoading).toEqual([]);
    expect(heardByAlice).toEqual(['loaded Match as 1', 'Match ready for 0,1,2']);
  });

  test('objects spawned into the new scene reach a client only after it has the scene', async () => {
    const { host, alice } = threeMachines();
    const order: string[] = [];
    class Flag extends NetworkBehaviour {
      onNetworkSpawn() {
        // On a client, the scene must already be there when a match object arrives.
        order.push(
          `${this.isServer ? 'host' : 'client'} flag, arena ${GameObject.find('Arena') ? 'present' : 'missing'}`,
        );
      }
    }
    const FlagPrefab = new NetworkPrefab('Flag', (go) => {
      go.addComponent(Flag);
    });
    for (const machine of net.machines) machine.manager.networkPrefabs.add(FlagPrefab);

    const loading = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    net.pump(); // the clients have been told and are waiting on the scene's assets too
    expect(slowLoads.length).toBe(3);
    slowLoads[0]?.(); // the host's assets arrive first
    await loading;
    // The host spawns straight away, while the clients are still loading.
    const flag = host.make(FlagPrefab);
    host.run(() => flag.spawn(true));
    net.pump();
    expect(alice.has(flag.networkObjectId)).toBe(false);
    expect(alice.manager.sceneManager.isLoading).toBe(true);
    for (const release of slowLoads) release();
    await net.settle();

    expect(alice.has(flag.networkObjectId)).toBe(true);
    expect(order.filter((line) => line.startsWith('client'))).toEqual([
      'client flag, arena present',
      'client flag, arena present',
    ]);
    expect(order[0]).toBe('host flag, arena present');
  });

  test('objects outlive the change unless they were spawned to die with the scene', async () => {
    const { host, alice } = threeMachines();
    const keeper = host.make(CratePrefab);
    const scenery = host.make(CratePrefab);
    host.run(() => {
      keeper.spawn(); // Unity's default: stays
      scenery.spawn(true); // belongs to the current scene
    });
    net.pump();
    const aliceKeeper = alice.object(keeper.networkObjectId);
    expect(alice.object(scenery.networkObjectId).destroyWithScene).toBe(true);

    await host.run(() => host.manager.sceneManager.loadScene('Match'));
    await net.settle();

    for (const machine of [host, alice]) {
      expect(machine.has(keeper.networkObjectId)).toBe(true);
      expect(machine.has(scenery.networkObjectId)).toBe(false);
      // Player objects are ordinary spawned objects: they stay too.
      expect(machine.manager.spawnManager.getPlayerNetworkObject(1)).not.toBeNull();
    }
    // The same copy survived on the client, with its state: it was not made again.
    expect(alice.object(keeper.networkObjectId)).toBe(aliceKeeper);
    expect(aliceKeeper.gameObject.isDestroyed).toBe(false);

    // Still wired up: a change made after the load arrives.
    host.run(() => (host.unit(keeper.networkObjectId).hp.value = 12));
    net.pump();
    expect(alice.unit(keeper.networkObjectId).hp.value).toBe(12);
  });

  test('a client that joins afterwards loads the scene before it gets the objects', async () => {
    net = new TestNetwork();
    const host = net.host();
    await host.run(() => host.manager.sceneManager.loadScene('Match'));
    const crate = host.make(CratePrefab);
    host.run(() => crate.spawn(true));
    const synchronized: number[] = [];
    host.manager.sceneManager.onSynchronizeComplete.add((clientId) => synchronized.push(clientId));

    const late = net.client('late');
    let sceneWhenConnected: string | null = null;
    late.manager.onClientConnectedCallback.add(() => {
      sceneWhenConnected = late.run(() => SceneManager.getActiveScene().name);
    });
    await net.settle();

    expect(sceneWhenConnected as string | null).toBe('Match');
    expect(late.run(() => GameObject.find('Arena'))).not.toBeNull();
    expect(late.has(crate.networkObjectId)).toBe(true);
    expect(late.manager.sceneManager.sceneName).toBe('Match');
    expect(synchronized).toEqual([1]);
  });

  test('a client that leaves or takes too long does not hold the others up', async () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (manager) => (manager.networkConfig.loadSceneTimeOut = 1) });
    const alice = net.client('alice');
    const bob = net.client('bob');
    net.pump();
    const finished: [number[], number[]][] = [];
    host.manager.sceneManager.onLoadEventCompleted.add((_scene, loaded, timedOut) => finished.push([loaded, timedOut]));

    const loading = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    net.pump();
    // Alice goes away mid-load. Bob's assets never arrive: only the host's copy loads.
    alice.run(() => alice.manager.shutdown());
    net.pump();
    slowLoads[0]?.();
    await loading;
    expect(finished).toEqual([]); // still waiting for Bob
    expect(host.manager.sceneManager.clientsLoading).toEqual([2]);

    net.pump(40); // more than a second of game time
    expect(finished).toEqual([[[0], [2]]]);
    expect(bob.manager.sceneManager.isLoading).toBe(true);
  });

  test('it is the server that loads scenes, and only registered ones', () => {
    const { host, alice } = threeMachines();
    expect(() => alice.run(() => alice.manager.sceneManager.loadScene('Match'))).toThrow(
      'Only the server can load a scene for everyone',
    );
    expect(() => host.run(() => host.manager.sceneManager.loadScene('Nowhere'))).toThrow(
      'Scene "Nowhere" is not registered',
    );
    expect(host.manager.sceneManager.sceneName).toBeNull();
  });
});

describe('builds that do not match', () => {
  test('a client on another version of the game is refused, and told both versions', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (manager) => (manager.networkConfig.protocolVersion = 'build-a1') });
    const same = net.client('same', 'host', {
      configure: (manager) => (manager.networkConfig.protocolVersion = 'build-a1'),
    });
    const other = net.client('other', 'host', {
      configure: (manager) => (manager.networkConfig.protocolVersion = 'build-b2'),
    });
    const unset = net.client('unset');
    net.pump();

    expect(same.manager.isConnectedClient).toBe(true);
    expect(other.manager.isConnectedClient).toBe(false);
    expect(other.manager.disconnectReason).toBe(
      'This game is version "build-a1" on the server and "build-b2" here. Both must run the same build: reload the page, or update, and join again.',
    );
    expect(unset.manager.disconnectReason).toContain('"build-a1" on the server and "" here');
    expect(host.manager.connectedClientsIds).toEqual([0, 1]);
  });

  // The two prefabs below share a name and differ in contents: what two builds of a game can disagree about.
  class Health extends NetworkBehaviour {
    readonly hp = new NetworkVariable(10);
  }
  class HealthWithArmour extends NetworkBehaviour {
    readonly hp = new NetworkVariable(10);
    readonly armour = new NetworkVariable(0);
  }
  const onHost = new NetworkPrefab('Soldier', (go) => {
    go.addComponent(HealthWithArmour);
  });
  const onClient = new NetworkPrefab('Soldier', (go) => {
    go.addComponent(Health);
  });
  const mismatch =
    'NetworkPrefab "Soldier" is not the same here as on the server: its NetworkBehaviours have different variables or RPCs ' +
    '(server: armour,hp|; here: hp|). The two machines are running different builds; reload both.';

  function mismatched() {
    const network = new BaseTestNetwork((manager) => (manager.networkConfig.playerPrefab = PlayerPrefab));
    net = network;
    const host = network.host('host', { configure: (manager) => manager.networkPrefabs.add(onHost).add(CratePrefab) });
    const join = () =>
      network.client('guest', 'host', {
        configure: (manager) => manager.networkPrefabs.add(onClient).add(CratePrefab),
      });
    return { network, host, join };
  }

  test("a prefab with different variables on the client ends that client's connection, and says why", () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { network, host, join } = mismatched();
      const guest = join();
      network.pump();
      expect(guest.manager.isConnectedClient).toBe(true); // the names match, so it was admitted

      const soldier = host.make(onHost);
      host.run(() => soldier.spawn());
      network.pump();

      // It does not carry on with the wrong variables, or without the object: it leaves.
      expect(guest.manager.isListening).toBe(false);
      expect(guest.manager.disconnectReason).toBe(mismatch);
      expect(guest.run(() => GameObject.find('Soldier'))).toBeNull();
      expect(host.manager.connectedClientsIds).toEqual([0]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  test('the same disagreement found while joining refuses the join outright, not halfway', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { network, host, join } = mismatched();
      const soldier = host.make(onHost);
      const crate = host.make(CratePrefab);
      host.run(() => {
        soldier.spawn();
        crate.spawn();
      });
      const guest = join();
      let connected = false;
      guest.manager.onClientConnectedCallback.add(() => (connected = true));
      network.pump();

      expect(connected).toBe(false);
      expect(guest.manager.isConnectedClient).toBe(false);
      expect(guest.manager.disconnectReason).toBe(mismatch);
      expect(guest.manager.spawnManager.spawnedObjects.size).toBe(0);
      expect(host.manager.connectedClientsIds).toEqual([0]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('scene loads that are interrupted', () => {
  test('a load abandoned by a shutdown does not finish into the next session', async () => {
    net = new TestNetwork();
    const host = net.host();
    const events: string[] = [];
    host.manager.sceneManager.onLoadComplete.add((id, scene) => events.push(`loaded ${scene} on ${id}`));
    host.manager.sceneManager.onLoadEventCompleted.add((scene) => events.push(`ready ${scene}`));

    const first = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    host.run(() => host.manager.shutdown());
    host.run(() => host.manager.startHost(net.hub.connect('host-again')));
    const second = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    expect(slowLoads.length).toBe(1); // the engine loads one scene at a time: the second waits behind the first

    slowLoads[0]?.(); // the abandoned load finishes
    await first;
    expect(events).toEqual([]); // and says nothing to the new session
    expect(host.manager.sceneManager.isLoading).toBe(true);
    expect(() => host.run(() => host.manager.sceneManager.loadScene('Match'))).toThrow(
      'is still loading on the server',
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    slowLoads[1]?.();
    await second;
    expect(events).toEqual(['loaded SlowMatch on 0', 'ready SlowMatch']);
    expect(host.manager.sceneManager.isLoading).toBe(false);
  });

  test('a client that leaves mid-load and joins again ends up in step with the host', async () => {
    const network = new TestNetwork();
    net = network;
    const host = network.host();
    const guest = network.client('guest');
    network.pump();
    const crate = host.make(CratePrefab);
    host.run(() => crate.spawn());
    network.pump();
    const order: string[] = [];
    host.manager.sceneManager.onSynchronizeComplete.add((id) => order.push(`host: client ${id} synchronized`));
    guest.manager.onClientConnectedCallback.add((id) => order.push(`guest: connected as ${id}`));

    const loading = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    network.pump(); // the guest is now loading too
    slowLoads[0]?.();
    await loading;
    guest.run(() => guest.manager.shutdown());
    guest.run(() => guest.manager.startClient(network.hub.connect('guest-again'), 'host'));
    network.pump();
    for (const release of slowLoads) release(); // the guest's first load ends: it belongs to the session it left
    await network.settle();
    for (const release of slowLoads) release(); // and then the load its second join asked for
    await network.settle();

    // Joined once, in the right order, and changes made since reach it.
    expect(order).toEqual(['guest: connected as 2', 'host: client 2 synchronized']);
    host.run(() => (host.unit(crate.networkObjectId).hp.value = 55));
    network.pump();
    expect(guest.unit(crate.networkObjectId).hp.value).toBe(55);
  });

  test('a second load is refused while clients are still answering the first, which then completes', async () => {
    const { host } = threeMachines();
    const finished: string[] = [];
    host.manager.sceneManager.onLoadEventCompleted.add((scene) => finished.push(scene));

    const loading = host.run(() => host.manager.sceneManager.loadScene('SlowMatch'));
    net.pump();
    slowLoads[0]?.();
    await loading; // the host has it; alice and bob do not yet
    expect(() => host.run(() => host.manager.sceneManager.loadScene('Match'))).toThrow(
      '"SlowMatch" is still loading on clients 1, 2. Wait for sceneManager.onLoadEventCompleted before loading "Match".',
    );
    for (const release of slowLoads) release();
    await net.settle();
    expect(finished).toEqual(['SlowMatch']);
    await host.run(() => host.manager.sceneManager.loadScene('Match')); // and now it may
    await net.settle();
    expect(finished).toEqual(['SlowMatch', 'Match']);
  });

  test('a client saying "loaded" more than once counts once', async () => {
    const { host, alice } = threeMachines();
    const completed: number[] = [];
    const synchronized: number[] = [];
    host.manager.sceneManager.onLoadComplete.add((id) => completed.push(id));
    host.manager.sceneManager.onSynchronizeComplete.add((id) => synchronized.push(id));
    await host.run(() => host.manager.sceneManager.loadScene('Match'));
    await net.settle();
    expect(completed.sort()).toEqual([0, 1, 2]);

    for (let i = 0; i < 3; i++) alice.transport.send('host', { t: 'sceneLoaded', e: 1 });
    net.pump();
    expect(completed.length).toBe(3);
    expect(synchronized).toEqual([]);
  });

  test('a client whose copy of the scene fails to build is not left waiting for ever', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const network = new TestNetwork();
      net = network;
      const host = network.host();
      // This machine logs script errors and carries on, as a browser does.
      const guest = network.client('guest', 'host', { throwOnError: false });
      network.pump();
      brokenOn = guest.engine;
      const finished: [number[], number[]][] = [];
      host.manager.sceneManager.onLoadEventCompleted.add((_scene, loaded, late) => finished.push([loaded, late]));

      await host.run(() => host.manager.sceneManager.loadScene('BrokenForOne'));
      const crate = host.make(CratePrefab);
      host.run(() => crate.spawn(true));
      await network.settle();

      expect(errors).toHaveBeenCalled();
      // It reported in, so the host is not held up, and it is handling messages again.
      expect(guest.manager.sceneManager.isLoading).toBe(false);
      expect(finished).toEqual([[[0, 1], []]]);
      expect(guest.has(crate.networkObjectId)).toBe(true);
    } finally {
      errors.mockRestore();
      brokenOn = null;
    }
  });
});
