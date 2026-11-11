# Tile maps and grids

The tile system follows Unity's: a **Grid** defines the cells, each **Tilemap** under it is
a layer of **Tiles**, and a **TilemapRenderer** draws a layer. Square and hexagonal cells
are supported, on any plane.

Two things go beyond Unity because strategy games need them: picking a cell from the
mouse without colliders (`grid.raycast`), and hex maths plus weighted pathfinding
(`Hex`, `findPath`, `findReachable`).

## A hex map in a dozen lines

```ts
import {
  CellLayout, CellSwizzle, Color, GameObject, Grid, hexCellSize, Tile, Tilemap, TilemapRenderer,
} from '@synergy/engine';

const grid = new GameObject('Grid').addComponent(Grid);
grid.cellLayout = CellLayout.Hexagon;
grid.cellSwizzle = CellSwizzle.XZY;          // lay it on the ground (see "Orientation")
grid.cellSize = hexCellSize(1);              // regular hexagons, 1 unit across

const layer = new GameObject('Terrain');
layer.transform.setParent(grid.transform, false);
const terrain = layer.addComponent(Tilemap);
layer.addComponent(TilemapRenderer);

const grass = new Tile({ name: 'Grass', color: Color.fromHex('#6f9166') });
for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) terrain.setTile({ x, y }, grass);

unit.transform.position = grid.getCellCenterWorld({ x: 4, y: 3 });
```

`game/src/behaviours/BoardView.ts` is a complete example with terrain, spawned trees and
a highlight layer.

## Cells

A cell is a `Vector3Int`: `x` and `y` are the cell, `z` is a layer index (usually 0).
Every method also accepts a plain `{ x, y }`, which is convenient for game state.

**Hexagons use Unity's coordinates**: point-top hexes in offset rows, where odd rows sit
half a cell to the right. Maps authored in Unity keep their coordinates.

```
 row 2   (0,2) (1,2) (2,2)
 row 1     (0,1) (1,1) (2,1)        odd rows are shifted right
 row 0   (0,0) (1,0) (2,0)
```

## Orientation

`grid.cellSwizzle` chooses the plane, as in Unity:

| Swizzle | Plane | Use for |
|---------|-------|---------|
| `XYZ` (default) | XY, facing the default camera | a flat 2D game with an orthographic camera |
| `XZY` | the ground: x right, y forward, layers stack up | 3D games with units standing on the map |
| `YXZ` / `YZX` | the same two planes with x and y swapped | flat-top hexagons |

On the ground, cell `y` increases *away* from a default camera, so a map looks the same
way up as it does in Unity's Scene view.

## Positions

| | |
|---|---|
| `grid.getCellCenterWorld(cell)` | Where to put something that stands on a cell |
| `grid.worldToCell(position)` | Which cell a world position is in |
| `grid.raycast(ray)` | Which cell a ray points at: `{ cell, point, distance }` or `null` |
| `grid.getCellCornersWorld(cell)` | The cell's outline (4 or 6 points) |
| `grid.cellToWorld(cell)` | Unity's `CellToWorld`: the corner for squares, the centre for hexes |

Mouse to cell:

```ts
const hit = grid.raycast(camera.screenPointToRay(Input.mousePosition));
if (hit && terrain.hasTile(hit.cell)) select(hit.cell);
```

Tilemaps have the same conversion methods, relative to their own transform.

## Tiles

A `Tile` is created once and reused, like a ScriptableObject asset.

```ts
new Tile({ color: Color.green });                       // flat colour
new Tile({ sprite });                                   // artwork (see below)
new Tile({ color: Color.white.withAlpha(0.5) });        // see-through
new Tile({ gameObject: TreePrefab });                   // spawns an object on the cell
```

**Game data on tiles.** Subclass `Tile`:

```ts
class TerrainTile extends Tile { moveCost = 1; blocksSight = false; }
terrain.getTile<TerrainTile>(cell)?.moveCost
```

Keep the *rules* reading plain data rather than the Tilemap if they must run without the
engine (on a server, in fast tests): the sample keeps the map layout in
`game/src/rules/` and paints the Tilemap from it.

**Per-cell looks.** Override `getTileData(cell, tilemap)` to vary a tile by position or by
its neighbours (Unity's rule tiles); call `tilemap.refreshTile(cell)` when the answer
changes. `tilemap.setColor(cell, color)` tints one cell without a new tile.

**Artwork.**

```ts
const sheet = await Assets.loadTexture(terrainUrl);
const [grass, sand, water] = Sprite.slice(sheet, 3, 1);     // columns, rows
new Sprite(sheet, { x: 64, y: 0, width: 64, height: 64 });  // pixels, origin top-left
```

The image is stretched over the cell's bounding box; a hexagon shows the part inside its
outline. Set `renderer.transparent = true` to use a texture's alpha channel.

## Layers

Each Tilemap under a Grid is a layer. Typical strategy set-up: terrain, an overlay for
highlights, and fog of war on top.

```ts
overlayRenderer.sortingOrder = 1;      // drawn above order 0
overlayRenderer.lit = false;           // flat colour, ignores scene lighting
fog.color = Color.white.withAlpha(0.6); // fade a whole layer
```

Unity sorts 2D layers by `sortingOrder`. In 3D two layers on the same plane would
flicker, so each step of `sortingOrder` lifts the layer `sortingStep` (default 0.01)
units off the grid's surface.

## Editing

`setTile`, `setTiles`, `boxFill`, `floodFill`, `swapTile`, `clearAllTiles`, `getTile`,
`hasTile`, `containsTile`, `getUsedTilesCount`, `getUsedCells`, `cellBounds`,
`getInstantiatedObject`.

Changes are cheap to make in bulk: the mesh is rebuilt once, at the end of the frame.
A whole layer is one draw call per texture.

## Hex and square maths

Pure functions, importable without the engine from `@synergy/engine/grid`:

```ts
Hex.neighbors(cell)          // the six adjacent cells
Hex.distance(a, b)           // steps between two cells
Hex.range(center, 2)         // every cell within 2 steps
Hex.ring(center, 2)          // cells exactly 2 steps away
Hex.line(a, b)               // cells on the straight line between
Hex.toAxial(cell) / Hex.fromAxial(q, r)

Square.neighbors4(cell)  Square.neighbors8(cell)  Square.manhattan(a, b)  Square.chebyshev(a, b)
```

## Pathfinding

```ts
import { findPath, findReachable, Hex } from '@synergy/engine/grid';

const options = {
  neighbors: (cell) => Hex.neighbors(cell).filter(inBounds),
  cost: (from, to) => (isBlocked(to) ? Infinity : terrainCost(to)),   // defaults to 1
};

// A unit's movement range for 3 points, with routes:
const range = findReachable(unit, 3, options);
range.has(cell); range.costTo(cell); range.pathTo(cell); range.cells;

// One route (A*):
const route = findPath(from, to, { ...options, heuristic: Hex.distance });
route?.path; route?.cost;
```

Results are deterministic (ties are broken by a fixed order), so they are safe to use
inside multiplayer rules.

## Differences from Unity

- No Tile Palette or painting tools: maps are built in code or loaded from your own data.
- `TilemapRenderer.sortingOrder` separates layers physically (see Layers).
- `Sprite` rectangles are measured from the top-left of the image.
- There is no `TilemapCollider2D`. Use `grid.raycast` for picking; add ordinary
  colliders to spawned objects if you need them.
- `tileAnchor` and per-tile transform matrices are not implemented: tiles fill their cell.
- Not built yet: isometric layouts, animated tiles, a packaged `RuleTile`, chunked
  culling for very large maps (one layer is currently one mesh), elevation.
