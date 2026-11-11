// The worked example in docs/netcode.md, kept here as a test so the guide cannot drift
// from what actually works. If you change this, change the guide to match.
import { afterEach, expect, test } from 'bun:test';
import { Engine, GameObject, instantiate, Vector3 } from '@synergy/engine';
import { LoopbackHub } from '@synergy/net';
import { NetworkBehaviour, NetworkManager, NetworkObject, NetworkPrefab, NetworkVariable } from '../src';

type Cell = { x: number; y: number };

/** A unit on a grid. Clients ask to move it; the host decides. */
class Soldier extends NetworkBehaviour {
  readonly health = new NetworkVariable(100);
  readonly cell = new NetworkVariable<Cell>({ x: 0, y: 0 });
  readonly walked: Cell[] = []; // stands in for an animation

  // Runs on the host, whichever client asked. By default only the owner may ask.
  readonly moveRpc = this.serverRpc((x: number, y: number) => {
    const { x: fromX, y: fromY } = this.cell.value;
    if (Math.abs(x - fromX) + Math.abs(y - fromY) > 2) return; // too far: refuse
    this.cell.value = { x, y };
  });

  onNetworkSpawn() {
    // Every machine, the host included, reacts the same way when the value changes.
    this.cell.onValueChanged.add((_before, now) => this.walked.push(now));
  }
}

const SoldierPrefab = new NetworkPrefab('Soldier', (go) => {
  go.addComponent(Soldier);
});

const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function machine(hub: LoopbackHub, id: string, role: 'host' | 'client') {
  const engine = Engine.createHeadless();
  engines.push(engine);
  const transport = hub.connect(id);
  const manager = engine.run(() => {
    const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
    manager.networkPrefabs.add(SoldierPrefab);
    if (role === 'host') manager.startHost(transport);
    else manager.startClient(transport, 'host');
    return manager;
  });
  return { engine, manager };
}

test('a client asks to move its soldier and the host decides', () => {
  const hub = new LoopbackHub({ manual: true });
  const host = machine(hub, 'host', 'host');
  const guest = machine(hub, 'guest', 'client');
  const frame = () => {
    hub.flush();
    host.engine.step(1 / 30);
    guest.engine.step(1 / 30);
  };
  for (let i = 0; i < 4; i++) frame();

  // The host creates the guest's soldier and gives it to them (client id 1).
  const created = host.engine.run(() => instantiate(SoldierPrefab, new Vector3(0, 0, 0)).getComponent(NetworkObject));
  created?.spawnWithOwnership(guest.manager.localClientId);
  for (let i = 0; i < 4; i++) frame();

  const id = created?.networkObjectId as number;
  const hostSoldier = host.manager.spawnManager.spawnedObjects.get(id)?.getComponent(Soldier) as Soldier;
  const guestSoldier = guest.manager.spawnManager.spawnedObjects.get(id)?.getComponent(Soldier) as Soldier;
  expect(guestSoldier.isOwner).toBe(true);

  guestSoldier.moveRpc(1, 1); // near enough
  for (let i = 0; i < 4; i++) frame();
  expect(hostSoldier.cell.value).toEqual({ x: 1, y: 1 });
  expect(guestSoldier.cell.value).toEqual({ x: 1, y: 1 });

  guestSoldier.moveRpc(9, 9); // too far: the host refuses, nothing changes anywhere
  for (let i = 0; i < 4; i++) frame();
  expect(hostSoldier.cell.value).toEqual({ x: 1, y: 1 });
  expect(guestSoldier.cell.value).toEqual({ x: 1, y: 1 });

  // Both machines saw exactly one move.
  expect(hostSoldier.walked).toEqual([{ x: 1, y: 1 }]);
  expect(guestSoldier.walked).toEqual([{ x: 1, y: 1 }]);
});
