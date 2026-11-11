import { afterEach, describe, expect, test } from 'bun:test';
import { Quaternion, Vector3 } from '@synergy/engine';
import { NetworkTransform } from '../src';
import { MoverPrefab, OwnerMoverPrefab, TestNetwork } from './harness';

let net: TestNetwork;
afterEach(() => net?.dispose());

function setup() {
  net = new TestNetwork();
  const host = net.host();
  const alice = net.client('alice');
  const bob = net.client('bob');
  net.pump();
  return { host, alice, bob };
}

const xOf = (machine: { object(id: number): { transform: { position: Vector3 } } }, id: number) =>
  machine.object(id).transform.position.x;

describe('NetworkTransform', () => {
  test('when the server moves an object, clients follow it smoothly rather than jumping', () => {
    const { host, alice, bob } = setup();
    const mover = host.make(MoverPrefab);
    mover.spawn();
    net.pump();
    const id = mover.networkObjectId;

    // Frames come four times as often as network ticks (120 fps against 30 updates a second).
    mover.transform.position = new Vector3(10, 0, 0);
    const path: number[] = [];
    for (let i = 0; i < 40; i++) {
      net.pump(1, 1 / 120);
      path.push(xOf(alice, id));
    }
    // It starts moving, never goes backwards, passes through in-between positions, and arrives.
    expect(path.some((x) => x > 0 && x < 10)).toBe(true);
    expect([...path].sort((a, b) => a - b)).toEqual(path);
    expect(path.at(-1)).toBeCloseTo(10, 5);
    expect(xOf(bob, id)).toBeCloseTo(10, 5);
  });

  test('movement below the threshold is not sent, and rotation and scale follow when enabled', () => {
    const { host, alice } = setup();
    const mover = host.make(MoverPrefab);
    const sync = mover.getComponent(NetworkTransform) as NetworkTransform;
    sync.syncScale = true;
    mover.spawn();
    net.pump();
    const id = mover.networkObjectId;
    const aliceSync = alice.object(id).getComponent(NetworkTransform) as NetworkTransform;
    aliceSync.syncScale = true;
    const updates: unknown[] = [];
    alice.transport.onMessage.add((_from, message) => {
      const sync = message as { t: string; u?: unknown[] };
      if (sync.t === 'sync') updates.push(...(sync.u ?? []));
    });

    mover.transform.position = new Vector3(0.0001, 0, 0);
    net.pump();
    expect(updates).toEqual([]);

    mover.transform.rotation = Quaternion.angleAxis(90, Vector3.up);
    mover.transform.localScale = new Vector3(3, 3, 3);
    net.pump(12);
    expect(alice.object(id).transform.rotation.equals(Quaternion.angleAxis(90, Vector3.up), 1e-4)).toBe(true);
    expect(alice.object(id).transform.localScale.x).toBeCloseTo(3, 4);
  });

  test('a client with authority moves its own object and the server and others follow', () => {
    const { host, alice, bob } = setup();
    const mover = host.make(OwnerMoverPrefab);
    mover.spawnWithOwnership(1);
    net.pump();
    const id = mover.networkObjectId;
    const aliceSync = alice.object(id).getComponent(NetworkTransform) as NetworkTransform;
    const bobSync = bob.object(id).getComponent(NetworkTransform) as NetworkTransform;
    expect([
      aliceSync.hasAuthority,
      bobSync.hasAuthority,
      (mover.getComponent(NetworkTransform) as NetworkTransform).hasAuthority,
    ]).toEqual([true, false, false]);

    alice.object(id).transform.position = new Vector3(4, 0, 2);
    net.pump(12);
    // The owner is never pulled back by its own update.
    expect(alice.object(id).transform.position.equals(new Vector3(4, 0, 2))).toBe(true);
    expect(host.object(id).transform.position.equals(new Vector3(4, 0, 2), 1e-4)).toBe(true);
    expect(bob.object(id).transform.position.equals(new Vector3(4, 0, 2), 1e-4)).toBe(true);
    expect(() => bobSync.teleport(Vector3.zero)).toThrow(/authority/);
  });

  test('teleport skips the blend', () => {
    const { host, alice } = setup();
    const mover = host.make(MoverPrefab);
    mover.spawn();
    net.pump();
    const id = mover.networkObjectId;
    (mover.getComponent(NetworkTransform) as NetworkTransform).teleport(new Vector3(50, 0, 0));
    net.pump(2);
    expect(xOf(alice, id)).toBe(50);
  });

  test('a late joiner finds the object where it is now', () => {
    const { host } = setup();
    const mover = host.make(MoverPrefab);
    mover.spawn();
    net.pump();
    mover.transform.position = new Vector3(7, 0, 0);
    net.pump(10);
    const late = net.client('late');
    net.pump();
    expect(xOf(late, mover.networkObjectId)).toBeCloseTo(7, 5);
  });
});
