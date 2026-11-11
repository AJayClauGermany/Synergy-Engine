/**
 * Frontier's content and the sums done on it. Everything here is plain data and pure
 * functions: no scene, no network. The host uses them to decide what is allowed, clients
 * use the same ones to show what is possible, and tests call them directly.
 *
 * The pattern to copy:
 *   content   - JSON files and Catalogs (what Unity keeps in ScriptableObjects and Tile assets)
 *   questions - pure functions over that content and a few plain values
 * State (where each unit is, whose turn, who is winning) does NOT live here. In the
 * netcode model it lives in NetworkVariables, on Match and Soldier.
 */
import {
  Catalog,
  layerTileAt,
  type TilemapData,
  type TilemapLayerData,
  type TilePaletteData,
} from '@synergy/engine/data';
import { cellKey, findReachable, Hex, type Reachable } from '@synergy/engine/grid';
import mapJson from './data/map.json';
import tilesJson from './data/tiles.json';

/** A hex cell in the map's offset coordinates (odd rows sit half a cell to the right), as in Unity. */
export interface Cell {
  x: number;
  y: number;
}

/** What each kind of terrain means to the game: the `data` of a tile in tiles.json. */
export interface Terrain {
  climate: string;
  /** Units standing here see one cell further per level. */
  elevation: number;
  /** Movement points to enter. 99 means impassable. */
  moveCost: number;
  /** Damage taken here is reduced by this much. */
  cover: number;
}

export interface UnitType {
  id: string;
  maxHp: number;
  /** Movement points per order. */
  moveRange: number;
  /** How many cells away it sees. */
  sight: number;
  damage: number;
  /** Seconds between orders. */
  cooldown: number;
}

// ---- Content ------------------------------------------------------------------------------

export const tiles = tilesJson as TilePaletteData<Terrain>;
export const map = mapJson as unknown as TilemapData;

/** Unity: ScriptableObject assets of a `UnitType` class. Here: a Catalog, looked up by id. */
export const unitTypes = new Catalog<UnitType>('unit type', [
  { id: 'scout', maxHp: 6, moveRange: 4, sight: 4, damage: 2, cooldown: 1 },
  { id: 'guard', maxHp: 10, moveRange: 2, sight: 2, damage: 3, cooldown: 1.5 },
]);

const tileTypes = new Catalog('tile', tiles.tiles);
const ground = map.layers.find((layer) => layer.name === 'Terrain') as TilemapLayerData;

export const TEAM_NAMES = ['Blue', 'Red'] as const;
/** Each team's units and where they start. Red's cells mirror Blue's across the map. */
export const ARMY = ['scout', 'guard', 'guard'] as const;
export const START_CELLS: readonly (readonly Cell[])[] = [
  [
    { x: 1, y: 1 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ],
  [
    { x: ground.width - 2, y: ground.height - 2 },
    { x: ground.width - 2, y: ground.height - 1 },
    { x: ground.width - 3, y: ground.height - 1 },
  ],
];
/** The world advances on its own clock: every team earns `INCOME` each `WORLD_TICK_SECONDS`. */
export const WORLD_TICK_SECONDS = 2;
export const INCOME = 5;
const IMPASSABLE = 99;

// ---- Questions ----------------------------------------------------------------------------

/** The terrain of a cell, or `null` outside the map. */
export function terrainAt(cell: Cell): Terrain | null {
  const id = layerTileAt(ground, cell);
  return id ? (tileTypes.get(id).data ?? null) : null;
}

export function canEnter(cell: Cell): boolean {
  const terrain = terrainAt(cell);
  return terrain !== null && terrain.moveCost < IMPASSABLE;
}

/** Every cell of the map. */
export function allCells(): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < ground.height; y++) for (let x = 0; x < ground.width; x++) cells.push({ x, y });
  return cells;
}

/**
 * Where a unit can go with `movePoints`, and by what route. `occupied` says which cells
 * hold another unit: they cannot be entered or passed through.
 */
export function reachableFrom(from: Cell, movePoints: number, occupied: (cell: Cell) => boolean): Reachable {
  return findReachable(from, movePoints, {
    neighbors: (cell) => Hex.neighbors(cell).filter(canEnter),
    cost: (_from, to) =>
      occupied(to) ? Number.POSITIVE_INFINITY : (terrainAt(to)?.moveCost ?? Number.POSITIVE_INFINITY),
  });
}

/** How far a unit of this type sees from `cell`: its own sight, plus the height it stands on. */
export function sightFrom(type: UnitType, cell: Cell): number {
  return type.sight + (terrainAt(cell)?.elevation ?? 0);
}

export interface Viewer {
  cell: Cell;
  sight: number;
}

/** Whether any of `viewers` sees `cell`. This one rule drives both the fog and what the host sends. */
export function canSee(viewers: Iterable<Viewer>, cell: Cell): boolean {
  for (const viewer of viewers) if (Hex.distance(viewer.cell, cell) <= viewer.sight) return true;
  return false;
}

/** The keys (`cellKey`) of every map cell at least one of `viewers` sees. */
export function visibleCells(viewers: Iterable<Viewer>): Set<string> {
  const seen = new Set<string>();
  for (const viewer of viewers) {
    for (const cell of Hex.range(viewer.cell, viewer.sight)) if (terrainAt(cell)) seen.add(cellKey(cell));
  }
  return seen;
}

/** Damage after the defender's cover; an attack always does at least 1. */
export function damageTo(attacker: UnitType, defenderCell: Cell): number {
  return Math.max(1, attacker.damage - (terrainAt(defenderCell)?.cover ?? 0));
}
