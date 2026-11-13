// Mistakes that used to work on the machine that made them (the host, a single-player
// game, a test that only looks at the host) and break on everyone else's. Each is now
// stopped where it is made, or made to behave the same on every machine.
import { afterEach, describe, expect, test } from 'bun:test';
import { SceneManager, Vector3 } from '@synergy/engine';
import { CommandSession, LoopbackHub, wireProblem } from '@synergy/net';
import { NetworkBehaviour, NetworkPrefab, NetworkVariable, Serializers } from '../src';
import { type TestMachine, TestNetwork } from '../src/testing';

class Fighter extends NetworkBehaviour {
  readonly hp = new NetworkVariable(10);
  readonly at = new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 });
  readonly loot = new NetworkVariable<string[]>([]);
  /** What this copy saw, in order. */
  seen: string[] = [];

  readonly showHitRpc = this.clientRpc(() => this.seen.push(`bar shows ${this.hp.value}`));
  readonly aimRpc = this.serverRpc((x: number, y: number, fast?: boolean) => this.seen.push(`aim ${x},${y},${fast}`), {
    requireOwnership: false,
  });
  readonly lookRpc = this.serverRpc((point: Vector3) => this.seen.push(`look ${point.x}`), { requireOwnership: false });
  readonly takeRpc = this.serverRpc((items: string[]) => items.push('changed by the handler'), {
    requireOwnership: false,
  });

  onNetworkSpawn() {
    this.hp.onValueChanged.add((_before, now) => this.seen.push(`hp is now ${now}`));
  }

  /** Server: what a hit does. */
  takeDamage(amount: number) {
    this.hp.value -= amount;
    this.showHitRpc();
    if (this.hp.value <= 0) this.networkObject.despawn();
  }
}

const FighterPrefab = new NetworkPrefab('Fighter', (go) => {
  go.addComponent(Fighter);
});

let net: TestNetwork;
afterEach(() => net?.dispose());

function setup() {
  net = new TestNetwork((manager) => manager.networkPrefabs.add(FighterPrefab));
  const host = net.host();
  const guest = net.client('guest');
  net.pump();
  const object = host.make(FighterPrefab);
  object.spawn();
  net.pump();
  const on = (machine: TestMachine) => machine.object(object.networkObjectId).getComponent(Fighter) as Fighter;
  return { host, guest, onHost: on(host), onGuest: on(guest) };
}

describe('the order things arrive in', () => {
  test('a value written before an RPC is there when the RPC runs, on every machine', () => {
    const { host, onHost, onGuest } = setup();
    host.run(() => onHost.takeDamage(4));
    net.pump();
    expect(onHost.seen).toEqual(['hp is now 6', 'bar shows 6']);
    expect(onGuest.seen).toEqual(['hp is now 6', 'bar shows 6']);
  });

  test('the last value written before a despawn reaches the clients', () => {
    const { host, onHost, onGuest } = setup();
    host.run(() => onHost.takeDamage(10));
    net.pump();
    expect(onGuest.seen).toEqual(['hp is now 0', 'bar shows 0']);
  });
});

describe('what cannot cross the network is refused where it is sent', () => {
  test('an RPC argument that is a class instance: the host would have got away with it', () => {
    const { host, onHost } = setup();
    expect(() => host.run(() => onHost.lookRpc(new Vector3(1, 2, 3)))).toThrow(
      /Cannot call RPC "lookRpc".*is a Vector3, which arrives as a plain object without its methods/s,
    );
    expect(onHost.seen).toEqual([]);
  });

  test('Infinity, NaN and a Map in a variable, which JSON would turn into null and {}', () => {
    const { host, onHost } = setup();
    expect(() => new NetworkVariable(Number.POSITIVE_INFINITY)).toThrow(/is Infinity, which JSON turns into null/);
    expect(() => new NetworkVariable(new Map<string, number>())).toThrow(/is a Map, which arrives empty/);
    expect(() => new NetworkVariable(Vector3.zero)).toThrow(/is a Vector3.*Serializers\.vector3/s);
    expect(() =>
      host.run(() => {
        onHost.hp.value = Number.NaN;
      }),
    ).toThrow(/NetworkVariable "hp".*is NaN/s);
    expect(onHost.hp.value).toBe(10);
  });

  test('a value with a serializer, and plain data, pass as before', () => {
    const { host, onHost, onGuest } = setup();
    host.run(() => {
      onHost.at.value = new Vector3(1, 2, 3);
      onHost.loot.value = ['sword'];
    });
    net.pump();
    expect(onGuest.at.value.equals(new Vector3(1, 2, 3))).toBe(true);
    expect(onGuest.loot.value).toEqual(['sword']);
  });

  test('an optional argument left off or passed as undefined is the same call everywhere', () => {
    const { host, guest, onHost, onGuest } = setup();
    guest.run(() => onGuest.aimRpc(1, 2, undefined));
    host.run(() => onHost.aimRpc(3, 4));
    net.pump();
    expect(onHost.seen).toEqual(['aim 3,4,undefined', 'aim 1,2,undefined']);
  });

  test('the handler is given a copy, on the caller too: neither side can change the other', () => {
    const { host, onHost } = setup();
    const items = ['sword'];
    host.run(() => onHost.takeRpc(items));
    expect(items).toEqual(['sword']);
  });
});

