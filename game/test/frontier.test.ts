import { afterEach, describe, expect, test } from 'bun:test';
import { GameObject } from '@synergy/engine';
import { type TestMachine, TestNetwork } from '@synergy/netcode/testing';
import { frontierHud } from '../src/frontier/hud';
import { Match } from '../src/frontier/Match';
import { canSee, type Cell, reachableFrom, sightFrom, terrainAt, unitTypes, visibleCells } from '../src/frontier/rules';
import { FRONTIER_SCENE } from '../src/frontier/scene';
import { setupFrontier, spawnSoldier, startMatch } from '../src/frontier/session';
import { Soldier, SoldierPrefab } from '../src/frontier/Soldier';

/**
 * The netcode sample, tested the way a match is played: a host and guests, each a
 * simulated machine with its own engine and scene, joined by an in-memory network.
 * Copy this file's shape for your own game's network tests.
 */
let net: TestNetwork;
afterEach(() => net?.dispose());

/** A host and one guest, connected, with a match being played. */
async function matchWithGuest() {
  net = new TestNetwork(setupFrontier);
  const host = net.host();
  const guest = net.client('guest');
  net.pump();
  const match = await host.run(() => startMatch(host.manager));
  await net.settle();
  return { host, guest, match };
}

const matchOn = (machine: TestMachine) => Match.of(machine.manager) as Match;
/** A machine's own copies of the soldiers of one team. */
const soldiers = (machine: TestMachine, team: number) =>
  machine.objectsOf(SoldierPrefab).map((object) => object.getComponent(Soldier) as Soldier).filter((soldier) => soldier.team.value === team);
const scoutOf = (machine: TestMachine, team: number) => soldiers(machine, team).find((soldier) => soldier.type.value === 'scout') as Soldier;
/** Lets a unit's cooldown run out. */
const rest = () => net.pump(60);

describe('rules (no engine, no network)', () => {
  test('terrain comes from the map and palette files', () => {
    expect(terrainAt({ x: 1, y: 1 })?.moveCost).toBe(1);
    expect(terrainAt({ x: 99, y: 0 })).toBeNull();
    expect(unitTypes.get('scout').moveRange).toBe(4);
  });

  test('movement spends points by terrain and stops at other units', () => {
    const from = { x: 1, y: 1 };
    const open = reachableFrom(from, 2, () => false);
    expect(open.has({ x: 2, y: 1 })).toBe(true);
    expect(open.has({ x: 5, y: 1 })).toBe(false);
    const blocked = reachableFrom(from, 2, (cell) => cell.x === 2 && cell.y === 1);
    expect(blocked.has({ x: 2, y: 1 })).toBe(false);
  });

  test('sight grows with height, and one rule decides both fog and what is sent', () => {
    const scout = unitTypes.get('scout');
    const viewers = [{ cell: { x: 1, y: 1 }, sight: sightFrom(scout, { x: 1, y: 1 }) }];
    expect(canSee(viewers, { x: 5, y: 1 })).toBe(true);
    expect(canSee(viewers, { x: 6, y: 1 })).toBe(false);
    expect(visibleCells(viewers).has('5,1,0')).toBe(true);
    expect(visibleCells(viewers).has('6,1,0')).toBe(false);
  });
});

describe('starting a match', () => {
  test('alone: the host loads the scene, spawns both armies and play begins', async () => {
    net = new TestNetwork(setupFrontier);
    const host = net.host();
    const match = await host.run(() => startMatch(host.manager));
    net.pump();

    expect(host.manager.sceneManager.sceneName).toBe(FRONTIER_SCENE);
    expect(host.run(() => GameObject.find('Board/Map/Terrain'))).not.toBeNull();
    expect(match.phase.value).toBe('playing');
    expect(match.teamOf(0)).toBe(0);
    expect(soldiers(host, 0).length).toBe(3);
    expect(soldiers(host, 1).length).toBe(3);
  });

  test('with a guest: nobody may act until every machine has the map', async () => {
    net = new TestNetwork(setupFrontier);
    const host = net.host();
    const guest = net.client('guest');
    net.pump();

    const match = await host.run(() => startMatch(host.manager));
    // The host's copy is ready and the armies are spawned, but the guest has not reported in.
    expect(match.phase.value).toBe('waiting');
    const scout = scoutOf(host, 0);
    host.run(() => scout.moveRpc(2, 1));
    net.pump(1);
    expect(scout.cell.value).toEqual({ x: 1, y: 1 });
    expect(frontierHud.value.message).toBe('The match is not being played.');

    await net.settle();
    expect(match.phase.value).toBe('playing');
    expect(matchOn(guest).phase.value).toBe('playing');
    expect(guest.run(() => GameObject.find('Board/Map/Terrain'))).not.toBeNull();
    // Seats: the host commands Blue, the first guest Red.
    expect(matchOn(guest).teamOf(guest.manager.localClientId)).toBe(1);
    expect(matchOn(guest).teamOf(0)).toBe(0);
  });
});

