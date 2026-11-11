import { afterEach, describe, expect, test } from 'bun:test';
import { Debug, destroy, GameObject, instantiate, isAlive, Quaternion, Vector3 } from '@synergy/engine';
import { NetworkBehaviour, NetworkObject, NetworkPrefab } from '../src';
import { Announcer, AnnouncerPrefab, CarPrefab, CratePrefab, NestedPrefab, TestNetwork, Unit, Wheel } from './harness';

let net: TestNetwork;
afterEach(() => net.dispose());

function connected() {
  net = new TestNetwork();
  const host = net.host();
  const alice = net.client('alice');
  const bob = net.client('bob');
  net.pump();
  return { host, alice, bob };
}

describe('developer feedback', () => {
  test("Unity's spelling of a network message is refused, like the engine's own messages", () => {
    class Shouter extends NetworkBehaviour {
      // @ts-expect-error The type-checker refuses it too.
      OnNetworkSpawn() {}
    }
    net = new TestNetwork();
    const host = net.host();
    expect(() => host.run(() => new GameObject('S').addComponent(Shouter))).toThrow(
      'Shouter.OnNetworkSpawn() will never be called: message names are camelCase here. Rename it to onNetworkSpawn().',
    );
  });

  test('Debug.hierarchy shows the values of network variables', () => {
    net = new TestNetwork();
    const host = net.host();
    const crate = host.make(CratePrefab);
    host.run(() => {
      crate.spawn();
      (crate.getComponent(Unit) as Unit).hp.value = 75;
    });
    const text = host.run(() => Debug.hierarchy({ root: crate.gameObject }));
    expect(text).toContain('Crate <NetworkObject, Unit>');
    expect(text).toContain('| NetworkObject: id 2, owned by the server, visible to clients []');
    expect(text).toContain('hp=NetworkVariable(75)');
    expect(text).toContain('tags=NetworkList(0 items)');
  });
});

