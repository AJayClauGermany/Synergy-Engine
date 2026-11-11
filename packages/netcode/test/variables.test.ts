import { afterEach, describe, expect, test } from 'bun:test';
import { Vector3 } from '@synergy/engine';
import { NetworkList, type NetworkListEvent, NetworkVariable } from '../src';
import { CratePrefab, TestNetwork } from './harness';

let net: TestNetwork;
afterEach(() => net.dispose());

function setup() {
  net = new TestNetwork();
  const host = net.host();
  const alice = net.client('alice');
  const bob = net.client('bob');
  net.pump();
  const crate = host.make(CratePrefab);
  crate.spawn();
  net.pump();
  const id = crate.networkObjectId;
  return { host, alice, bob, id };
}

describe('NetworkVariable', () => {
  test('the server changes a value and every client sees it, with a change event', () => {
    const { host, alice, bob, id } = setup();
    const changes: string[] = [];
    alice.unit(id).hp.onValueChanged.add((previous, current) => changes.push(`${previous}->${current}`));
    host.unit(id).hp.onValueChanged.add((previous, current) => changes.push(`host ${previous}->${current}`));

    host.unit(id).hp.value = 60;
    expect(alice.unit(id).hp.value).toBe(100); // nothing travels until the tick
    net.pump();
    expect(alice.unit(id).hp.value).toBe(60);
    expect(bob.unit(id).hp.value).toBe(60);
    expect(changes).toEqual(['host 100->60', '100->60']);
  });

  test('several changes in one tick arrive as the last value, and an unchanged value sends nothing', () => {
    const { host, alice, id } = setup();
    const changes: number[] = [];
    alice.unit(id).hp.onValueChanged.add((_previous, current) => changes.push(current));
    host.unit(id).hp.value = 1;
    host.unit(id).hp.value = 2;
    host.unit(id).hp.value = 3;
    net.pump();
    host.unit(id).hp.value = 3;
    expect(host.unit(id).hp.isDirty).toBe(false);
    net.pump();
    expect(changes).toEqual([3]);
  });

  test('a late joiner receives the current value without a change event', () => {
    const { host, id } = setup();
    host.unit(id).hp.value = 12;
    net.pump();
    const late = net.client('late');
    net.pump();
    expect(late.unit(id).hp.value).toBe(12);
    expect(late.unit(id).seen[0]).toBe('spawn hp=12 owner=0');
  });

  test('only the server may write a server-written variable', () => {
    const { alice, id } = setup();
    expect(() => {
      alice.unit(id).hp.value = 1;
    }).toThrow(/cannot write to NetworkVariable "hp"/);
    expect(alice.unit(id).hp.value).toBe(100);
  });

  test('an owner-written variable goes owner, to server, to everyone else, and is not echoed back', () => {
    const { host, alice, bob, id } = setup();
    host.object(id).changeOwnership(1);
    net.pump();
    const noteUpdatesTo = (machine: typeof host) => {
      const seen: unknown[] = [];
      machine.transport.onMessage.add((_from, message) => {
        const sync = message as { t: string; u?: unknown[][] };
        if (sync.t === 'sync') seen.push(...(sync.u ?? []).filter((update) => update[2] === 'note'));
      });
      return seen;
    };
    const toAlice = noteUpdatesTo(alice);
    const toBob = noteUpdatesTo(bob);
    const bobChanges: string[] = [];
    bob.unit(id).note.onValueChanged.add((_p, current) => bobChanges.push(current));

    alice.unit(id).note.value = 'hello';
    expect(() => {
      bob.unit(id).note.value = 'mine';
    }).toThrow(/cannot write/);
    net.pump();

    expect(host.unit(id).note.value).toBe('hello');
    expect(bob.unit(id).note.value).toBe('hello');
    expect(bobChanges).toEqual(['hello']);
    expect(toBob.length).toBe(1);
    expect(toAlice).toEqual([]); // the writer already has it; the server does not send it back
  });

  test('a client cannot write a variable it does not own by sending the message itself', () => {
    const { host, alice, id } = setup();
    // Alice does not own the crate; forge the update a modified client would send.
    alice.transport.send('host', { t: 'vars', u: [[id, 0, 'note', 'forged']] });
    alice.transport.send('host', { t: 'vars', u: [[id, 0, 'hp', 1]] });
    net.pump();
    expect(host.unit(id).note.value).toBe('');
    expect(host.unit(id).hp.value).toBe(100);
  });

  test('an owner-read variable reaches the owner and the server but not other clients', () => {
    const { host, alice, bob, id } = setup();
    host.object(id).changeOwnership(1);
    net.pump();
    host.unit(id).secret.value = 99;
    net.pump();
    expect(alice.unit(id).secret.value).toBe(99);
    expect(bob.unit(id).secret.value).toBe(0);

    // Ownership passes on: the new owner receives the current value.
    host.object(id).changeOwnership(2);
    net.pump();
    expect(bob.unit(id).secret.value).toBe(99);
    host.unit(id).secret.value = 5;
    net.pump();
    expect(bob.unit(id).secret.value).toBe(5);
    expect(alice.unit(id).secret.value).toBe(99); // stale, and no longer updated
  });

  test('objects and arrays are compared by content, and class values need a serializer', () => {
    const { host, alice, id } = setup();
    const stats = new NetworkVariable({ kills: 0 });
    stats.value = { kills: 0 };
    expect(stats.isDirty).toBe(false);

    host.unit(id).aim.value = new Vector3(1, 2, 3);
    net.pump();
    const aim = alice.unit(id).aim.value;
    expect(aim).toBeInstanceOf(Vector3);
    expect(aim.equals(new Vector3(1, 2, 3))).toBe(true);
  });
});

