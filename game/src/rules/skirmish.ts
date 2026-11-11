/**
 * The rules of the sample game, as plain data and pure functions. Nothing here touches
 * the engine, the DOM or the network, so the same code can run in the browser, in
 * `bun test`, and on a server to validate moves.
 *
 * The pattern to copy for your own game:
 *   state    - a plain serialisable object
 *   commands - everything a player can do, as data
 *   check()  - is this command legal right now?
 *   apply()  - the next state. Deterministic: same state + command => same result.
 */

export const BOARD_SIZE = 8;
export const MAX_HP = 5;
export const MOVE_RANGE = 3;
export const ATTACK_DAMAGE = 2;

/** 0 = Blue (moves first), 1 = Red. */
export type Team = 0 | 1;
export const TEAM_NAMES = ['Blue', 'Red'] as const;

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

export interface Cell {
  x: number;
  y: number;
}

export function createGame(): GameState {
  const units: Unit[] = [];
  const columns = [1, 3, 4, 6];
  columns.forEach((x, index) => {
    units.push({ id: index, team: 0, x, y: 0, hp: MAX_HP, moved: false, attacked: false });
    units.push({ id: index + columns.length, team: 1, x, y: BOARD_SIZE - 1, hp: MAX_HP, moved: false, attacked: false });
  });
  return { units, turn: 0, turnNumber: 1, winner: null };
}

export function unitAt(state: GameState, x: number, y: number): Unit | undefined {
  return state.units.find((unit) => unit.x === x && unit.y === y);
}

export function unitById(state: GameState, id: number): Unit | undefined {
  return state.units.find((unit) => unit.id === id);
}

const NEIGHBOURS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;

/** Cells the unit can walk to this turn: up to MOVE_RANGE steps, not through other units. */
export function reachable(state: GameState, unit: Unit): Cell[] {
  if (unit.moved || unit.attacked) return [];
  const visited = new Set<string>([`${unit.x},${unit.y}`]);
  const result: Cell[] = [];
  let frontier: Cell[] = [{ x: unit.x, y: unit.y }];
  for (let step = 0; step < MOVE_RANGE; step++) {
    const next: Cell[] = [];
    for (const cell of frontier) {
      for (const offset of NEIGHBOURS) {
        const x = cell.x + offset.x;
        const y = cell.y + offset.y;
        const key = `${x},${y}`;
        if (!inBounds(x, y) || visited.has(key) || unitAt(state, x, y)) continue;
        visited.add(key);
        next.push({ x, y });
        result.push({ x, y });
      }
    }
    frontier = next;
  }
  return result;
}

/** Enemy units next to this unit that it may attack this turn. */
export function attackable(state: GameState, unit: Unit): Unit[] {
  if (unit.attacked) return [];
  return state.units.filter(
    (other) => other.team !== unit.team && Math.abs(other.x - unit.x) + Math.abs(other.y - unit.y) === 1,
  );
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
    const allowed = reachable(state, unit).some((cell) => cell.x === command.x && cell.y === command.y);
    return allowed ? null : 'That unit cannot move there.';
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
