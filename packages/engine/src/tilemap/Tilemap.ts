import { Behaviour } from '../core/Component';
import { isAlive } from '../core/EngineObject';
import { GameObject } from '../core/GameObject';
import { destroy, instantiate, type Prefab } from '../core/Object';
import { Hex, Square } from '../grid/hex';
import {
  CellLayout,
  cellCenterToLocal,
  cellToLocal,
  defaultGridShape,
  type GridShape,
  localToCell,
} from '../grid/layout';
import { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { BoundsInt, type CellLike, cellKey, Vector3Int } from '../math/Vector3Int';
import type { Texture } from '../components/rendering';
import { Grid } from './Grid';

const DEFAULT_SHAPE: Readonly<GridShape> = Object.freeze(defaultGridShape());

/**
 * A rectangular piece of a texture. Unity: `Sprite`. Tiles use it for their artwork.
 *
 *   const sheet = await Assets.loadTexture(terrainUrl);
 *   const [grass, sand, water] = Sprite.slice(sheet, 3, 1);
 */
export class Sprite {
  /** UV coordinates of the rectangle's edges: left, bottom, right, top. */
  readonly uv: readonly [u0: number, v0: number, u1: number, v1: number];

  /**
   * `rect` is in pixels with the origin at the image's TOP-left, as in image editors.
   * (Unity measures sprite rects from the bottom-left.) Omit it to use the whole texture.
   */
  constructor(
    readonly texture: Texture,
    readonly rect?: { x: number; y: number; width: number; height: number },
  ) {
    if (!rect) {
      this.uv = [0, 0, 1, 1];
    } else {
      const width = texture.width || 1;
      const height = texture.height || 1;
      this.uv = [
        rect.x / width,
        1 - (rect.y + rect.height) / height,
        (rect.x + rect.width) / width,
        1 - rect.y / height,
      ];
    }
  }

  /** Cuts a sprite sheet into `columns` x `rows` equal sprites, row by row from the top-left. */
  static slice(texture: Texture, columns: number, rows: number): Sprite[] {
    const width = texture.width / columns;
    const height = texture.height / rows;
    const sprites: Sprite[] = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        sprites.push(new Sprite(texture, { x: column * width, y: row * height, width, height }));
      }
    }
    return sprites;
  }
}

/** What a tile looks like in one particular cell. Unity: `TileData`. */
export interface TileData {
  /** Artwork. `null` draws the cell in a flat colour. */
  sprite: Sprite | null;
  /** Tint, multiplied with the sprite. An alpha below 1 makes the tile see-through. */
  color: Color;
  /** Something to spawn on the cell (a tree, a building). Removed with the tile. */
  gameObject: Prefab | GameObject | null;
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
 * Subclass it to attach game data to terrain:
 *
 *   class TerrainTile extends Tile { moveCost = 1; }
 *   const forest = new TerrainTile({ name: 'Forest', color: Color.fromHex('#3c6e47') });
 *   forest.moveCost = 2;
 *   terrain.getTile<TerrainTile>(cell)?.moveCost
 */
export class Tile extends TileBase {
  sprite: Sprite | null = null;
  color: Color = Color.white;
  gameObject: Prefab | GameObject | null = null;

  constructor(init: { name?: string; sprite?: Sprite | null; color?: Color; gameObject?: Prefab | GameObject | null } = {}) {
    super();
    if (init.name !== undefined) this.name = init.name;
    if (init.sprite !== undefined) this.sprite = init.sprite;
    if (init.color !== undefined) this.color = init.color;
    if (init.gameObject !== undefined) this.gameObject = init.gameObject;
  }

  getTileData(): TileData {
    return { sprite: this.sprite, color: this.color, gameObject: this.gameObject };
  }
}

/** @internal One painted cell. */
export interface TilemapEntry {
  cell: Vector3Int;
  tile: TileBase;
  /** Per-cell tint set with `setColor`. */
  color: Color | null;
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
  /** @internal Bumped on every change, so the renderer knows to rebuild. */
  _version = 0;
  private tint = Color.white;

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

