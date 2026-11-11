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

describe('visibility (hidden information)', () => {
  test('an object can be kept from some clients when it spawns, and from late joiners', () => {
    const { host, alice, bob } = setup();
    const secret = host.make(CratePrefab);
    secret.checkObjectVisibility = (clientId) => clientId === 1;
    secret.spawn();
    net.pump();
    const id = secret.networkObjectId;
    expect(host.has(id)).toBe(true);
    expect(alice.has(id)).toBe(true);
    expect(bob.has(id)).toBe(false);

    const late = net.client('late');
    net.pump();
    expect(late.has(id)).toBe(false);
    expect(secret.isNetworkVisibleTo(1)).toBe(true);
    expect(secret.isNetworkVisibleTo(2)).toBe(false);
    expect(secret.isNetworkVisibleTo(0)).toBe(true);
  });

  test('showing sends the current state; hiding removes the copy; nothing is sent meanwhile', () => {
    const { host, alice, bob } = setup();
    const crate = host.make(CratePrefab);
    crate.spawn();
    net.pump();
    const id = crate.networkObjectId;
    const copy = bob.object(id);

    crate.networkHide(2);
    net.pump();
    expect(bob.has(id)).toBe(false);
    expect(isAlive(copy)).toBe(false);
    expect(alice.has(id)).toBe(true);

    // While hidden, bob hears nothing about it.
    const received: string[] = [];
    bob.transport.onMessage.add((_from, message) => received.push((message as { t: string }).t));
    host.unit(id).hp.value = 10;
    host.unit(id).tags.add('moved');
    host.unit(id).shoutRpc('quiet');
    net.pump();
    expect(received.filter((type) => type !== 'sync')).toEqual([]);
    expect(alice.unit(id).hp.value).toBe(10);

    crate.networkShow(2);
    net.pump();
    expect(bob.has(id)).toBe(true);
    expect(bob.unit(id).hp.value).toBe(10);
    expect(bob.unit(id).tags.toArray()).toEqual(['moved']);
    host.unit(id).hp.value = 11;
    net.pump();
    expect(bob.unit(id).hp.value).toBe(11);
  });

  test('a client cannot call an RPC on an object it cannot see', () => {
    const { host, bob } = setup();
    const crate = host.make(CratePrefab);
    crate.checkObjectVisibility = (clientId) => clientId !== 2;
    crate.spawn();
    net.pump();
    bob.transport.send('host', { t: 'rpc', o: crate.networkObjectId, b: 0, n: 'openRpc', a: ['sneaky'] });
    net.pump();
    expect(host.unit(crate.networkObjectId).seen.filter((line) => line.startsWith('open'))).toEqual([]);
  });

  test('updateVisibility applies the rule again after it changes', () => {
    const { host, alice, bob } = setup();
    let revealed = false;
    const crate = host.make(CratePrefab);
    crate.checkObjectVisibility = () => revealed;
    crate.spawn();
    net.pump();
    const id = crate.networkObjectId;
    expect([alice.has(id), bob.has(id)]).toEqual([false, false]);

    revealed = true;
    crate.updateVisibility();
    net.pump();
    expect([alice.has(id), bob.has(id)]).toEqual([true, true]);

    revealed = false;
    crate.updateVisibility();
    net.pump();
    expect([alice.has(id), bob.has(id)]).toEqual([false, false]);
    expect(() => crate.networkHide(0)).toThrow(/server/);
  });
});
