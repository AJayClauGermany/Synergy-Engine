import { Assets } from '../assets/Assets';
import type { Texture } from '../components/rendering';
import { Sprite } from '../components/Sprite';
import { GameObject } from '../core/GameObject';
import type { Transform } from '../core/Transform';
import { Catalog } from '../data/Catalog';
import {
  checkTilemapData,
  checkTilePaletteData,
  splitSpritePath,
  type SpriteSheetData,
  type TilemapData,
  type TilePaletteData,
} from '../data/tiles';
import type { CellLayout, CellSwizzle } from '../grid/layout';
import { Color } from '../math/Color';
import { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';
import { Grid } from './Grid';
import { Tile, Tilemap } from './Tilemap';
import { TilemapRenderer } from './TilemapRenderer';

/** Where a palette's images come from. */
export interface TilePaletteLoadOptions {
  /** The folder (or page) the sheets' `image` paths are relative to. Default: the page. */
  baseUrl?: string;
  /**
   * URLs for images by the name the palette uses, for files the bundler renamed:
   *
   *   import terrainUrl from './terrain.png' with { type: 'file' };
   *   TilePalette.load(data, { images: { 'terrain.png': terrainUrl } })
   */
  images?: Record<string, string>;
}

function fail(what: string, problems: string[]): never {
  throw new Error(`${what} has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:\n  - ${problems.join('\n  - ')}`);
}

function spritesOf(sheet: SpriteSheetData, texture: Texture): Map<string | null, Sprite> {
  const pixelsPerUnit = sheet.pixelsPerUnit;
  const sprites = new Map<string | null, Sprite>([[null, new Sprite(texture, undefined, { pixelsPerUnit })]]);
  if (sheet.columns !== undefined && sheet.rows !== undefined) {
    Sprite.slice(texture, sheet.columns, sheet.rows, { pixelsPerUnit }).forEach((sprite, index) => sprites.set(String(index), sprite));
  }
  for (const [name, rect] of Object.entries(sheet.sprites ?? {})) {
    const pivot = rect.pivot ? new Vector2(rect.pivot[0], rect.pivot[1]) : undefined;
    sprites.set(name, new Sprite(texture, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { pivot, pixelsPerUnit }));
  }
  return sprites;
}

/**
 * The tiles a map is painted with, made from data. Unity: the Tile assets you pick from
 * in the Tile Palette window. Each definition becomes a `Tile` whose `name` is its id
 * and whose `data` is the definition's `data`.
 *
 *   import tiles from './data/tiles.json';
 *   interface Terrain { climate: string; elevation: number; moveCost: number }
 *
 *   const palette = await TilePalette.load<Terrain>(tiles, { baseUrl: '/content/' });
 *   terrain.setTile({ x: 2, y: 3 }, palette.get('grass'));
 *   palette.get('grass').data.elevation
 *
 * The same data file serves game rules without a renderer: see `Catalog` and the tile
 * helpers in '@synergy/engine/data'.
 */
export class TilePalette<Data = Record<string, unknown>> {
  private readonly catalog = new Catalog<{ id: string; tile: Tile<Data> }>('tile');
  private readonly sheets = new Map<string, Map<string | null, Sprite>>();

  private constructor(data: TilePaletteData<Data>, textures: Record<string, Texture>) {
    const problems = checkTilePaletteData(data);
    if (problems.length > 0) fail('The tile palette', problems);
    for (const [name, sheet] of Object.entries(data.sheets ?? {})) {
      const texture = textures[name];
      if (texture) this.sheets.set(name, spritesOf(sheet, texture));
    }
    for (const definition of data.tiles) {
      const tile = new Tile<Data>({
        name: definition.id,
        color: definition.color ? Color.fromHex(definition.color) : Color.white,
        sprite: definition.sprite ? this.sprite(definition.sprite) : null,
        data: definition.data,
      });
      this.catalog.add({ id: definition.id, tile });
    }
  }

  /**
   * Makes a palette from textures you already have, keyed by sheet name. A sheet with
   * no texture gives its tiles no artwork: they draw in their flat colour. That is what
   * a headless test wants, where no image can be decoded: `TilePalette.create(data)`.
   */
  static create<Data = Record<string, unknown>>(data: TilePaletteData<Data>, textures: Record<string, Texture> = {}): TilePalette<Data> {
    return new TilePalette(data, textures);
  }

  /** Loads the palette's images, then makes it. Use this in a scene's `preload`. */
  static async load<Data = Record<string, unknown>>(
    data: TilePaletteData<Data>,
    options: TilePaletteLoadOptions = {},
  ): Promise<TilePalette<Data>> {
    const problems = checkTilePaletteData(data);
    if (problems.length > 0) fail('The tile palette', problems);
    const textures: Record<string, Texture> = {};
    await Promise.all(
      Object.entries(data.sheets ?? {}).map(async ([name, sheet]) => {
        const url = options.images?.[sheet.image] ?? (options.baseUrl ? new URL(sheet.image, new URL(options.baseUrl, globalThis.location?.href)).href : sheet.image);
        textures[name] = await Assets.loadTexture(url);
      }),
    );
    return new TilePalette(data, textures);
  }

  /** Fetches a palette JSON file and loads it; image paths are relative to that file. */
  static async fromUrl<Data = Record<string, unknown>>(url: string): Promise<TilePalette<Data>> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the tile palette "${url}": ${response.status} ${response.statusText}.`);
    return TilePalette.load((await response.json()) as TilePaletteData<Data>, { baseUrl: url });
  }

  /** The tile with this id. Throws, naming the ids that exist, when there is none. */
  get(id: string): Tile<Data> {
    return this.catalog.get(id).tile;
  }

  has(id: string): boolean {
    return this.catalog.has(id);
  }

  /** Every tile id, in the order the data lists them. */
  get ids(): string[] {
    return this.catalog.ids;
  }

  get tiles(): Tile<Data>[] {
    return this.catalog.all.map((entry) => entry.tile);
  }

  /** A sprite by "sheet/name" (or "sheet" for the whole image), or `null` if that sheet has no texture loaded. */
  sprite(path: string): Sprite | null {
    const { sheet, sprite } = splitSpritePath(path);
    return this.sheets.get(sheet)?.get(sprite) ?? null;
  }
}

/** What `createTilemaps` made. */
export interface BuiltTilemaps {
  grid: Grid;
  /** The layers in the order the data lists them. */
  tilemaps: Tilemap[];
  /** A layer by name. Throws when the map has no such layer. */
  layer(name: string): Tilemap;
}

/**
 * Builds a whole map from data: a GameObject with a `Grid`, and under it one child with
 * a `Tilemap` and `TilemapRenderer` per layer. Unity: opening a scene that holds a Grid
 * with Tilemaps painted in the editor.
 *
 *   import map from './data/map.json';
 *   const { grid, layer } = createTilemaps(map, palette, { name: 'Board' });
 *   unit.transform.position = grid.getCellCenterWorld({ x: 4, y: 3 });
 *   layer('Terrain').getTile<Tile<Terrain>>(cell)?.data.moveCost
 *
 * The data is checked first, and every problem is reported at once.
 */
export function createTilemaps(
  data: TilemapData,
  tiles: { get(id: string): Tile<unknown>; ids?: string[] },
  options: { name?: string; parent?: Transform | null } = {},
): BuiltTilemaps {
  const problems = checkTilemapData(data, tiles.ids);
  if (problems.length > 0) fail(`The map "${options.name ?? 'Grid'}"`, problems);

  const root = new GameObject(options.name ?? 'Grid');
  if (options.parent) root.transform.setParent(options.parent, false);
  const grid = root.addComponent(Grid);
  grid.cellLayout = data.grid.cellLayout as CellLayout;
  if (data.grid.cellSwizzle) grid.cellSwizzle = data.grid.cellSwizzle as CellSwizzle;
  grid.cellSize = new Vector3(...data.grid.cellSize);
  if (data.grid.cellGap) grid.cellGap = new Vector3(...data.grid.cellGap);

  const byName = new Map<string, Tilemap>();
  const tilemaps = data.layers.map((layer) => {
    const child = new GameObject(layer.name);
    child.transform.setParent(root.transform, false);
    const tilemap = child.addComponent(Tilemap);
    child.addComponent(TilemapRenderer).sortingOrder = layer.sortingOrder ?? 0;
    tilemap.loadLayer(layer, tiles);
    byName.set(layer.name, tilemap);
    return tilemap;
  });
  return {
    grid,
    tilemaps,
    layer(name: string): Tilemap {
      const found = byName.get(name);
      if (!found) throw new Error(`The map has no layer "${name}". Its layers: ${[...byName.keys()].join(', ') || '(none)'}.`);
      return found;
    },
  };
}

/**
 * A map as data: the grid's shape and every Tilemap under it, for saving a map made or
 * edited in the game. The opposite of `createTilemaps`.
 */
export function tilemapsToData(grid: Grid): TilemapData {
  const data: TilemapData = {
    grid: { cellLayout: grid.cellLayout, cellSwizzle: grid.cellSwizzle, cellSize: grid.cellSize.toArray() },
    layers: [],
  };
  if (grid.cellGap.sqrMagnitude > 0) data.grid.cellGap = grid.cellGap.toArray();
  for (const tilemap of grid.gameObject.getComponentsInChildren(Tilemap, true)) {
    const layer = tilemap.toLayerData();
    const sortingOrder = tilemap.getComponent(TilemapRenderer)?.sortingOrder ?? 0;
    if (sortingOrder !== 0) layer.sortingOrder = sortingOrder;
    data.layers.push(layer);
  }
  return data;
}
