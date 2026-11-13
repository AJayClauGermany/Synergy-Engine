import { Behaviour } from '../core/Component';
import { nameType } from '../core/typeNames';
import { isAlive } from '../core/EngineObject';
import { GameObject } from '../core/GameObject';
import { destroy, instantiate, type Prefab } from '../core/Object';
import { encodeLayer, type TilemapLayerData } from '../data/tiles';
import { Hex, Square } from '../grid/hex';
import {
  CellLayout,
  cellCenterToLocal,
  cellToLocal,
  defaultGridShape,
  type GridShape,
  localToCell,
} from '../grid/layout';
import { Debug } from '../core/Debug';
import { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { BoundsInt, type CellLike, cellKey, Vector3Int } from '../math/Vector3Int';
import type { Sprite } from '../components/Sprite';
import { Grid } from './Grid';

const DEFAULT_SHAPE: Readonly<GridShape> = Object.freeze(defaultGridShape());

/**
 * Unity's `TileFlags`, with Unity's values: what a tile lets the tilemap change about it
 * cell by cell. Combine with `|`: `TileFlags.LockColor | TileFlags.LockTransform`.
 */
export enum TileFlags {
  None = 0,
  /**
   * The cell always shows the tile's own colour: `tilemap.setColor` is ignored (with a
   * warning here; silently in Unity). `Tile` has this by default, as in Unity. Clear it
   * per cell with `tilemap.removeTileFlags(cell, TileFlags.LockColor)`, or for every cell of
   * a kind with `tile.flags = TileFlags.None` before painting it.
   */
  LockColor = 1,
  /** Unity: locks the cell's transform matrix. Accepted for Unity's sake; this engine has no per-cell transform yet. */
  LockTransform = 2,
  /** `LockColor | LockTransform`. */
  LockAll = 3,
  /** Unity: spawn the tile's GameObject in Play mode only. There is no edit mode here, so it changes nothing. */
  InstantiateGameObjectRuntimeOnly = 4,
  /** Unity: keep the spawned GameObject when the tile is replaced or erased. Not implemented: the object is removed. */
  KeepGameObjectRuntimeOnly = 8,
}

/** What a tile looks like in one particular cell. Unity: `TileData`. */
export interface TileData {
  /** Artwork. `null` draws the cell in a flat colour. */
  sprite: Sprite | null;
  /**
   * The cell's colour when the tile is painted, multiplied with the sprite. An alpha
   * below 1 makes the tile see-through. Same as Unity: `setColor` replaces it for one
   * cell, unless `flags` has `TileFlags.LockColor`.
   */
  color: Color;
  /** Something to spawn on the cell (a tree, a building). Removed with the tile. */
  gameObject: Prefab | GameObject | null;
  /**
   * What the tilemap may change about this cell. Leaving it out means `TileFlags.None`,
   * as a fresh Unity `TileData` has; `Tile` fills in its own `flags` (LockColor by default).
   */
  flags?: TileFlags;
}

/**
 * Base class for anything that can be painted into a Tilemap. Unity: `TileBase`.
 * Override `getTileData` to decide the look per cell, for example from the neighbouring
 * tiles ("rule tiles"). For ordinary tiles use `Tile`.
 */
export abstract class TileBase {
  name = 'Tile';

  abstract getTileData(cell: Vector3Int, tilemap: Tilemap): TileData;
}

/**
 * A simple tile: a colour, optional artwork, optional spawned object. Unity: `Tile`.
 * It plays the role of a ScriptableObject asset: create each kind once and reuse it.
 *
 * Game data rides along in `data`, which stands in for the fields of a custom Tile class
 * in Unity (climate, elevation, movement cost):
 *
 *   interface Terrain { moveCost: number; elevation: number }
 *   const forest = new Tile<Terrain>({ name: 'forest', color: Color.fromHex('#3c6e47'), data: { moveCost: 2, elevation: 1 } });
 *   terrain.getTile<Tile<Terrain>>(cell)?.data.moveCost
 *
 * A `TilePalette` makes these from a data file. Subclassing works too, when a tile needs
 * behaviour (see `getTileData`).
 */
export class Tile<Data = unknown> extends TileBase {
  sprite: Sprite | null = null;
  /** The colour of every cell painted with this tile (Unity: `Tile.color`). */
  color: Color = Color.white;
  gameObject: Prefab | GameObject | null = null;
  /**
   * Same as Unity: `TileFlags.LockColor` by default, so `tilemap.setColor` on a cell of
   * this tile does nothing until the lock is removed. Set `TileFlags.None` here (or pass
   * `flags` to the constructor) for a tile meant to be tinted cell by cell.
   */
  flags: TileFlags = TileFlags.LockColor;
  /** Whatever the game attaches to this kind of tile. */
  data: Data;

  constructor(
    init: {
      name?: string;
      sprite?: Sprite | null;
      color?: Color;
      gameObject?: Prefab | GameObject | null;
      flags?: TileFlags;
      data?: Data;
    } = {},
  ) {
    super();
    if (init.name !== undefined) this.name = init.name;
    if (init.sprite !== undefined) this.sprite = init.sprite;
    if (init.color !== undefined) this.color = init.color;
    if (init.gameObject !== undefined) this.gameObject = init.gameObject;
    if (init.flags !== undefined) this.flags = init.flags;
    this.data = init.data as Data;
  }

  /** Override to vary the look per cell; call `super.getTileData(cell, tilemap)` for the defaults. */
  getTileData(_cell: Vector3Int, _tilemap: Tilemap): TileData {
    return { sprite: this.sprite, color: this.color, gameObject: this.gameObject, flags: this.flags };
  }
}

/**
 * @internal Cells are grouped into square blocks of this many cells a side. A renderer
 * keeps one mesh per block, so changing a cell redoes its block rather than the map.
 */
export const TILEMAP_CHUNK_SIZE = 16;

/** @internal The block a cell belongs to. Every `z` of a cell shares its block. */
export function chunkKeyOf(cell: CellLike): string {
  return `${Math.floor(cell.x / TILEMAP_CHUNK_SIZE)},${Math.floor(cell.y / TILEMAP_CHUNK_SIZE)}`;
}

/** @internal One painted cell. */
export interface TilemapEntry {
  cell: Vector3Int;
  tile: TileBase;
  /** The colour `setColor` gave this cell; `null` until then (the tile's own colour shows). */
  color: Color | null;
  /** The cell's flags: the tile's when painted, then changed with `setTileFlags` and friends. */
  flags: TileFlags;
  /** The object spawned for this cell, if its tile asked for one. */
  instance: GameObject | null;
}

/**
 * A layer of tiles on a Grid. Unity: `Tilemap`.
 *
 * The Tilemap holds the data; add a `TilemapRenderer` to the same GameObject to draw it.
 * Several Tilemaps under one Grid are layers: terrain, highlights, fog of war.
 *
 *   const grid = new GameObject('Grid').addComponent(Grid);
 *   const layer = new GameObject('Terrain');
 *   layer.transform.setParent(grid.transform, false);
 *   const terrain = layer.addComponent(Tilemap);
 *   layer.addComponent(TilemapRenderer);
 *   terrain.setTile({ x: 2, y: 3 }, grassTile);
 *
 * Cells are `Vector3Int`s, but any `{ x, y }` object is accepted.
 */
export class Tilemap extends Behaviour {
  static readonly disallowMultiple = true;

  /** @internal */
  readonly _entries = new Map<string, TilemapEntry>();
  /** @internal The same entries by block (see `TILEMAP_CHUNK_SIZE`). */
  readonly _chunks = new Map<string, Set<TilemapEntry>>();
  /** @internal Bumped on every change. */
  _version = 0;
  /** @internal Blocks changed since a renderer last asked. `null` means all of them. */
  private dirtyChunks: Set<string> | null = null;
  private tint = Color.white;
  private warnedLockedColor = false;

  /**
   * @internal Hands over the blocks that changed since the last call (`null` for all of
   * them) and starts a fresh list.
   */
  _takeDirtyChunks(): Set<string> | null {
    const dirty = this.dirtyChunks;
    this.dirtyChunks = new Set();
    return dirty;
  }

  private touch(cell: CellLike): void {
    this.dirtyChunks?.add(chunkKeyOf(cell));
    this._version++;
  }

  private touchAll(): void {
    this.dirtyChunks = null;
    this._version++;
  }

  private index(entry: TilemapEntry): void {
    const key = chunkKeyOf(entry.cell);
    const chunk = this._chunks.get(key);
    if (chunk) chunk.add(entry);
    else this._chunks.set(key, new Set([entry]));
  }

  private unindex(entry: TilemapEntry): void {
    const key = chunkKeyOf(entry.cell);
    const chunk = this._chunks.get(key);
    if (chunk?.delete(entry) && chunk.size === 0) this._chunks.delete(key);
  }

  /**
   * The Grid this tilemap is laid out on: the nearest one on this object or its parents.
   * Throws if there is none. (Until a Grid exists, positions use Unity's default layout:
   * unit squares on the XY plane.)
   */
  get layoutGrid(): Grid {
    const grid = this.gameObject.getComponentInParent(Grid);
    if (!grid) {
      throw new Error(
        `Tilemap "${this.name}" has no Grid. Add a Grid component to it, or parent it under a GameObject that has one.`,
      );
    }
    return grid;
  }

  /** @internal The layout in effect right now. */
  get _shape(): GridShape {
    return this.gameObject.getComponentInParent(Grid)?._shape ?? DEFAULT_SHAPE;
  }

  /** @internal Changes whenever the layout does (a different Grid, or new settings on it). */
  get _layoutVersion(): string {
    const grid = this.gameObject.getComponentInParent(Grid);
    return grid ? `${grid.getInstanceId()}.${grid._version}` : 'none';
  }

  /**
   * Tint multiplied into every tile of this layer. Use the alpha to fade a whole layer.
   * Same as Unity's `Tilemap.color`.
   */
  get color(): Color {
    return this.tint;
  }

  set color(value: Color) {
    this.tint = value;
    this.touchAll();
  }

  // ---- Tiles --------------------------------------------------------------------------

  /**
   * Paints `tile` into a cell, or clears the cell with `null`. Same as Unity: the cell
   * takes the tile's colour and flags, so a colour set earlier with `setColor` is gone
   * (painting the same tile again changes nothing, and keeps it).
   */
  setTile(cell: CellLike, tile: TileBase | null): void {
    const key = cellKey(cell);
    const existing = this._entries.get(key);
    if (existing?.tile === tile || (!existing && !tile)) return;
    if (existing?.instance) destroy(existing.instance);
    if (existing) this.unindex(existing);
    if (!tile) {
      this._entries.delete(key);
    } else {
      const at = Vector3Int.from(cell);
      const flags = tile.getTileData(at, this).flags ?? TileFlags.None;
      const entry: TilemapEntry = { cell: at, tile, color: null, flags, instance: null };
      this._entries.set(key, entry);
      this.index(entry);
      this.spawn(entry);
    }
    this.touch(cell);
  }

  /** Paints several cells at once. `tiles` may be one tile for all of them. */
  setTiles(cells: readonly CellLike[], tiles: readonly (TileBase | null)[] | TileBase | null): void {
    cells.forEach((cell, index) => {
      this.setTile(cell, Array.isArray(tiles) ? (tiles[index] ?? null) : (tiles as TileBase | null));
    });
  }

  /**
   * Fills the rectangle of cells from `min` to `max`, both inclusive. Unity's
   * `BoxFill(position, tile, startX, startY, endX, endY)` takes other arguments; this one
   * is `boxFill(tile, min, max)`.
   */
  boxFill(tile: TileBase | null, min: CellLike, max: CellLike): void {
    const z = min.z ?? 0;
    for (let y = Math.min(min.y, max.y); y <= Math.max(min.y, max.y); y++) {
      for (let x = Math.min(min.x, max.x); x <= Math.max(min.x, max.x); x++) this.setTile({ x, y, z }, tile);
    }
  }

  /**
   * Replaces the connected area of identical tiles containing `cell` with `tile`, like a
   * paint bucket. Unity's `FloodFill` also fills an empty area from an empty cell; here it
   * only spreads through cells that already have a tile, and an empty `cell` does nothing.
   */
  floodFill(cell: CellLike, tile: TileBase | null): void {
    const target = this.getTile(cell);
    if (!target || target === tile) return;
    const neighbours = this._shape.cellLayout === CellLayout.Hexagon ? Hex.neighbors : Square.neighbors4;
    const pending = [Vector3Int.from(cell)];
    while (pending.length > 0) {
      const current = pending.pop() as Vector3Int;
      if (this.getTile(current) !== target) continue;
      this.setTile(current, tile);
      pending.push(...neighbours(current));
    }
  }

  /**
   * The tile in a cell, or `null`.
   *
   * With a class, `getTile(cell, DoorTile)`, it is checked: a tile of another kind gives
   * `null`, like C#'s `tilemap.GetTile(cell) as DoorTile`.
   *
   * The type parameter alone, `getTile<DoorTile>(cell)`, is only a cast for the compiler:
   * nothing is checked, and a grass tile comes back typed as a DoorTile. Unity's
   * `GetTile<T>()` does check (it is `as T`), so pass the class whenever the cell might
   * hold another kind. The type parameter is right for a `Tile<Data>` from a palette,
   * whose `Data` no class can check.
   */
  getTile<T extends TileBase = TileBase>(cell: CellLike): T | null;
  getTile<T extends TileBase>(cell: CellLike, type: abstract new (...args: never[]) => T): T | null;
  getTile<T extends TileBase>(cell: CellLike, type?: abstract new (...args: never[]) => T): T | null {
    const tile = this._entries.get(cellKey(cell))?.tile ?? null;
    if (type && !(tile instanceof type)) return null;
    return tile as T | null;
  }

  hasTile(cell: CellLike): boolean {
    return this._entries.has(cellKey(cell));
  }

  /** True if any cell uses `tile`. */
  containsTile(tile: TileBase): boolean {
    for (const entry of this._entries.values()) if (entry.tile === tile) return true;
    return false;
  }

  /** Replaces every `from` tile with `to`. */
  swapTile(from: TileBase, to: TileBase | null): void {
    for (const entry of [...this._entries.values()]) {
      if (entry.tile === from) this.setTile(entry.cell, to);
    }
  }

  clearAllTiles(): void {
    for (const entry of this._entries.values()) {
      if (entry.instance) destroy(entry.instance);
    }
    this._entries.clear();
    this._chunks.clear();
    this.touchAll();
  }

  // ---- Data in and out ------------------------------------------------------------------

  /**
   * Paints a layer from data (a JSON file, a Unity export, a saved game). `tiles` turns
   * each tile id into a tile: usually a `TilePalette`. Cells already painted outside the
   * layer's rectangle are left alone; call `clearAllTiles()` first to replace the lot.
   * The layer's tint, when it has one, becomes this tilemap's `color`.
   */
  loadLayer(layer: TilemapLayerData, tiles: { get(id: string): TileBase }): void {
    const resolved = layer.tiles.map((id) => tiles.get(id));
    const z = layer.z ?? 0;
    const [originX, originY] = layer.origin;
    for (let row = 0; row < layer.height; row++) {
      for (let column = 0; column < layer.width; column++) {
        const index = layer.cells[row * layer.width + column];
        const tile = index === undefined || index < 0 ? null : (resolved[index] ?? null);
        this.setTile({ x: originX + column, y: originY + row, z }, tile);
      }
    }
    if (layer.color !== undefined) this.color = Color.fromHex(layer.color);
  }

  /**
   * This layer as data, for saving or sending: the opposite of `loadLayer`. Tiles are
   * written by `name`, so each kind of tile needs a name of its own (a `TilePalette`
   * gives its tiles their ids). One z at a time: a tilemap painted on several z levels
   * is saved with one call per level.
   */
  toLayerData(name: string = this.name, z = 0): TilemapLayerData {
    const cells = [...this._entries.values()]
      .filter((entry) => entry.cell.z === z)
      .map((entry) => ({ x: entry.cell.x, y: entry.cell.y, z, tile: entry.tile.name }));
    const layer = encodeLayer(name, cells);
    if (!this.tint.equals(Color.white)) layer.color = this.tint.toHex();
    return layer;
  }

  /** Number of painted cells. */
  getUsedTilesCount(): number {
    return this._entries.size;
  }

  /** Every painted cell. An addition; in Unity you iterate `cellBounds.allPositionsWithin` and test `HasTile`. */
  getUsedCells(): Vector3Int[] {
    return [...this._entries.values()].map((entry) => entry.cell);
  }

  override _summary(): string {
    const count = this._entries.size;
    if (count === 0) return 'no tiles';
    const { min, max } = this.cellBounds;
    return `${count} tiles, cells (${min.x}, ${min.y}) to (${max.x - 1}, ${max.y - 1})`;
  }

  /**
   * The smallest box containing every painted cell. Unity's `cellBounds` can stay larger
   * after tiles are erased, until `CompressBounds()`; here it is always the tight box.
   */
  get cellBounds(): BoundsInt {
    if (this._entries.size === 0) return new BoundsInt();
    let min: Vector3Int | null = null;
    let max: Vector3Int | null = null;
    for (const { cell } of this._entries.values()) {
      min = min ? new Vector3Int(Math.min(min.x, cell.x), Math.min(min.y, cell.y), Math.min(min.z, cell.z)) : cell;
      max = max ? new Vector3Int(Math.max(max.x, cell.x), Math.max(max.y, cell.y), Math.max(max.z, cell.z)) : cell;
    }
    return BoundsInt.fromMinMax(min as Vector3Int, (max as Vector3Int).add(Vector3Int.one));
  }

  // ---- Per-cell colour and objects ----------------------------------------------------

  /**
   * Sets one cell's colour, in place of its tile's colour (not multiplied with it), as
   * Unity does. Useful for highlights and fog. An empty cell is left alone.
   *
   * Same as Unity: a cell whose flags include `TileFlags.LockColor` ignores this, and
   * `Tile` has that flag by default. Call `removeTileFlags(cell, TileFlags.LockColor)`
   * first, or give the tile `flags: TileFlags.None`. Unity ignores it silently; here the
   * first ignored call logs a warning. Painting the cell again (`setTile`) resets its colour.
   */
  setColor(cell: CellLike, color: Color): void {
    const entry = this._entries.get(cellKey(cell));
    if (!entry) return;
    if (entry.flags & TileFlags.LockColor) {
      if (!this.warnedLockedColor) {
        this.warnedLockedColor = true;
        Debug.logWarning(
          `Tilemap "${this.name}": setColor(${entry.cell.x}, ${entry.cell.y}) was ignored because the cell's tile has ` +
            'TileFlags.LockColor (every Tile has it by default; Unity ignores the call too). ' +
            'Call tilemap.removeTileFlags(cell, TileFlags.LockColor) first, or create the tile with flags: TileFlags.None.',
        );
      }
      return;
    }
    entry.color = color;
    this.touch(entry.cell);
  }

  /**
   * The colour a cell is drawn with, before the layer's `color`: what `setColor` gave
   * it, or else its tile's colour. Same as Unity. An empty cell gives white.
   */
  getColor(cell: CellLike): Color {
    const entry = this._entries.get(cellKey(cell));
    return entry ? this._cellColor(entry) : Color.white;
  }

  /** @internal The colour a cell shows: its own unless locked, else its tile's. */
  _cellColor(entry: TilemapEntry, data?: TileData): Color {
    if (entry.color && !(entry.flags & TileFlags.LockColor)) return entry.color;
    return (data ?? entry.tile.getTileData(entry.cell, this)).color;
  }

  /** The cell's `TileFlags` (`None` for an empty cell). Same as Unity's `GetTileFlags`. */
  getTileFlags(cell: CellLike): TileFlags {
    return this._entries.get(cellKey(cell))?.flags ?? TileFlags.None;
  }

  /** Replaces the cell's flags. Same as Unity: lasts until the cell is painted again. An empty cell is left alone. */
  setTileFlags(cell: CellLike, flags: TileFlags): void {
    const entry = this._entries.get(cellKey(cell));
    if (!entry || entry.flags === flags) return;
    entry.flags = flags;
    this.touch(entry.cell);
  }

  /** Adds flags to the cell's (bitwise or). Same as Unity's `AddTileFlags`. */
  addTileFlags(cell: CellLike, flags: TileFlags): void {
    this.setTileFlags(cell, this.getTileFlags(cell) | flags);
  }

  /** Removes flags from the cell's. `removeTileFlags(cell, TileFlags.LockColor)` lets `setColor` work. Same as Unity. */
  removeTileFlags(cell: CellLike, flags: TileFlags): void {
    this.setTileFlags(cell, this.getTileFlags(cell) & ~flags);
  }

  /** The GameObject a tile spawned on this cell, if any. */
  getInstantiatedObject(cell: CellLike): GameObject | null {
    const instance = this._entries.get(cellKey(cell))?.instance;
    return isAlive(instance) ? instance : null;
  }

  /**
   * Re-reads a tile's data, after something `getTileData` depends on has changed. Same as
   * Unity's `RefreshTile`. The cell's own colour and flags (set from code) are kept.
   */
  refreshTile(cell: CellLike): void {
    const entry = this._entries.get(cellKey(cell));
    if (!entry) return;
    if (entry.instance) destroy(entry.instance);
    entry.instance = null;
    this.spawn(entry);
    this.touch(entry.cell);
  }

  refreshAllTiles(): void {
    for (const entry of this._entries.values()) this.refreshTile(entry.cell);
    this.touchAll();
  }

  // ---- Positions (relative to this tilemap's own transform) -----------------------------

  cellToLocal(cell: CellLike): Vector3 {
    return cellToLocal(this._shape, cell);
  }

  localToCell(localPosition: Vector3): Vector3Int {
    return localToCell(this._shape, localPosition);
  }

  cellToWorld(cell: CellLike): Vector3 {
    return this.transform.transformPoint(this.cellToLocal(cell));
  }

  worldToCell(worldPosition: Vector3): Vector3Int {
    return this.localToCell(this.transform.inverseTransformPoint(worldPosition));
  }

  getCellCenterLocal(cell: CellLike): Vector3 {
    return cellCenterToLocal(this._shape, cell);
  }

  /** World position of the middle of a cell. */
  getCellCenterWorld(cell: CellLike): Vector3 {
    return this.transform.transformPoint(this.getCellCenterLocal(cell));
  }

  // ---- Internals ----------------------------------------------------------------------

  private spawn(entry: TilemapEntry): void {
    const source = entry.tile.getTileData(entry.cell, this).gameObject;
    if (!source) return;
    // Two calls only because `instantiate` is overloaded separately for prefabs and objects.
    const instance =
      source instanceof GameObject ? instantiate(source, this.transform) : instantiate(source, this.transform);
    instance.transform.localPosition = this.getCellCenterLocal(entry.cell);
    entry.instance = instance;
  }

  override _destroy(): void {
    this._entries.clear();
    this._chunks.clear();
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this.tint = source.tint;
    for (const [key, entry] of source._entries) {
      // Spawned objects are children, so they were cloned with the hierarchy.
      const copy = { ...entry, instance: entry.instance ? remap(entry.instance) : null };
      this._entries.set(key, copy);
      this.index(copy);
    }
    this.touchAll();
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Tilemap, 'Tilemap');
