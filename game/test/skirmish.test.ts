import { describe, expect, test } from 'bun:test';
import { Hex } from '@synergy/engine/grid';
import { CommandSession, LoopbackHub } from '@synergy/net';
import {
  apply,
  attackable,
  check,
  type Command,
  createGame,
  type GameState,
  MAX_HP,
  MOVE_POINTS,
  movement,
  pathFor,
  reachable,
  teamOf,
  terrainAt,
  unitAt,
  unitById,
} from '../src/rules/skirmish';

/** Applies commands for whichever team is to move, failing the test on an illegal one. */
function play(state: GameState, ...commands: Command[]): GameState {
  for (const command of commands) {
    expect(check(state, command, state.turn)).toBeNull();
    state = apply(state, command);
  }
  return state;
}

/** Puts a unit somewhere directly, to set up a situation without playing it out. */
function place(state: GameState, id: number, x: number, y: number): GameState {
  return { ...state, units: state.units.map((unit) => (unit.id === id ? { ...unit, x, y } : unit)) };
}

describe('skirmish rules', () => {
  test('a new game has two teams of four on a map with forests and a lake', () => {
    const state = createGame();
    expect(state.units.filter((unit) => unit.team === 0).length).toBe(4);
    expect(state.units.filter((unit) => unit.team === 1).length).toBe(4);
    expect(state.turn).toBe(0);
    expect(unitAt(state, 1, 0)?.team).toBe(0);
    expect(unitAt(state, 1, 7)?.team).toBe(1);
    expect(terrainAt({ x: 0, y: 0 })).toBe('plain');
    expect(terrainAt({ x: 2, y: 1 })).toBe('forest');
    expect(terrainAt({ x: 4, y: 3 })).toBe('water');
    expect(terrainAt({ x: 9, y: 0 })).toBeNull();
  });

  test('movement spends points: forests cost two, water and other units block', () => {
    const state = createGame();
    const unit = unitAt(state, 3, 0);
    if (!unit) throw new Error('missing unit');
    const range = movement(state, unit);

    // Straight ahead over open ground: three steps.
    expect(range.has({ x: 4, y: 3 })).toBe(false); // water
    expect(range.costTo({ x: 3, y: 2 })).toBe(2);
    // The forest at (2, 1) is adjacent but costs two points to enter.
    expect(Hex.distance(unit, { x: 2, y: 1 })).toBe(1);
    expect(range.costTo({ x: 2, y: 1 })).toBe(2);
    // Nothing costs more than the unit has, and occupied cells are never destinations.
    for (const { cost } of range.cells) expect(cost).toBeLessThanOrEqual(MOVE_POINTS);
    expect(range.has({ x: 5, y: 0 })).toBe(false);
    expect(reachable(state, unit).length).toBe(range.cells.length);

    expect(check(state, { type: 'move', unit: unit.id, x: 3, y: 5 }, 0)).toMatch(/cannot move/);
    const path = pathFor(state, unit, { x: 3, y: 2 });
    expect(path?.[0]).toEqual({ x: 3, y: 0 });
    expect(path?.at(-1)).toEqual({ x: 3, y: 2 });
    expect(path?.length).toBe(3);
    expect(pathFor(state, unit, { x: 4, y: 3 })).toBeNull();

    const moved = play(state, { type: 'move', unit: unit.id, x: 3, y: 2 });
    expect(unitById(moved, unit.id)).toMatchObject({ x: 3, y: 2, moved: true });
    expect(reachable(moved, unitById(moved, unit.id) as never)).toEqual([]);
    // The original state is untouched.
    expect(unitById(state, unit.id)).toMatchObject({ x: 3, y: 0, moved: false });
  });

  test('turn order is enforced and ending the turn refreshes units', () => {
    const state = createGame();
    const red = unitAt(state, 3, 7);
    if (!red) throw new Error('missing unit');
    expect(check(state, { type: 'move', unit: red.id, x: 3, y: 6 }, 1)).toMatch(/Blue's turn/);
    expect(check(state, { type: 'move', unit: red.id, x: 3, y: 6 }, 0)).toMatch(/not your unit/);
    const next = play(state, { type: 'move', unit: 0, x: 1, y: 1 }, { type: 'endTurn' });
    expect(next.turn).toBe(1);
    expect(next.turnNumber).toBe(2);
    expect(unitById(next, 0)?.moved).toBe(false);
  });

  test('adjacent enemies (all six sides) can be attacked until one side is gone', () => {
    // Blue unit 1 next to red unit 5, which starts at (3, 7).
    let state = place(createGame(), 1, 3, 6);
    const attacker = unitById(state, 1);
    if (!attacker) throw new Error('missing unit');
    expect(attackable(state, attacker).map((unit) => unit.id)).toEqual([5]);
    state = play(state, { type: 'attack', unit: 1, target: 5 });
    expect(unitById(state, 5)?.hp).toBe(MAX_HP - 2);
    expect(check(state, { type: 'attack', unit: 1, target: 5 }, 0)).toMatch(/cannot attack/);
    // Not adjacent: two cells away.
    expect(check(place(createGame(), 1, 3, 5), { type: 'attack', unit: 1, target: 5 }, 0)).toMatch(/cannot attack/);

    // Remove everything red but the wounded unit, then finish it off.
    state = { ...state, units: state.units.filter((unit) => unit.team === 0 || unit.id === 5) };
    state = play(state, { type: 'endTurn' }, { type: 'endTurn' }, { type: 'attack', unit: 1, target: 5 });
    state = play(state, { type: 'endTurn' }, { type: 'endTurn' }, { type: 'attack', unit: 1, target: 5 });
    expect(unitById(state, 5)).toBeUndefined();
    expect(state.winner).toBe(0);
    expect(check(state, { type: 'endTurn' }, 1)).toMatch(/over/);
    expect(check(state, { type: 'restart' }, 1)).toBeNull();
    expect(apply(state, { type: 'restart' })).toEqual(createGame());
  });

  test('team assignment: hot-seat alone, Blue and Red for the first two players', () => {
    expect(teamOf('solo', ['solo'], 1)).toBe(1);
    expect(teamOf('a', ['a', 'b'], 1)).toBe(0);
    expect(teamOf('b', ['a', 'b'], 0)).toBe(1);
    expect(teamOf('c', ['a', 'b', 'c'], 0)).toBeNull();
  });
});

describe('two players stay in sync through a session', () => {
  test('both machines reach the same state from the same command stream', () => {
    const hub = new LoopbackHub({ manual: true });
    const sessions = [
      CommandSession.host<Command>(hub.connect('host')),
      CommandSession.join<Command>(hub.connect('guest'), 'host'),
    ];
    // Each "machine" keeps its own copy of the state and applies what the session delivers.
    const states = sessions.map((session) => {
      const holder = { state: createGame() };
      session.onCommand.add(({ playerId, command }) => {
        const team = teamOf(playerId, session.players, holder.state.turn);
        if (team !== null && check(holder.state, command, team) === null) {
          holder.state = apply(holder.state, command);
        }
      });
      return holder;
    });
    hub.flush();
    const [host, guest] = sessions as [CommandSession<Command>, CommandSession<Command>];

    guest.submit({ type: 'move', unit: 5, x: 3, y: 6 }); // Not Red's turn: ignored everywhere.
    host.submit({ type: 'move', unit: 1, x: 3, y: 2 });
    host.submit({ type: 'endTurn' });
    guest.submit({ type: 'move', unit: 5, x: 3, y: 6 });
    hub.flush();

    expect(states[0]?.state).toEqual(states[1]?.state as GameState);
    expect(unitById(states[1]?.state as GameState, 1)).toMatchObject({ x: 3, y: 2 });
    expect(unitById(states[0]?.state as GameState, 5)).toMatchObject({ x: 3, y: 6 });
    expect(states[0]?.state.turn).toBe(1);
  });
});
