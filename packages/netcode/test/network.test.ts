import { afterEach, describe, expect, test } from 'bun:test';
import { Time } from '@synergy/engine';
import { CratePrefab, TestNetwork } from './harness';

let net: TestNetwork;
afterEach(() => net?.dispose());

describe('custom messages', () => {
  test('clients message the server, and the server messages one client or all', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    const bob = net.client('bob');
    net.pump();
    const heard: string[] = [];
    host.manager.customMessagingManager.registerNamedMessageHandler('chat', (sender, data) =>
      heard.push(`host got ${JSON.stringify(data)} from ${sender}`),
    );
    for (const machine of [alice, bob]) {
      machine.manager.customMessagingManager.registerNamedMessageHandler('news', (sender, data) =>
        heard.push(`${machine.id} got ${JSON.stringify(data)} from ${sender}`),
      );
    }

    alice.manager.customMessagingManager.sendNamedMessage('chat', 0, { text: 'hi' });
    host.manager.customMessagingManager.sendNamedMessage('news', 2, 'just bob');
    host.manager.customMessagingManager.sendNamedMessageToAll('news', 'everyone');
    net.pump();
    expect(heard.sort()).toEqual([
      'alice got "everyone" from 0',
      'bob got "everyone" from 0',
      'bob got "just bob" from 0',
      'host got {"text":"hi"} from 1',
    ]);

    expect(() => alice.manager.customMessagingManager.sendNamedMessage('chat', 2, 1)).toThrow(
      /only send messages to the server/,
    );
    expect(() => host.manager.customMessagingManager.sendNamedMessage('news', 9, 1)).toThrow(/not connected/);
  });

  test("the arguments in the old (name, data, clientId) order are refused with NGO's order", () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    const messages = alice.manager.customMessagingManager;
    const order = /\(name, clientId, data\).*sendNamedMessage\('chat', NetworkManager\.serverClientId, data\)/;
    // @ts-expect-error the data where the client id goes: the mistake this test is about
    expect(() => messages.sendNamedMessage('chat', { text: 'hi' })).toThrow(order);
    // @ts-expect-error the data where the client id goes, and no data: the mistake this test is about
    expect(() => messages.sendNamedMessage('chat', 'hello')).toThrow(order);
    // @ts-expect-error no data at all: NGO's writer is required
    expect(() => messages.sendNamedMessage('chat', 0)).toThrow(/no data/);
    // A number where the client id goes is a client id; one the client may not send to is refused.
    expect(() => messages.sendNamedMessage('chat', 1, 5)).toThrow(order);
    expect(() => host.manager.customMessagingManager.sendNamedMessage('chat', 7, 'hi')).toThrow(order);
    // A list of client ids, as NGO's IReadOnlyList<ulong> overload takes.
    const heard: unknown[] = [];
    messages.registerNamedMessageHandler('news', (_sender, data) => heard.push(data));
    host.manager.customMessagingManager.sendNamedMessage('news', [1], 'listed');
    net.pump();
    expect(heard).toEqual(['listed']);
  });

  test('a handler can be removed', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    const heard: unknown[] = [];
    const off = host.manager.customMessagingManager.registerNamedMessageHandler('chat', (_sender, data) =>
      heard.push(data),
    );
    alice.manager.customMessagingManager.sendNamedMessage('chat', 0, 1);
    net.pump();
    off();
    alice.manager.customMessagingManager.sendNamedMessage('chat', 0, 2);
    net.pump();
    expect(heard).toEqual([1]);
  });
});

describe('the network clock', () => {
  test('ticks happen at the tick rate, whatever the frame rate', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (m) => (m.networkConfig.tickRate = 20) });
    const ticks: number[] = [];
    host.manager.onTick.add((tick) => ticks.push(tick));
    for (let i = 0; i < 60; i++) host.step(1, 1 / 60); // one second at 60 fps
    expect(ticks.length).toBe(20);
    expect(host.manager.localTime.tick).toBe(20);
    expect(host.manager.localTime.time).toBe(1);
  });

  test('a frame that spans several ticks reports each of them, in order', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (m) => (m.networkConfig.tickRate = 20) });
    const ticks: number[] = [];
    host.manager.onTick.add((tick) => ticks.push(tick));
    host.step(1, 0.25); // one slow frame: five ticks' worth
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
    expect(host.manager.localTime.tick).toBe(5);
    // A listener that stops the network ends the run of ticks there.
    host.manager.onTick.add((tick) => {
      if (tick === 7) host.manager.shutdown();
    });
    host.step(1, 0.25);
    expect(ticks).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('clients take the server tick rate and keep a close estimate of its time', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (m) => (m.networkConfig.tickRate = 20) });
    const alice = net.client('alice', 'host', { configure: (m) => (m.networkConfig.tickRate = 60) });
    net.pump(60, 1 / 20);
    expect(alice.manager.networkConfig.tickRate).toBe(20);
    expect(host.manager.serverTime.tick).toBe(host.manager.localTime.tick);
    expect(Math.abs(alice.manager.serverTime.tick - host.manager.serverTime.tick)).toBeLessThanOrEqual(2);
  });

  test('network time does not stop when the game is paused with timeScale', () => {
    net = new TestNetwork();
    const host = net.host();
    host.run(() => {
      Time.timeScale = 0;
    });
    host.step(30);
    expect(host.manager.localTime.tick).toBe(30);
  });

  test('a dedicated server sends variable changes like a host does', () => {
    net = new TestNetwork();
    const server = net.server();
    const alice = net.client('alice', 'server');
    net.pump();
    const crate = server.make(CratePrefab);
    crate.spawn();
    net.pump();
    server.unit(crate.networkObjectId).hp.value = 3;
    net.pump();
    expect(alice.unit(crate.networkObjectId).hp.value).toBe(3);
  });
});
