/**
 * The rules of the sample game, as plain data and pure functions. Nothing here touches
 * the scene, the DOM or the network, so the same code can run in the browser, in
 * `bun test`, and on a server to validate moves. (`@synergy/engine/grid` is the
 * engine's pure grid maths: no renderer comes with it.)
 *
 * The pattern to copy for your own game:
 *   state    - a plain serialisable object
 *   commands - everything a player can do, as data
 *   check()  - is this command legal right now?
 *   apply()  - the next state. Deterministic: same state + command => same result.
 */
import { findReachable, Hex, type Reachable } from '@synergy/engine/grid';

export const COLUMNS = 9;
export const ROWS = 8;
export const MAX_HP = 5;
/** Movement points a unit may spend per turn. */
export const MOVE_POINTS = 3;
export const ATTACK_DAMAGE = 2;

/** 0 = Blue (moves first), 1 = Red. */
export type Team = 0 | 1;
export const TEAM_NAMES = ['Blue', 'Red'] as const;

/** A hex cell in the map's offset coordinates (odd rows sit half a cell to the right). */
export interface Cell {
  x: number;
  y: number;
}

export type Terrain = 'plain' | 'forest' | 'water';

/** Movement points needed to enter each kind of terrain. */
export const MOVE_COST: Record<Terrain, number> = { plain: 1, forest: 2, water: Number.POSITIVE_INFINITY };

// The map, row 0 (Blue's side) first. `.` plain, `f` forest, `~` water.
const MAP = [
  '.........',
  '..f...f..',
  '.f.....f.',
  '...f~~...',
  '...~~f...',
  '.f.....f.',
  '..f...f..',
  '.........',
] as const;

const TERRAIN_BY_SYMBOL: Record<string, Terrain> = { '.': 'plain', f: 'forest', '~': 'water' };

export const inBounds = (cell: Cell) => cell.x >= 0 && cell.y >= 0 && cell.x < COLUMNS && cell.y < ROWS;

/** The terrain of a cell, or `null` outside the map. */
export function terrainAt(cell: Cell): Terrain | null {
  const symbol = MAP[cell.y]?.[cell.x];
  return symbol ? (TERRAIN_BY_SYMBOL[symbol] ?? null) : null;
}

export interface Unit {
  id: number;
  team: Team;
  x: number;
  y: number;
  hp: number;
  /** Has moved this turn. */
  moved: boolean;
  /** Has attacked this turn (which also ends its move). */
  attacked: boolean;
}

export interface GameState {
  units: Unit[];
  turn: Team;
  turnNumber: number;
  winner: Team | null;
}

export type Command =
  | { type: 'move'; unit: number; x: number; y: number }
  | { type: 'attack'; unit: number; target: number }
  | { type: 'endTurn' }
  | { type: 'restart' };

export function createGame(): GameState {
  const units: Unit[] = [];
  const columns = [1, 3, 5, 7];
  columns.forEach((x, index) => {
    units.push({ id: index, team: 0, x, y: 0, hp: MAX_HP, moved: false, attacked: false });
    units.push({ id: index + columns.length, team: 1, x, y: ROWS - 1, hp: MAX_HP, moved: false, attacked: false });
  });
  return { units, turn: 0, turnNumber: 1, winner: null };
}

export function unitAt(state: GameState, x: number, y: number): Unit | undefined {
  return state.units.find((unit) => unit.x === x && unit.y === y);
}

export function unitById(state: GameState, id: number): Unit | undefined {
  return state.units.find((unit) => unit.id === id);
}

/**
 * Where the unit can walk this turn and by which route: forests cost 2 points, water and
 * occupied cells cannot be entered. Ask the result with `.has(cell)` / `.pathTo(cell)`.
 */
export function movement(state: GameState, unit: Unit): Reachable {
  if (unit.moved || unit.attacked) return findReachable(unit, 0, { neighbors: () => [] });
  return findReachable(unit, MOVE_POINTS, {
    neighbors: (cell) => Hex.neighbors(cell).filter(inBounds),
    cost: (_from, to) => (unitAt(state, to.x, to.y) ? Number.POSITIVE_INFINITY : MOVE_COST[terrainAt(to) ?? 'water']),
  });
}

/** Cells the unit can walk to this turn. */
export function reachable(state: GameState, unit: Unit): Cell[] {
  return movement(state, unit).cells.map(({ cell }) => ({ x: cell.x, y: cell.y }));
}

/** The cells a move passes through, from the unit's cell to `target`, or `null` if it cannot get there. */
export function pathFor(state: GameState, unit: Unit, target: Cell): Cell[] | null {
  const route = movement(state, unit);
  if (!route.has(target)) return null;
  return route.pathTo(target)?.map((cell) => ({ x: cell.x, y: cell.y })) ?? null;
}

/** Enemy units next to this unit that it may attack this turn. */
export function attackable(state: GameState, unit: Unit): Unit[] {
  if (unit.attacked) return [];
  return state.units.filter((other) => other.team !== unit.team && Hex.distance(other, unit) === 1);
}

/**
 * Returns why `command` is not allowed for `team`, or `null` if it is legal.
 * Call this before `apply`, on every machine, so an illegal command is ignored everywhere.
 */
export function check(state: GameState, command: Command, team: Team): string | null {
  if (command.type === 'restart') return state.winner === null ? 'The game is not over yet.' : null;
  if (state.winner !== null) return 'The game is over.';
  if (team !== state.turn) return `It is ${TEAM_NAMES[state.turn]}'s turn.`;
  if (command.type === 'endTurn') return null;

  const unit = unitById(state, command.unit);
  if (!unit) return 'That unit does not exist.';
  if (unit.team !== team) return 'That is not your unit.';
  if (command.type === 'move') {
    return movement(state, unit).has(command) ? null : 'That unit cannot move there.';
  }
  const allowed = attackable(state, unit).some((target) => target.id === command.target);
  return allowed ? null : 'That unit cannot attack that target.';
}

/** The state after `command`. Assumes `check` passed. Never mutates its input. */
export function apply(state: GameState, command: Command): GameState {
  switch (command.type) {
    case 'restart':
      return createGame();
    case 'endTurn':
      return {
        ...state,
        turn: state.turn === 0 ? 1 : 0,
        turnNumber: state.turnNumber + 1,
        units: state.units.map((unit) => ({ ...unit, moved: false, attacked: false })),
      };
    case 'move':
      return {
        ...state,
        units: state.units.map((unit) =>
          unit.id === command.unit ? { ...unit, x: command.x, y: command.y, moved: true } : unit,
        ),
      };
    case 'attack': {
      const units = state.units
        .map((unit) => {
          if (unit.id === command.unit) return { ...unit, attacked: true, moved: true };
          if (unit.id === command.target) return { ...unit, hp: unit.hp - ATTACK_DAMAGE };
          return unit;
        })
        .filter((unit) => unit.hp > 0);
      const alive = new Set(units.map((unit) => unit.team));
      const winner = alive.size === 1 ? ([...alive][0] as Team) : null;
      return { ...state, units, winner };
    }
  }
}

/**
 * Which team a player controls. The first two players get Blue and Red. A player alone
 * in the session controls whichever side is to move, which gives hot-seat play.
 */
export function teamOf(playerId: string, players: readonly string[], turn: Team): Team | null {
  if (players.length <= 1) return turn;
  const index = players.indexOf(playerId);
  return index === 0 || index === 1 ? index : null;
}
