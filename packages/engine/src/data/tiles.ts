import type { CellLike } from '../math/Vector3Int';

// The shapes of tile content as plain data: what a JSON file holds, what the Unity
// exporter (tools/unity) writes, and what game rules can read without a renderer.
// The components that draw it (`TilePalette`, `Tilemap`) are in '@synergy/engine'.

/** One sprite inside a sheet: a rectangle in pixels measured from the image's TOP-left. */
export interface SpriteData {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Origin as a fraction of the rectangle, (0, 0) bottom-left. Default the centre, [0.5, 0.5]. */
  pivot?: [number, number];
}

/** An image and the sprites cut from it. Unity: a texture imported in Sprite Mode "Multiple". */
export interface SpriteSheetData {
  /** The image file, relative to the palette file (or a key of the `images` given when loading). */
  image: string;
  /** Texture pixels per world unit. Default 100, as in Unity. */
  pixelsPerUnit?: number;
  /** Named rectangles. Refer to one as "sheet/name". */
  sprites?: Record<string, SpriteData>;
  /**
   * Instead of `sprites`: cut the image into a regular grid. The sprites are numbered
   * row by row from the top-left, and referred to as "sheet/0", "sheet/1", ...
   */
  columns?: number;
  rows?: number;
}

/**
 * One kind of tile. Unity: a Tile asset. `data` is where the fields of a custom Tile
 * class go (climate, elevation, movement cost): whatever the game wants to know about
 * terrain of this kind.
 */
export interface TileDefinition<Data = Record<string, unknown>> {
  /** Unique and stable: maps refer to tiles by it. From Unity, the asset's name. */
  id: string;
  /** "sheet/sprite" in the palette's sheets, or just "sheet" for a whole image. Omit for a flat colour. */
  sprite?: string;
  /** Tint as '#rrggbb' or '#rrggbbaa'. Default white. */
  color?: string;
  data?: Data;
}

/** The tiles a map is painted with, and the artwork they use. Unity: the Tile assets behind a Tile Palette. */
export interface TilePaletteData<Data = Record<string, unknown>> {
  sheets?: Record<string, SpriteSheetData>;
  tiles: TileDefinition<Data>[];
}

/**
 * One layer of a map: a rectangle of cells, each empty or holding a tile. Unity: one
 * Tilemap under a Grid.
 *
 * Cells are stored compactly. `tiles` lists the tile ids the layer uses, and `cells`
 * holds one index into that list per cell (-1 for empty), row by row starting at
 * `origin`, with x running fastest: the cell (origin.x + i, origin.y + j) is at
 * `cells[j * width + i]`.
 */
export interface TilemapLayerData {
  name: string;
  /** Which layer draws on top. Default 0. */
  sortingOrder?: number;
  /** The cells' z (Unity's third cell coordinate). Default 0. */
  z?: number;
  /** Tint for the whole layer, '#rrggbb' or '#rrggbbaa'. Default white. */
  color?: string;
  tiles: string[];
  /** The cell of the first entry in `cells`: [x, y]. */
  origin: [number, number];
  width: number;
  height: number;
  cells: number[];
}

/** A whole map: the grid's shape and its layers. Unity: a Grid with Tilemaps under it. */
export interface TilemapData {
  grid: {
    /** 'rectangle' or 'hexagon' (`CellLayout`). */
    cellLayout: string;
    /** 'xyz', 'xzy', ... (`CellSwizzle`). Default 'xyz'. */
    cellSwizzle?: string;
    cellSize: [number, number, number];
    cellGap?: [number, number, number];
  };
  layers: TilemapLayerData[];
}

/** A painted cell of a layer. */
export interface LayerCell {
  x: number;
  y: number;
  z: number;
  /** The tile's id. */
  tile: string;
}

/** The tile id in a cell of a layer, or `null` when the cell is empty or outside the layer. */
export function layerTileAt(layer: TilemapLayerData, cell: CellLike): string | null {
  if ((cell.z ?? 0) !== (layer.z ?? 0)) return null;
  const column = cell.x - layer.origin[0];
  const row = cell.y - layer.origin[1];
  if (column < 0 || row < 0 || column >= layer.width || row >= layer.height) return null;
  const index = layer.cells[row * layer.width + column];
  return index === undefined || index < 0 ? null : (layer.tiles[index] ?? null);
}