describe('NetworkList', () => {
  test('changes are sent as operations and arrive in order', () => {
    const { host, alice, id } = setup();
    const events: string[] = [];
    alice
      .unit(id)
      .tags.onListChanged.add((event: NetworkListEvent<string>) =>
        events.push(`${event.type}@${event.index}:${event.value ?? event.previousValue ?? ''}`),
      );
    const tags = host.unit(id).tags;
    tags.add('a');
    tags.add('b');
    tags.insert(1, 'x');
    tags.set(0, 'A');
    expect(tags.remove('b')).toBe(true);
    expect(tags.remove('nope')).toBe(false);
    net.pump();
    expect(alice.unit(id).tags.toArray()).toEqual(['A', 'x']);
    expect(events).toEqual(['add@0:a', 'add@1:b', 'insert@1:x', 'value@0:A', 'remove@2:b']);

    tags.clear();
    net.pump();
    expect(alice.unit(id).tags.count).toBe(0);
  });

  test('a late joiner gets the whole list once, even if changes were still waiting to be sent', () => {
    const { host, id } = setup();
    host.unit(id).tags.add('one');
    host.unit(id).tags.add('two');
    // Join in the same tick the changes are made: the snapshot and the pending operations overlap.
    const late = net.client('late');
    net.pump(1);
    host.unit(id).tags.add('three');
    net.pump();
    expect(late.unit(id).tags.toArray()).toEqual(['one', 'two', 'three']);
    expect(late.unit(id).tags.count).toBe(3);
  });

  test('an owner-written list is relayed by the server to everyone but its writer', () => {
    const { host, alice, bob, id } = setup();
    host.object(id).changeOwnership(1);
    net.pump();
    alice.unit(id).notes.add('x');
    alice.unit(id).notes.add('y');
    net.pump();
    for (const machine of [host, alice, bob]) expect(machine.unit(id).notes.toArray()).toEqual(['x', 'y']);

    alice.unit(id).notes.removeAt(0);
    net.pump();
    for (const machine of [host, alice, bob]) expect(machine.unit(id).notes.toArray()).toEqual(['y']);
    expect(() => bob.unit(id).notes.add('z')).toThrow(/cannot write/);
  });

  test('indexing is checked, and iteration works', () => {
    const list = new NetworkList<number>([1, 2, 3]);
    expect([...list]).toEqual([1, 2, 3]);
    expect(list.contains(2)).toBe(true);
    expect(list.indexOf(9)).toBe(-1);
    expect(() => list.get(5)).toThrow(RangeError);
    expect(() => list.insert(9, 1)).toThrow(RangeError);
    expect(() => list.removeAt(-1)).toThrow(RangeError);
  });
});
