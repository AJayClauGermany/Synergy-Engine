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
    host.manager.customMessagingManager.registerNamedMessageHandler('chat', (sender, data) => heard.push(`host got ${JSON.stringify(data)} from ${sender}`));
    for (const machine of [alice, bob]) {
      machine.manager.customMessagingManager.registerNamedMessageHandler('news', (sender, data) =>
        heard.push(`${machine.id} got ${JSON.stringify(data)} from ${sender}`),
      );
    }

    alice.manager.customMessagingManager.sendNamedMessage('chat', { text: 'hi' });
    host.manager.customMessagingManager.sendNamedMessage('news', 'just bob', 2);
    host.manager.customMessagingManager.sendNamedMessageToAll('news', 'everyone');
    net.pump();
    expect(heard.sort()).toEqual([
      'alice got "everyone" from 0',
      'bob got "everyone" from 0',
      'bob got "just bob" from 0',
      'host got {"text":"hi"} from 1',
    ]);

    expect(() => alice.manager.customMessagingManager.sendNamedMessage('chat', 1, 2)).toThrow(/only send messages to the server/);
    expect(() => host.manager.customMessagingManager.sendNamedMessage('news', 1, 9)).toThrow(/not connected/);
  });

  test('a handler can be removed', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    const heard: unknown[] = [];
    const off = host.manager.customMessagingManager.registerNamedMessageHandler('chat', (_sender, data) => heard.push(data));
    alice.manager.customMessagingManager.sendNamedMessage('chat', 1);
    net.pump();
    off();
    alice.manager.customMessagingManager.sendNamedMessage('chat', 2);
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