/** Every painted cell of a layer, row by row. */
export function layerCells(layer: TilemapLayerData): LayerCell[] {
  const cells: LayerCell[] = [];
  const z = layer.z ?? 0;
  for (let row = 0; row < layer.height; row++) {
    for (let column = 0; column < layer.width; column++) {
      const index = layer.cells[row * layer.width + column];
      const tile = index === undefined || index < 0 ? undefined : layer.tiles[index];
      if (tile !== undefined) cells.push({ x: layer.origin[0] + column, y: layer.origin[1] + row, z, tile });
    }
  }
  return cells;
}

/**
 * Packs painted cells into a layer: the opposite of `layerCells`. The rectangle is the
 * smallest that holds every cell. Cells must share one `z`.
 */
export function encodeLayer(
  name: string,
  cells: Iterable<{ x: number; y: number; z?: number; tile: string }>,
  options: { sortingOrder?: number; color?: string } = {},
): TilemapLayerData {
  const list = [...cells];
  const layer: TilemapLayerData = { name, tiles: [], origin: [0, 0], width: 0, height: 0, cells: [] };
  if (options.sortingOrder !== undefined) layer.sortingOrder = options.sortingOrder;
  if (options.color !== undefined) layer.color = options.color;
  const first = list[0];
  if (!first) return layer;
  const z = first.z ?? 0;
  if (z !== 0) layer.z = z;
  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;
  for (const cell of list) {
    if ((cell.z ?? 0) !== z)
      throw new Error(`Layer "${name}" mixes cells with z ${z} and z ${cell.z ?? 0}. Save each z as its own layer.`);
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }
  layer.origin = [minX, minY];
  layer.width = maxX - minX + 1;
  layer.height = maxY - minY + 1;
  layer.cells = Array.from({ length: layer.width * layer.height }, () => -1);
  const indexOf = new Map<string, number>();
  for (const cell of list) {
    let index = indexOf.get(cell.tile);
    if (index === undefined) {
      index = layer.tiles.push(cell.tile) - 1;
      indexOf.set(cell.tile, index);
    }
    layer.cells[(cell.y - minY) * layer.width + (cell.x - minX)] = index;
  }
  return layer;
}

const isNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item));

/**
 * Looks for mistakes in map data and returns one sentence per problem (an empty list
 * when it is sound). Pass the palette's tile ids to also catch tiles the map uses but
 * the palette does not define. Run it in a test over every map file you ship.
 */
export function checkTilemapData(data: TilemapData, knownTiles?: Iterable<string>): string[] {
  const problems: string[] = [];
  const grid = data?.grid;
  if (!grid || typeof grid !== 'object') return ['The map has no "grid".'];
  if (grid.cellLayout !== 'rectangle' && grid.cellLayout !== 'hexagon') {
    problems.push(
      `grid.cellLayout is ${JSON.stringify(grid.cellLayout)}; only "rectangle" and "hexagon" are supported.`,
    );
  }
  if (grid.cellSwizzle !== undefined && !['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'].includes(grid.cellSwizzle)) {
    problems.push(
      `grid.cellSwizzle is ${JSON.stringify(grid.cellSwizzle)}; expected one of xyz, xzy, yxz, yzx, zxy, zyx.`,
    );
  }
  if (!isNumbers(grid.cellSize, 3)) problems.push('grid.cellSize must be three numbers: [x, y, z].');
  if (grid.cellGap !== undefined && !isNumbers(grid.cellGap, 3))
    problems.push('grid.cellGap must be three numbers: [x, y, z].');
  if (!Array.isArray(data.layers)) return [...problems, 'The map has no "layers" list.'];

  const known = knownTiles ? new Set(knownTiles) : null;
  const names = new Set<string>();
  for (const layer of data.layers) {
    const label = `Layer "${layer?.name}"`;
    if (typeof layer?.name !== 'string' || layer.name === '') {
      problems.push('A layer has no name.');
      continue;
    }
    if (names.has(layer.name)) problems.push(`Two layers are named "${layer.name}".`);
    names.add(layer.name);
    if (!isNumbers(layer.origin, 2)) problems.push(`${label}: origin must be two numbers: [x, y].`);
    if (!Number.isInteger(layer.width) || !Number.isInteger(layer.height) || layer.width < 0 || layer.height < 0) {
      problems.push(`${label}: width and height must be whole numbers, zero or more.`);
      continue;
    }
    if (!Array.isArray(layer.cells) || layer.cells.length !== layer.width * layer.height) {
      const length = Array.isArray(layer.cells) ? layer.cells.length : 'no';
      problems.push(
        `${label}: has ${length} cells, but ${layer.width} x ${layer.height} needs ${layer.width * layer.height}.`,
      );
      continue;
    }
    if (!Array.isArray(layer.tiles)) {
      problems.push(`${label}: has no "tiles" list.`);
      continue;
    }
    const bad = layer.cells.find((index) => !Number.isInteger(index) || index < -1 || index >= layer.tiles.length);
    if (bad !== undefined) {
      problems.push(
        `${label}: a cell holds ${bad}, which is not -1 (empty) or an index into its ${layer.tiles.length} tiles.`,
      );
    }
    if (known) {
      const missing = layer.tiles.filter((id) => !known.has(id));
      if (missing.length > 0) problems.push(`${label}: uses tiles the palette does not define: ${missing.join(', ')}.`);
    }
  }
  return problems;
}