describe('spawning', () => {
  test('a spawned object appears on every machine with its transform, owner and variables', () => {
    const { host, alice, bob } = connected();
    const crate = host.make(CratePrefab, new Vector3(1, 2, 3));
    crate.transform.rotation = Quaternion.angleAxis(90, Vector3.up);
    crate.transform.localScale = new Vector3(2, 2, 2);
    const unit = crate.getComponent(Unit) as Unit;
    unit.hp.value = 42;
    unit.tags.add('heavy');
    crate.spawnWithOwnership(2);
    net.pump();

    const id = crate.networkObjectId;
    expect(id).toBeGreaterThan(0);
    for (const machine of [host, alice, bob]) {
      const copy = machine.object(id);
      expect(copy.prefabName).toBe('Crate');
      expect(copy.transform.position.equals(new Vector3(1, 2, 3))).toBe(true);
      expect(copy.transform.rotation.equals(Quaternion.angleAxis(90, Vector3.up))).toBe(true);
      expect(copy.transform.localScale.equals(new Vector3(2, 2, 2))).toBe(true);
      expect(copy.ownerClientId).toBe(2);
      expect(copy.getComponent(Unit)?.hp.value).toBe(42);
      expect(copy.getComponent(Unit)?.tags.toArray()).toEqual(['heavy']);
    }
    expect(bob.object(id).isOwner).toBe(true);
    expect(alice.object(id).isOwner).toBe(false);
    // Clients see initial values in onNetworkSpawn; no change event is raised for them.
    expect(alice.unit(id).seen).toEqual(['spawn hp=42 owner=2']);
  });

  test('what the server sets inside onNetworkSpawn is part of what clients receive', () => {
    const { host, alice } = connected();
    const crate = host.make(CratePrefab);
    const unit = crate.getComponent(Unit) as Unit;
    const original = Unit.prototype.onNetworkSpawn;
    Unit.prototype.onNetworkSpawn = function (this: Unit) {
      original.call(this);
      if (this.isServer) this.hp.value = 7;
    };
    try {
      crate.spawn();
      net.pump();
    } finally {
      Unit.prototype.onNetworkSpawn = original;
    }
    expect(unit.hp.value).toBe(7);
    expect(alice.unit(crate.networkObjectId).hp.value).toBe(7);
    expect(alice.unit(crate.networkObjectId).seen[0]).toBe('spawn hp=7 owner=0');
  });

  test('despawn removes the object everywhere; destroying the server copy does the same', () => {
    const { host, alice, bob } = connected();
    const a = host.make(CratePrefab);
    const b = host.make(CratePrefab);
    a.spawn();
    b.spawn();
    net.pump();
    const [idA, idB] = [a.networkObjectId, b.networkObjectId];
    const aliceCopy = alice.object(idA);

    a.despawn();
    host.run(() => destroy(b.gameObject));
    net.pump();

    for (const machine of [host, alice, bob]) {
      expect(machine.has(idA)).toBe(false);
      expect(machine.has(idB)).toBe(false);
    }
    expect(isAlive(aliceCopy)).toBe(false);
    expect(a.isSpawned).toBe(false);
  });

  test('despawn(false) keeps the server copy as an ordinary object', () => {
    const { host, alice } = connected();
    const crate = host.make(CratePrefab);
    crate.spawn();
    net.pump();
    crate.despawn(false);
    net.pump();
    expect(isAlive(crate)).toBe(true);
    expect(alice.has(crate.networkObjectId)).toBe(false);
    expect(crate.getComponent(Unit)?.seen).toContain('despawn');
  });

  test('a client that joins later is given everything already spawned, in order', () => {
    net = new TestNetwork();
    const host = net.host();
    const crates = [host.make(CratePrefab), host.make(CratePrefab)];
    crates.forEach((crate, i) => {
      crate.getComponent(Unit)?.tags.add(`t${i}`);
      crate.spawn();
    });
    net.pump();
    const late = net.client('late');
    net.pump();
    expect([...late.manager.spawnManager.spawnedObjects.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(late.unit(crates[1]?.networkObjectId as number).tags.toArray()).toEqual(['t1']);
    expect(late.player(1).isLocalPlayer).toBe(true);
  });

  test('refuses what cannot work, with a message that says what to do', () => {
    const { host, alice } = connected();
    const crate = host.make(CratePrefab);
    expect(() => alice.make(CratePrefab).spawn()).toThrow(/Only the server can spawn/);
    crate.spawn();
    expect(() => crate.spawn()).toThrow(/already spawned/);
    expect(() => host.make(CratePrefab).spawnWithOwnership(99)).toThrow(/not connected/);

    const unregistered = host.run(
      () => instantiate(new NetworkPrefab('Ghost')).getComponent(NetworkObject) as NetworkObject,
    );
    expect(() => unregistered.spawn()).toThrow(/not registered/);

    const plain = host.run(() => new GameObject('Plain').addComponent(NetworkObject));
    expect(() => plain.spawn()).toThrow(/not made from a NetworkPrefab/);

    const sameName = new NetworkPrefab('Crate');
    expect(() => host.manager.networkPrefabs.add(sameName)).toThrow(/unique/);
    expect(() => host.manager.spawnManager.getLocalPlayerObject()?.spawnAsPlayerObject(0)).toThrow();
  });

  test('NetworkBehaviours on children belong to the object', () => {
    const { host, alice } = connected();
    const car = host.make(CarPrefab);
    car.spawn();
    net.pump();
    const copy = alice.object(car.networkObjectId);
    const behaviours = copy._collectBehaviours();
    expect(behaviours.map((b) => b.constructor.name)).toEqual(['Unit', 'Wheel']);
    expect(behaviours.map((b) => b.networkBehaviourId)).toEqual([0, 1]);

    const wheel = car.getComponentInChildren(Wheel) as Wheel;
    wheel.spin.value = 5;
    net.pump();
    expect(alice.object(car.networkObjectId).getComponentInChildren(Wheel)?.spin.value).toBe(5);
  });

  test('a NetworkObject nested inside another is refused before anything is claimed', () => {
    const { host } = connected();
    const nested = host.make(NestedPrefab);
    expect(() => nested.spawn()).toThrow(/Nested NetworkObjects are not supported/);
    expect(nested.isSpawned).toBe(false);
    expect(nested.networkObjectId).toBe(0);
    const next = host.make(CratePrefab);
    next.spawn();
    expect(next.networkObjectId).toBe(4); // ids 1-3 are the three players; none was used up
  });

  test('an RPC called from onNetworkSpawn reaches clients after they have the object', () => {
    const { host, alice } = connected();
    const announcer = host.make(AnnouncerPrefab);
    announcer.spawn();
    net.pump();
    const heard = (machine: typeof host) => machine.object(announcer.networkObjectId).getComponent(Announcer)?.seen;
    expect(heard(host)).toEqual(['from onNetworkSpawn']);
    expect(heard(alice)).toEqual(['from onNetworkSpawn']);
  });

  test('shutting down destroys every spawned object on that machine', () => {
    const { host, alice } = connected();
    const crate = host.make(CratePrefab);
    crate.spawn();
    net.pump();
    const copy = alice.object(crate.networkObjectId);
    alice.manager.shutdown();
    alice.step();
    expect(alice.manager.spawnManager.spawnedObjects.size).toBe(0);
    expect(isAlive(copy)).toBe(false);
    expect(copy.getComponent(Unit)?.seen).toContain('despawn');
    net.pump();
    expect(host.manager.connectedClientsIds).toEqual([0, 2]);
  });
});
