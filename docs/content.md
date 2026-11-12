# Content as data

In Unity, a lot of a game is not code: ScriptableObject assets hold the numbers, Tile
assets hold the terrain, and scenes hold painted Tilemaps. Here that content is plain
data (JSON files or TypeScript objects) loaded at startup. Change a number, save, and
the dev server reloads the game.

| Unity | Synergy |
|-------|---------|
| ScriptableObject asset | a record in a `Catalog`, looked up by `id` (the asset's name) |
| Tile asset (sprite, colour, fields of a custom Tile class) | a tile definition in a palette file; at run time a `Tile` with `data` |
| The Tile assets behind a Tile Palette | `TilePalette` |
| Sprite sheet (texture sliced into sprites) | a `sheet` in the palette file |
| Grid with painted Tilemaps in a scene | a map file; `createTilemaps(map, palette)` |
| Editing in the Inspector / painting in the Scene view | editing the file |

Everything on this page that does not draw is in `@synergy/engine/data`, which has no
renderer attached: game rules, tests and servers read the same files.

To get existing content out of a Unity project, see
[`tools/unity/README.md`](../tools/unity/README.md).

## Definitions: `Catalog`

```ts
import { Catalog } from '@synergy/engine/data';

export interface UnitType { id: string; maxHealth: number; moveRange: number; sight: number }

export const unitTypes = new Catalog<UnitType>('unit type', [
  { id: 'scout', maxHealth: 6, moveRange: 4, sight: 3 },
  { id: 'guard', maxHealth: 10, moveRange: 2, sight: 2 },
]);

unitTypes.get('scout').moveRange   // 4
unitTypes.get('scuot')             // throws: There is no unit type "scuot". Did you mean "scout"? Known unit types: scout, guard.
```

The list can be written in TypeScript as above (type-checked as you type) or imported
from JSON (`new Catalog<UnitType>('unit type', data)`). Refer to content by `id`
everywhere it is stored or sent: in maps, saves and `NetworkVariable`s. Duplicate and
empty ids are refused when the catalog is made.

## Tiles: the palette file

```json
{
  "sheets": {
    "terrain": {
      "image": "terrain.png",
      "pixelsPerUnit": 64,
      "sprites": { "grass_0": { "x": 0, "y": 0, "width": 64, "height": 64 } }
    },
    "props": { "image": "props.png", "columns": 4, "rows": 2 }
  },
  "tiles": [
    { "id": "grass", "sprite": "terrain/grass_0", "data": { "climate": "temperate", "elevation": 1, "moveCost": 1 } },
    { "id": "rock", "sprite": "props/5", "color": "#ddddddff", "data": { "climate": "temperate", "elevation": 3, "moveCost": 9 } },
    { "id": "fog", "color": "#10182080" }
  ]
}
```

- A **sheet** is an image and the sprites cut from it: named rectangles in pixels from the
  image's top-left, or a regular grid (`columns`, `rows`) whose sprites are numbered from
  0 row by row. `pixelsPerUnit` and a per-sprite `pivot` matter when the same sprites are
  used by a `SpriteRenderer`; a tile always fills its cell.
- A **tile** has an `id`, optionally a `sprite` (`"sheet/name"`, or `"sheet"` for the whole
  image) and a `color` tint (`#rrggbb` or `#rrggbbaa`), and `data`: whatever the game
  wants to know about that kind of terrain.

```ts
interface Terrain { climate: string; elevation: number; moveCost: number }

const palette = await TilePalette.load<Terrain>(tiles, { baseUrl: '/content/' });   // loads the images
const palette = TilePalette.create<Terrain>(tiles);                                  // no images: flat colours, for tests
const palette = await TilePalette.fromUrl<Terrain>('/content/tiles.json');           // fetches the file too

palette.get('grass')                  // a Tile: paint with it
palette.get('grass').data.elevation   // 1
```

When the images are bundled rather than served from `game/public`, pass their URLs:

```ts
import terrainUrl from './data/terrain.png' with { type: 'file' };
await TilePalette.load(tiles, { images: { 'terrain.png': terrainUrl } });
```

## Maps: the map file

```json
{
  "grid": { "cellLayout": "hexagon", "cellSwizzle": "xzy", "cellSize": [1, 1.1547, 1] },
  "layers": [
    {
      "name": "Terrain",
      "tiles": ["grass", "rock"],
      "origin": [0, 0], "width": 4, "height": 2,
      "cells": [0, 0, 1, 0,
                0, -1, 0, 0]
    }
  ]
}
```

A layer is a rectangle of cells. `tiles` lists the ids it uses and `cells` holds one
index into that list per cell, `-1` for an empty cell, row by row from `origin` with x
running fastest. Optional per layer: `sortingOrder`, `z`, `color`. Hexagonal maps use
Unity's cell coordinates.

```ts
const { grid, layer } = createTilemaps(map, palette, { name: 'Board' });
const terrain = layer('Terrain');                                   // a Tilemap
terrain.getTile<Tile<Terrain>>({ x: 2, y: 0 })?.data.moveCost       // 9

tilemapsToData(grid)                  // the map as data again, to save one edited in the game
terrain.toLayerData()                 // one layer
terrain.loadLayer(layerData, palette) // paint one layer into an existing Tilemap
```

`createTilemaps` makes a GameObject with a `Grid` and one child per layer (`Tilemap` +
`TilemapRenderer`). Maps of tens of thousands of cells are fine: see "Editing" in
[tilemaps.md](tilemaps.md).

## Reading maps in rules

Rules that run without the engine read the same files through pure helpers:

```ts
import { Catalog, layerNamed, layerTileAt, type TilemapData, type TilePaletteData } from '@synergy/engine/data';

const terrainTypes = new Catalog('tile', (tiles as TilePaletteData<Terrain>).tiles);
const ground = layerNamed(map as TilemapData, 'Terrain');   // throws, naming the layers, if there is none

export function moveCost(cell: Cell): number {
  const id = layerTileAt(ground, cell);            // null outside the map or on an empty cell
  return id ? (terrainTypes.get(id).data?.moveCost ?? 1) : Infinity;
}
```

`layerCells(layer)` lists every painted cell; `encodeLayer(name, cells)` packs cells back
into a layer.

## Catching bad data

A wrong id or a miscounted row should fail a test, not show up as a blank tile.
`checkTilePaletteData(palette)` and `checkTilemapData(map, tileIds)` return a list of
plain-language problems (empty when the data is sound); `TilePalette` and
`createTilemaps` run them and refuse bad data with every problem listed. They take the
file as it comes (a JSON import, before any cast). Add one test that checks every content
file you ship:

```ts
test('the shipped map and palette are sound', () => {
  expect(checkTilePaletteData(tiles)).toEqual([]);
  expect(checkTilemapData(map, tiles.tiles.map((tile) => tile.id))).toEqual([]);
});
```
