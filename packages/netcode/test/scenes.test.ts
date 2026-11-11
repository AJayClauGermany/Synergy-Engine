import { afterEach, describe, expect, test } from 'bun:test';
import { GameObject, SceneManager } from '@synergy/engine';
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
    host.manager.sceneManager.onLoadEventCompleted.add((scene, loaded, timedOut) => finished.push([scene, loaded, timedOut]));
    const heardByAlice: string[] = [];
    alice.manager.sceneManager.onLoadComplete.add((clientId, scene) => heardByAlice.push(`loaded ${scene} as ${clientId}`));
    alice.manager.sceneManager.onLoadEventCompleted.add((scene, loaded) => heardByAlice.push(`${scene} ready for ${loaded.join(',')}`));

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
        order.push(`${this.isServer ? 'host' : 'client'} flag, arena ${GameObject.find('Arena') ? 'present' : 'missing'}`);
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
    expect(order.filter((line) => line.startsWith('client'))).toEqual(['client flag, arena present', 'client flag, arena present']);
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
    expect(() => alice.run(() => alice.manager.sceneManager.loadScene('Match'))).toThrow('Only the server can load a scene for everyone');
    expect(() => host.run(() => host.manager.sceneManager.loadScene('Nowhere'))).toThrow('Scene "Nowhere" is not registered');
    expect(host.manager.sceneManager.sceneName).toBeNull();
  });
});

describe('builds that do not match', () => {
  test('a client on another version of the game is refused, and told both versions', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (manager) => (manager.networkConfig.protocolVersion = 'build-a1') });
    const same = net.client('same', 'host', { configure: (manager) => (manager.networkConfig.protocolVersion = 'build-a1') });
    const other = net.client('other', 'host', { configure: (manager) => (manager.networkConfig.protocolVersion = 'build-b2') });
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

  test('a prefab with different variables on the client is not created, and says why', () => {
    class Health extends NetworkBehaviour {
      readonly hp = new NetworkVariable(10);
    }
    class HealthWithArmour extends NetworkBehaviour {
      readonly hp = new NetworkVariable(10);
      readonly armour = new NetworkVariable(0);
    }
    // Same name, different contents: what two builds of a game can disagree about.
    const onHost = new NetworkPrefab('Soldier', (go) => {
      go.addComponent(HealthWithArmour);
    });
    const onClient = new NetworkPrefab('Soldier', (go) => {
      go.addComponent(Health);
    });
    net = new BaseTestNetwork((manager) => (manager.networkConfig.playerPrefab = PlayerPrefab));
    const host = net.host('host', { configure: (manager) => manager.networkPrefabs.add(onHost) });
    const guest = net.client('guest', 'host', { configure: (manager) => manager.networkPrefabs.add(onClient) });
    net.pump();
    expect(guest.manager.isConnectedClient).toBe(true); // the names match, so it was admitted

    const soldier = host.make(onHost);
    host.run(() => soldier.spawn());
    expect(() => net.pump()).toThrow(
      'NetworkPrefab "Soldier" is not the same here as on the server: its NetworkBehaviours have different variables or RPCs ' +
        '(server: armour,hp|; here: hp|). The two machines are running different builds; reload both. The object was not created.',
    );
    expect(guest.has(soldier.networkObjectId)).toBe(false);
    expect(guest.run(() => GameObject.find('Soldier'))).toBeNull();
  });
});
