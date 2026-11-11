import { afterEach, describe, expect, test } from 'bun:test';
import { isRecipient, type RpcAudience, SendTo } from '../src';
import { CratePrefab, type Machine, TestNetwork, Unit, warningsFrom } from './harness';

let net: TestNetwork;
afterEach(() => net?.dispose());

/** Host (0), alice (1) and bob (2), with a crate owned by alice. */
function setup() {
  net = new TestNetwork();
  const host = net.host();
  const alice = net.client('alice');
  const bob = net.client('bob');
  net.pump();
  const crate = host.make(CratePrefab);
  crate.spawnWithOwnership(1);
  net.pump();
  return { host, alice, bob, id: crate.networkObjectId };
}

/** The RPC calls a copy of the object has run, leaving out its lifecycle lines. */
function calls(machine: Machine, id: number): string[] {
  return machine.unit(id).seen.filter((line) => !/^(spawn|despawn|gained|lost)/.test(line));
}

describe('who is in the audience', () => {
  const audience: RpcAudience = { sender: 1, owner: 2, hostIsClient: true, targets: [3] };
  const who = (mode: SendTo, hostIsClient = true) =>
    [0, 1, 2, 3].filter((id) => isRecipient(mode, id, { ...audience, hostIsClient }));

  test('every SendTo mode picks the clients it names', () => {
    expect(who(SendTo.Server)).toEqual([0]);
    expect(who(SendTo.NotServer)).toEqual([1, 2, 3]);
    expect(who(SendTo.Owner)).toEqual([2]);
    expect(who(SendTo.NotOwner)).toEqual([0, 1, 3]);
    expect(who(SendTo.Me)).toEqual([1]);
    expect(who(SendTo.NotMe)).toEqual([0, 2, 3]);
    expect(who(SendTo.Everyone)).toEqual([0, 1, 2, 3]);
    expect(who(SendTo.SpecifiedInParams)).toEqual([3]);
  });

  test('ClientsAndHost includes the server only when it is also playing', () => {
    expect(who(SendTo.ClientsAndHost, true)).toEqual([0, 1, 2, 3]);
    expect(who(SendTo.ClientsAndHost, false)).toEqual([1, 2, 3]);
  });
});

describe('server RPCs', () => {
  test('the owner asks, the server runs it knowing who asked, and the result replicates', () => {
    const { host, alice, bob, id } = setup();
    alice.unit(id).hitRpc(30);
    expect(calls(alice, id)).toEqual([]); // it runs on the server, not here
    net.pump();
    expect(calls(host, id)).toEqual(['hit 30 from 1']);
    expect(calls(bob, id)).toEqual([]);
    for (const machine of [host, alice, bob]) expect(machine.unit(id).hp.value).toBe(70);
  });

  test('ownership is required by default, and the server enforces it even against a forged message', () => {
    const { host, bob, id } = setup();
    expect(() => bob.unit(id).hitRpc(1)).toThrow(/Only the owner can call "hitRpc"/);
    // Bypass the client-side check the way a modified client would.
    bob.transport.send('host', { t: 'rpc', o: id, b: 0, n: 'hitRpc', a: [99] });
    expect(warningsFrom(() => net.pump())).toEqual([
      'Client 2 called "hitRpc" on "Crate" without owning it; the call was ignored.',
    ]);
    expect(calls(host, id)).toEqual([]);
    expect(host.unit(id).hp.value).toBe(100);
  });

  test('requireOwnership: false lets any client call, and the sender id is the real one', () => {
    const { host, bob, id } = setup();
    bob.unit(id).openRpc('door');
    net.pump();
    expect(calls(host, id)).toEqual(['open door from 2']);
  });

  test('on the server a server RPC simply runs, whoever owns the object', () => {
    const { host, id } = setup();
    host.unit(id).hitRpc(5);
    expect(calls(host, id)).toEqual(['hit 5 from 0']);
    net.pump();
    expect(host.unit(id).hp.value).toBe(95);
  });

  test('outside a handler there is no sender', () => {
    const { host } = setup();
    expect(host.manager.currentRpcSender).toBe(-1);
  });
});