describe('orders', () => {
  test('a player moves their own unit, and every machine that sees it follows', async () => {
    const { host, guest } = await matchWithGuest();
    const mine = scoutOf(guest, 1);
    const start = mine.cell.value;
    const target = { x: start.x - 2, y: start.y };

    guest.run(() => mine.moveRpc(target.x, target.y));
    net.pump();

    expect(mine.cell.value).toEqual(target);
    expect((host.object(mine.networkObjectId).getComponent(Soldier) as Soldier).cell.value).toEqual(target);
    // The host stamped a cooldown: the next order comes too soon and is refused.
    guest.run(() => mine.moveRpc(target.x - 1, target.y));
    net.pump();
    expect(mine.cell.value).toEqual(target);
    expect(frontierHud.value.message).toBe('That unit is not ready yet.');
    rest();
    guest.run(() => mine.moveRpc(target.x - 1, target.y));
    net.pump();
    expect(mine.cell.value).toEqual({ x: target.x - 1, y: target.y });
  });

  test('the host refuses what the rules do not allow, whoever asks', async () => {
    const { host, guest } = await matchWithGuest();
    const blue = scoutOf(host, 0);
    const red = scoutOf(guest, 1);
    const before = { blue: blue.cell.value, red: red.cell.value };
    const refused = (order: () => void, reason: string) => {
      frontierHud.update((state) => ({ ...state, message: '' }));
      order();
      net.pump();
      expect(frontierHud.value.message).toBe(reason);
    };

    // Too far, onto water or off the map, onto another unit: all "out of reach".
    refused(() => guest.run(() => red.moveRpc(0, 0)), 'That cell is out of reach.');
    refused(() => guest.run(() => red.moveRpc(99, 99)), 'That cell is out of reach.');
    const neighbour = soldiers(guest, 1).find((soldier) => soldier !== red) as Soldier;
    refused(() => guest.run(() => red.moveRpc(neighbour.cell.value.x, neighbour.cell.value.y)), 'That cell is out of reach.');
    // Somebody else's unit. The host's own copy of the Red scout exists, so the host can try.
    const redOnHost = host.object(red.networkObjectId).getComponent(Soldier) as Soldier;
    refused(() => host.run(() => redOnHost.moveRpc(before.red.x - 1, before.red.y)), 'That unit is not yours to command.');
    // Nonsense from a modified client is dropped without a word.
    guest.run(() => red.moveRpc(1.5, Number.NaN));
    net.pump();

    expect(blue.cell.value).toEqual(before.blue);
    expect(red.cell.value).toEqual(before.red);
  });

  test('an attack next to an enemy hurts it; killing the last one ends the match', async () => {
    net = new TestNetwork(setupFrontier);
    const host = net.host();
    const guest = net.client('guest');
    net.pump();
    const match = await host.run(() => startMatch(host.manager));
    await net.settle();
    // Clear the field, then stage a duel: one Blue guard beside one wounded Red scout.
    host.run(() => {
      for (const soldier of [...soldiers(host, 0), ...soldiers(host, 1)]) soldier.networkObject.despawn();
    });
    const blue = host.run(() => spawnSoldier(match, 'guard', 0, { x: 4, y: 4 }));
    const red = host.run(() => spawnSoldier(match, 'scout', 1, { x: 5, y: 4 }));
    net.pump();
    const redOnGuest = guest.object(red.networkObjectId).getComponent(Soldier) as Soldier;
    expect(redOnGuest.hp.value).toBe(6);

    host.run(() => blue.attackRpc(red.networkObjectId));
    net.pump();
    expect(red.hp.value).toBe(3); // a guard does 3; the plain gives no cover
    expect(redOnGuest.hp.value).toBe(3);
    expect(match.phase.value).toBe('playing');

    rest();
    host.run(() => blue.attackRpc(red.networkObjectId));
    net.pump();
    expect(guest.has(red.networkObjectId)).toBe(false);
    expect(match.phase.value).toBe('over');
    expect(matchOn(guest).winner.value).toBe(0);
  });
});