/**
 * Looks for mistakes in palette data and returns one sentence per problem. Catches the
 * things that otherwise show up as a blank or wrong tile: duplicate ids, a tile whose
 * sprite or sheet does not exist.
 */
export function checkTilePaletteData(data: TilePaletteData<unknown>): string[] {
  const problems: string[] = [];
  if (!data || !Array.isArray(data.tiles)) return ['The palette has no "tiles" list.'];
  const sheets = data.sheets ?? {};
  for (const [name, sheet] of Object.entries(sheets)) {
    if (typeof sheet.image !== 'string' || sheet.image === '') problems.push(`Sheet "${name}" has no "image".`);
    if (sheet.sprites && (sheet.columns !== undefined || sheet.rows !== undefined)) {
      problems.push(`Sheet "${name}" has both "sprites" and "columns"/"rows"; use one or the other.`);
    }
    if ((sheet.columns === undefined) !== (sheet.rows === undefined)) {
      problems.push(`Sheet "${name}" needs both "columns" and "rows" to be cut into a grid.`);
    }
  }
  const ids = new Set<string>();
  for (const tile of data.tiles) {
    if (typeof tile?.id !== 'string' || tile.id === '') {
      problems.push(`A tile has no "id": ${JSON.stringify(tile)}.`);
      continue;
    }
    if (ids.has(tile.id)) problems.push(`Two tiles share the id "${tile.id}".`);
    ids.add(tile.id);
    if (tile.color !== undefined && !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(tile.color)) {
      problems.push(`Tile "${tile.id}": color ${JSON.stringify(tile.color)} is not '#rrggbb' or '#rrggbbaa'.`);
    }
    if (tile.sprite === undefined) continue;
    const { sheet: sheetName, sprite } = splitSpritePath(tile.sprite);
    const sheet = sheets[sheetName];
    if (!sheet) {
      problems.push(
        `Tile "${tile.id}": sprite "${tile.sprite}" names the sheet "${sheetName}", which the palette does not have.`,
      );
    } else if (sprite !== null) {
      const count = sheet.columns !== undefined && sheet.rows !== undefined ? sheet.columns * sheet.rows : null;
      const exists =
        count !== null ? /^\d+$/.test(sprite) && Number(sprite) < count : sheet.sprites?.[sprite] !== undefined;
      if (!exists) problems.push(`Tile "${tile.id}": sheet "${sheetName}" has no sprite "${sprite}".`);
    }
  }
  return problems;
}

/** Splits "sheet/sprite" at the first slash. A path with no slash is a whole sheet. */
export function splitSpritePath(path: string): { sheet: string; sprite: string | null } {
  const slash = path.indexOf('/');
  return slash < 0 ? { sheet: path, sprite: null } : { sheet: path.slice(0, slash), sprite: path.slice(slash + 1) };
}