describe('client RPCs', () => {
  test('the server calls and the host and every client run it once', () => {
    const { host, alice, bob, id } = setup();
    host.unit(id).shoutRpc('charge');
    net.pump();
    for (const machine of [host, alice, bob]) expect(calls(machine, id)).toEqual(['shout charge']);
  });

  test('sendTo picks the clients', () => {
    const { host, alice, bob, id } = setup();
    host.unit(id).shoutRpc.sendTo([2], 'psst');
    net.pump();
    expect(calls(host, id)).toEqual([]);
    expect(calls(alice, id)).toEqual([]);
    expect(calls(bob, id)).toEqual(['shout psst']);
  });

  test('only the server may call one, and a forged call is ignored', () => {
    const { host, alice, bob, id } = setup();
    expect(() => alice.unit(id).shoutRpc('no')).toThrow(/clientRpc, so only the server can call it/);
    alice.transport.send('host', { t: 'rpc', o: id, b: 0, n: 'shoutRpc', a: ['forged'] });
    expect(warningsFrom(() => net.pump())).toEqual([
      'Client 1 called the clientRpc "shoutRpc", which only the server may call.',
    ]);
    for (const machine of [host, alice, bob]) expect(calls(machine, id)).toEqual([]);
  });

  test('a dedicated server does not run a clientRpc, but does run SendTo.Everyone', () => {
    net = new TestNetwork();
    const server = net.server();
    const alice = net.client('alice', 'server');
    net.pump();
    const crate = server.make(CratePrefab);
    crate.spawn();
    net.pump();
    const id = crate.networkObjectId;
    server.unit(id).shoutRpc('x');
    server.unit(id).everyoneRpc('y');
    net.pump();
    expect(calls(server, id)).toEqual(['everyone y']);
    expect(calls(alice, id)).toEqual(['shout x', 'everyone y']);
  });
});

describe('rpc(SendTo.X)', () => {
  /** Alice (1) calls; the crate is owned by alice; bob (2) and host (0) are the others. */
  function run(call: (unit: ReturnType<Machine['unit']>) => void, caller: 'host' | 'alice' | 'bob' = 'alice') {
    const world = setup();
    call(world[caller].unit(world.id));
    net.pump();
    const heard = (machine: Machine) => calls(machine, world.id);
    return { host: heard(world.host), alice: heard(world.alice), bob: heard(world.bob) };
  }

  test('Everyone runs on the caller at once, and once on each other machine', () => {
    const { host, alice, bob, id } = setup();
    alice.unit(id).everyoneRpc('hi');
    expect(calls(alice, id)).toEqual(['everyone hi']); // before any message has travelled
    net.pump();
    expect([calls(host, id), calls(alice, id), calls(bob, id)]).toEqual([
      ['everyone hi'],
      ['everyone hi'],
      ['everyone hi'],
    ]);
  });

  test('NotMe skips the caller', () => {
    expect(run((unit) => unit.notMeRpc('x'))).toEqual({ host: ['notMe x'], alice: [], bob: ['notMe x'] });
  });

  test('Owner reaches only the owner, wherever it is called from', () => {
    expect(run((unit) => unit.ownerRpc('x'), 'bob')).toEqual({ host: [], alice: ['owner x'], bob: [] });
    expect(run((unit) => unit.ownerRpc('x'), 'host')).toEqual({ host: [], alice: ['owner x'], bob: [] });
  });

  test('NotOwner reaches everyone but the owner, the server included', () => {
    expect(run((unit) => unit.notOwnerRpc('x'), 'bob')).toEqual({
      host: ['notOwner x'],
      alice: [],
      bob: ['notOwner x'],
    });
  });

  test('NotServer reaches the clients and not the host', () => {
    expect(run((unit) => unit.notServerRpc('x'))).toEqual({ host: [], alice: ['notServer x'], bob: ['notServer x'] });
  });

  test('Me never leaves the caller', () => {
    expect(run((unit) => unit.meRpc('x'), 'bob')).toEqual({ host: [], alice: [], bob: ['me x'] });
  });

  test('SpecifiedInParams goes to the clients you name, and must be called with sendTo', () => {
    expect(run((unit) => unit.pickRpc.sendTo([2], 'x'))).toEqual({ host: [], alice: [], bob: ['pick x'] });
    expect(run((unit) => unit.pickRpc.sendTo([0, 1], 'x'))).toEqual({ host: ['pick x'], alice: ['pick x'], bob: [] });
    const { alice, id } = setup();
    expect(() => alice.unit(id).pickRpc('x')).toThrow(/sendTo/);
    expect(() => alice.unit(id).everyoneRpc.sendTo([1], 'x')).toThrow(/only works on/);
  });

  test('an RPC needs a spawned object', () => {
    const { host } = setup();
    const loose = host.make(CratePrefab);
    expect(() => loose.getComponent(Unit)?.everyoneRpc('x')).toThrow(/not spawned/);
  });
});
