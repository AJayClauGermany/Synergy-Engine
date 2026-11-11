import { afterEach, describe, expect, test } from 'bun:test';
import { isAlive } from '@synergy/engine';
import { CratePrefab, TestNetwork } from './harness';

let net: TestNetwork;
afterEach(() => net.dispose());

function setup() {
  net = new TestNetwork();
  const host = net.host();
  const alice = net.client('alice');
  const bob = net.client('bob');
  net.pump();
  return { host, alice, bob };
}

describe('ownership', () => {
  test('changing owner updates every machine and tells the two players concerned', () => {
    const { host, alice, bob } = setup();
    const crate = host.make(CratePrefab);
    crate.spawnWithOwnership(1);
    net.pump();
    const id = crate.networkObjectId;
    const changes: string[] = [];
    for (const machine of [host, alice, bob]) {
      machine
        .object(id)
        .onOwnershipChanged.add((previous, current) => changes.push(`${machine.id}: ${previous}->${current}`));
    }

    crate.changeOwnership(2);
    net.pump();
    for (const machine of [host, alice, bob]) expect(machine.object(id).ownerClientId).toBe(2);
    expect(bob.object(id).isOwner).toBe(true);
    expect(alice.object(id).isOwner).toBe(false);
    expect(alice.unit(id).seen.at(-1)).toBe('lost');
    expect(bob.unit(id).seen.at(-1)).toBe('gained');
    expect(host.unit(id).seen).not.toContain('gained');
    expect(changes.sort()).toEqual(['alice: 1->2', 'bob: 1->2', 'host: 1->2']);

    crate.removeOwnership();
    net.pump();
    expect(host.object(id).isOwnedByServer).toBe(true);
    expect(alice.object(id).isOwnedByServer).toBe(true);
    expect(host.unit(id).seen.at(-1)).toBe('gained');
  });

  test('only the server can change ownership, and only to a connected client', () => {
    const { host, alice } = setup();
    const crate = host.make(CratePrefab);
    crate.spawn();
    net.pump();
    expect(() => alice.object(crate.networkObjectId).changeOwnership(1)).toThrow(/Only the server/);
    expect(() => crate.changeOwnership(9)).toThrow(/not connected/);
  });

  test('when a client leaves, what it owned is destroyed and what is marked to stay goes to the server', () => {
    const { host, alice, bob } = setup();
    const doomed = host.make(CratePrefab);
    const keeper = host.make(CratePrefab);
    keeper.dontDestroyWithOwner = true;
    doomed.spawnWithOwnership(1);
    keeper.spawnWithOwnership(1);
    net.pump();
    const [doomedId, keeperId] = [doomed.networkObjectId, keeper.networkObjectId];
    const alicePlayer = host.player(1).networkObjectId;
    const left: number[] = [];
    host.manager.onClientDisconnectCallback.add((id) => left.push(id));

    alice.transport.close();
    net.pump();

    expect(left).toEqual([1]);
    for (const machine of [host, bob]) {
      expect(machine.has(alicePlayer)).toBe(false);
      expect(machine.has(doomedId)).toBe(false);
      expect(machine.object(keeperId).ownerClientId).toBe(0);
    }
    expect(isAlive(doomed)).toBe(false);
    expect(host.manager.connectedClientsIds).toEqual([0, 2]);
    // The player ids are not reused, so a returning client is a new one.
    const again = net.client('alice2');
    net.pump();
    expect(again.manager.localClientId).toBe(3);
  });
});

describe('review fixes', () => {
  test('a player object cannot be handed to someone else', () => {
    const { host } = setup();
    expect(() => host.player(1).networkObject.changeOwnership(2)).toThrow(/player object/);
  });

  test('the host refuses a forged list operation instead of corrupting the list', () => {
    const { host, alice } = setup();
    const crate = host.make(CratePrefab);
    crate.spawnWithOwnership(1);
    net.pump();
    const id = crate.networkObjectId;
    alice.transport.send('host', { t: 'vars', u: [[id, 0, 'notes', [{ n: 1e15, k: 'add', v: 'x' }]]] });
    expect(() => net.pump()).toThrow(/invalid NetworkList operation/);
    alice.unit(id).notes.add('real');
    net.pump();
    expect(host.unit(id).notes.toArray()).toEqual(['real']);
  });
});