  /** Tint applied to every tile in this layer. Use the alpha to fade a whole layer. */
  get color(): Color {
    return this.tint;
  }

  set color(value: Color) {
    this.tint = value;
    this._version++;
  }

  // ---- Tiles --------------------------------------------------------------------------

  /** Paints `tile` into a cell, or clears the cell with `null`. */
  setTile(cell: CellLike, tile: TileBase | null): void {
    const key = cellKey(cell);
    const existing = this._entries.get(key);
    if (existing?.tile === tile || (!existing && !tile)) return;
    if (existing?.instance) destroy(existing.instance);
    if (!tile) {
      this._entries.delete(key);
    } else {
      const entry: TilemapEntry = { cell: Vector3Int.from(cell), tile, color: existing?.color ?? null, instance: null };
      this._entries.set(key, entry);
      this.spawn(entry);
    }
    this._version++;
  }

  /** Paints several cells at once. `tiles` may be one tile for all of them. */
  setTiles(cells: readonly CellLike[], tiles: readonly (TileBase | null)[] | TileBase | null): void {
    cells.forEach((cell, index) => {
      this.setTile(cell, Array.isArray(tiles) ? (tiles[index] ?? null) : (tiles as TileBase | null));
    });
  }

  /** Fills the rectangle of cells from `min` to `max`, both inclusive. */
  boxFill(tile: TileBase | null, min: CellLike, max: CellLike): void {
    const z = min.z ?? 0;
    for (let y = Math.min(min.y, max.y); y <= Math.max(min.y, max.y); y++) {
      for (let x = Math.min(min.x, max.x); x <= Math.max(min.x, max.x); x++) this.setTile({ x, y, z }, tile);
    }
  }

  /**
   * Replaces the connected area of identical tiles containing `cell` with `tile`, like a
   * paint bucket. It only spreads through cells that already have a tile.
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

  /** The tile in a cell, or `null`. Pass your tile class to get it typed: `getTile<TerrainTile>(cell)`. */
  getTile<T extends TileBase = TileBase>(cell: CellLike): T | null {
    return (this._entries.get(cellKey(cell))?.tile as T | undefined) ?? null;
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
    this._version++;
  }

  /** Number of painted cells. */
  getUsedTilesCount(): number {
    return this._entries.size;
  }

  /** Every painted cell. (Unity: iterate `cellBounds.allPositionsWithin` and test `HasTile`.) */
  getUsedCells(): Vector3Int[] {
    return [...this._entries.values()].map((entry) => entry.cell);
  }

  /** The smallest box containing every painted cell. */
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

  /** Tints one cell, on top of its tile's colour. Useful for highlights and fog. */
  setColor(cell: CellLike, color: Color): void {
    const entry = this._entries.get(cellKey(cell));
    if (!entry) return;
    entry.color = color;
    this._version++;
  }

  getColor(cell: CellLike): Color {
    return this._entries.get(cellKey(cell))?.color ?? Color.white;
  }

  /** The GameObject a tile spawned on this cell, if any. */
  getInstantiatedObject(cell: CellLike): GameObject | null {
    const instance = this._entries.get(cellKey(cell))?.instance;
    return isAlive(instance) ? instance : null;
  }

  /** Re-reads a tile's data, after something `getTileData` depends on has changed. */
  refreshTile(cell: CellLike): void {
    const entry = this._entries.get(cellKey(cell));
    if (!entry) return;
    if (entry.instance) destroy(entry.instance);
    entry.instance = null;
    this.spawn(entry);
    this._version++;
  }

  refreshAllTiles(): void {
    for (const entry of this._entries.values()) this.refreshTile(entry.cell);
    this._version++;
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
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this.tint = source.tint;
    for (const [key, entry] of source._entries) {
      // Spawned objects are children, so they were cloned with the hierarchy.
      this._entries.set(key, { ...entry, instance: entry.instance ? remap(entry.instance) : null });
    }
    this._version++;
  }
}