describe('values are replaced, not changed in place', () => {
  test('a change in place does not compile; a new value is sent', () => {
    const { host, onHost, onGuest } = setup();
    const neverRun = () => {
      // @ts-expect-error a read-only array has no push: it would change this machine's copy and send nothing
      onHost.loot.value.push('shield');
    };
    expect(neverRun).toBeFunction();
    host.run(() => {
      onHost.loot.value = [...onHost.loot.value, 'shield'];
    });
    net.pump();
    expect(onGuest.loot.value).toEqual(['shield']);
  });
});

describe('a manager that did not survive a scene load', () => {
  test('starting it says to keep it, instead of hosting a game nobody can join', async () => {
    net = new TestNetwork();
    const machine = net.create('host');
    await machine.run(async () => {
      SceneManager.register('Menu', () => {});
      await SceneManager.loadScene('Menu');
    });
    expect(() => machine.run(() => machine.manager.startHost(machine.transport))).toThrow(
      /has been destroyed.*dontDestroyOnLoad\(manager\.gameObject\)/s,
    );
  });
});

describe('commands', () => {
  type Command = { type: 'spawn'; at: { x: number; y: number }; power: number };

  test('a command JSON would change is refused when it is submitted, also offline', () => {
    const session = CommandSession.local<unknown>();
    expect(() => session.submit({ type: 'spawn', at: new Vector3(2, 3, 0) })).toThrow(
      /session\.submit\(\): the command\.at is a Vector3/,
    );
    expect(() => session.submit({ type: 'wait', until: Number.POSITIVE_INFINITY })).toThrow(
      /the command\.until is Infinity/,
    );
    expect(session.log).toHaveLength(0);
  });

  test('the host applies what the guests receive, and the log cannot be rewritten afterwards', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'));
    const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
    hub.flush();
    const command: Command = { type: 'spawn', at: { x: 1, y: 1 }, power: 1 };
    host.submit(command);
    command.power = 99;
    command.at.x = 7;
    host.submit(command);
    hub.flush();
    const powers = (session: CommandSession<Command>) => session.log.map((entry) => entry.command.power);
    expect(powers(host)).toEqual([1, 99]);
    expect(powers(guest)).toEqual([1, 99]);
    expect(host.log[0]?.command.at).toEqual({ x: 1, y: 1 });
  });

  test('wireProblem names the first thing that would not survive, with its path', () => {
    expect(wireProblem({ units: [{ id: 1, cell: { x: 0, y: 0 } }], note: undefined })).toBeNull();
    expect(wireProblem({ units: [{ id: 1, seen: new Set([1]) }] }, 'the state')).toContain(
      'the state.units[0].seen is a Set',
    );
    expect(wireProblem([1, undefined])).toContain('[1] is undefined');
  });
});

describe("the client's clock", () => {
  test('a change sent in the middle of a tick (before an RPC) does not set the clock back', () => {
    const { host, guest, onHost } = setup();
    const quarterTick = 1 / 120; // the tick rate is 30: four frames to a tick
    /** How many ticks the guest's idea of the server's clock trails it, summed over two ticks of frames. */
    const lagOverTwoTicks = () => {
      let lag = 0;
      for (let frame = 0; frame < 8; frame++) {
        net.pump(1, quarterTick);
        lag += host.manager.localTime.tick - guest.manager.serverTime.tick;
      }
      return lag;
    };
    // A change sent as a tick begins: the guest sets its clock by it and trails by a frame.
    host.run(() => {
      onHost.hp.value -= 1;
    });
    net.pump(8, quarterTick);
    const before = lagOverTwoTicks();
    expect(before).toBeLessThanOrEqual(2);
    // Three quarters of the way into a tick, write a value and call an RPC: the value is
    // sent at once, carrying the tick the server is still in.
    net.pump(3, quarterTick);
    host.run(() => onHost.takeDamage(1));
    net.pump(1, quarterTick);
    expect(lagOverTwoTicks()).toBeLessThanOrEqual(before);
  });
});
