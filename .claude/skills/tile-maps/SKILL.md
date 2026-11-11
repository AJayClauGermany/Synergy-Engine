---
name: tile-maps
description: Use when building or changing maps, grids or boards - hex or square tiles, terrain, map layers such as highlights and fog of war, picking a cell from the mouse, movement ranges, or pathfinding.
---

# Tile maps, grids and pathfinding

Read `docs/tilemaps.md` first; it is short and has the whole API. This file is the
checklist and the traps. A complete worked example is `game/src/behaviours/BoardView.ts`
(view) with `game/src/rules/skirmish.ts` (rules).

## Structure

```
Board            Grid                         cellLayout, cellSwizzle, cellSize
  Terrain        Tilemap + TilemapRenderer    sortingOrder 0
  Highlight      Tilemap + TilemapRenderer    sortingOrder 1, lit = false
  Fog            Tilemap + TilemapRenderer    sortingOrder 2, translucent tiles
```

- One `Grid`; one child GameObject per layer.
- A Tilemap finds its Grid by looking up the hierarchy each time, so parent first or
  after, either works. `tilemap.layoutGrid` throws if there is none.
- Tiles are created once (module-level constants) and reused across cells.

## Decisions to make up front

1. **Plane.** 3D game with units standing on the map: `grid.cellSwizzle = CellSwizzle.XZY`.
   Flat 2D look with an orthographic camera: leave the default (`XYZ`).
2. **Shape.** `CellLayout.Hexagon` gives point-top hexes in Unity's offset coordinates
   (odd rows shifted right). For regular hexagons set `grid.cellSize = hexCellSize(width)`.
   Flat-top hexes: swizzle `YXZ` (2D) or `YZX` (ground).
3. **Where the map data lives.** If rules must run without the engine (multiplayer,
   server validation, fast tests), keep the layout as plain data in `game/src/rules/` and
   paint the Tilemap from it. Do not make `apply()` read a Tilemap.

## Recipes

```ts
// Place a unit
unit.transform.position = grid.getCellCenterWorld(cell);

// Mouse -> cell (no colliders involved)
const hit = grid.raycast(camera.screenPointToRay(Input.mousePosition));
if (hit && terrain.hasTile(hit.cell)) onCellClicked(hit.cell);

// Highlight a set of cells
overlay.clearAllTiles();
overlay.setTiles(cells, highlightTile);          // one tile for all of them

// Movement range and route (pure; import from '@synergy/engine/grid' in rules)
const range = findReachable(unit, movePoints, {
  neighbors: (c) => Hex.neighbors(c).filter(inBounds),
  cost: (_from, to) => (occupied(to) ? Infinity : terrainCost(to)),
});
range.has(target); range.pathTo(target);

// Area effects and line of sight
Hex.range(center, 2); Hex.ring(center, 2); Hex.line(from, to); Hex.distance(a, b);
```

## Traps

- **Use `getCellCenterWorld`, not `cellToWorld`**, to position things. As in Unity,
  `cellToWorld` is the corner for square cells and the centre only for hexes.
- **Never hand-roll hex neighbours** with `x ± 1, y ± 1`: in offset coordinates the
  neighbours of odd and even rows differ. Use `Hex.neighbors` / `Hex.distance`.
- **Filter out-of-bounds cells yourself** in `neighbors` (or return `Infinity` from
  `cost`); the helpers do not know your map's size.
- **Cells are compared with `.equals` or by `x`/`y`**, not `===`. For `Set`/`Map` keys
  use `cellKey(cell)`.
- **Layers on the same plane**: give each renderer a different `sortingOrder`, or they
  flicker.
- **Translucent tiles** (alpha < 1) are blended automatically; for a texture's own alpha
  set `renderer.transparent = true`.
- **Unlit overlays**: set `renderer.lit = false` for highlight colours that should not
  be shaded by the sun.
- The meshes update at the end of the frame, block by block (16 x 16 cells), so editing
  cells every frame is fine on maps of tens of thousands of tiles. Setting
  `tilemap.color` or a renderer field redoes the whole layer: tint cells with
  `setColor(cell, ...)` for things that change often. In a headless test, call
  `engine.step()` (or `renderer.rebuild()`) before inspecting what is drawn
  (`renderer.pcMeshInstances`); tile *data* is immediate.
- Not available yet: isometric layout, animated tiles, tile colliders, elevation.
  Say so rather than faking it.

## Verify

Rules and pathfinding: plain `bun test` on the pure functions. Picking and views: a
headless scene test that projects a cell to the screen and clicks it (see
`game/test/scene.test.ts`). Looks: `bun run screenshot`.