describe('fog of war, enforced by the host', () => {
  test('a client is only sent the enemies its own units can see', async () => {
    const { host, guest } = await matchWithGuest();
    // The armies start in opposite corners, out of each other's sight.
    expect(soldiers(host, 0).length + soldiers(host, 1).length).toBe(6); // the host holds everything
    expect(soldiers(guest, 1).length).toBe(3);
    expect(soldiers(guest, 0).length).toBe(0);

    // The Blue scout walks toward Red until it comes into view...
    const scout = scoutOf(host, 0);
    const home = scout.cell.value;
    const goal = scoutOf(guest, 1).cell.value;
    /** One order: as far toward `target` as the scout can get. The host checks it like any other. */
    const stepToward = (target: Cell) => {
      const reach = reachableFrom(scout.cell.value, scout.unitType.moveRange, (cell) => matchOn(host).unitAt(cell) !== null);
      const distance = (cell: Cell) => Math.hypot(cell.x - target.x, cell.y - target.y);
      const next = reach.cells.map(({ cell }) => ({ x: cell.x, y: cell.y })).sort((a, b) => distance(a) - distance(b))[0];
      if (next && distance(next) < distance(scout.cell.value)) host.run(() => scout.moveRpc(next.x, next.y));
      rest();
    };
    for (let step = 0; step < 10 && soldiers(guest, 0).length === 0; step++) stepToward(goal);
    const seen = soldiers(guest, 0);
    expect(seen.length).toBe(1);
    expect(seen[0]?.cell.value).toEqual(scout.cell.value); // it arrived with its current state
    expect(seen[0]?.hp.value).toBe(6);
    // ...and the host's player has found Red in turn: the same rule, the other way round.
    expect(canSee(matchOn(host).viewersOf(0), goal)).toBe(true);

    // It walks home again, and the guest's copy is taken back.
    for (let step = 0; step < 10 && soldiers(guest, 0).length > 0; step++) stepToward(home);
    expect(soldiers(guest, 0).length).toBe(0);
    expect(soldiers(host, 0).length).toBe(3); // nothing happened to the unit itself
  });
});

describe('the world and late arrivals', () => {
  test('the host advances the world on the network clock and every machine sees the result', async () => {
    const { host, guest } = await matchWithGuest();
    const before = matchOn(guest).worldTick.value;
    net.pump(150); // five seconds at 30 frames a second
    expect(matchOn(host).worldTick.value).toBeGreaterThanOrEqual(before + 2);
    expect(matchOn(guest).worldTick.value).toBe(matchOn(host).worldTick.value);
    expect(matchOn(guest).resources.value).toEqual(matchOn(host).resources.value);
    expect(matchOn(guest).resources.value[1]).toBeGreaterThan(0);
  });

  test('someone who joins mid-match gets the scene and the current state, and watches', async () => {
    const { host, guest } = await matchWithGuest();
    const mine = scoutOf(guest, 1);
    guest.run(() => mine.moveRpc(mine.cell.value.x - 2, mine.cell.value.y));
    net.pump();

    const late = net.client('late');
    await net.settle();

    expect(late.run(() => GameObject.find('Board/Map/Terrain'))).not.toBeNull();
    expect(matchOn(late).phase.value).toBe('playing');
    expect(matchOn(late).teamOf(late.manager.localClientId)).toBe(-1); // both teams are taken
    // A watcher sees every unit, where it is now: no history was replayed to get here.
    expect(soldiers(late, 0).length + soldiers(late, 1).length).toBe(6);
    expect((late.object(mine.networkObjectId).getComponent(Soldier) as Soldier).cell.value).toEqual(mine.cell.value);
    expect(matchOn(host).seats.count).toBe(3);
  });

  test('a rematch replaces the match and its units on every machine', async () => {
    const { host, guest } = await matchWithGuest();
    const oldMatch = matchOn(guest);
    const oldIds = soldiers(guest, 1).map((soldier) => soldier.networkObjectId);

    await host.run(() => startMatch(host.manager));
    await net.settle();

    expect(matchOn(guest)).not.toBe(oldMatch);
    expect(oldMatch.isSpawned).toBe(false);
    for (const id of oldIds) expect(guest.has(id)).toBe(false);
    expect(soldiers(guest, 1).length).toBe(3);
    expect(matchOn(guest).phase.value).toBe('playing');
    expect(guest.run(() => GameObject.findGameObjectsWithTag('MainCamera').length)).toBe(1); // one scene, not two
  });
});
