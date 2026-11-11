# Exporting content from Unity

`Editor/SynergyExporter.cs` is a Unity editor script that writes the content of a Unity
project as JSON this engine loads. It is the bridge for the parts of a game that were
made in the editor rather than in code: Tile assets, painted Tilemaps, sprite sheets and
ScriptableObject data.

> **Not yet run in Unity.** The script was written against Unity's documented editor API
> (2019.4 or newer) but this repository has no Unity to compile or run it with. Expect to
> fix a compile error or two the first time. The JSON formats it targets are fixed and
> tested on the engine side (`packages/engine/test/data.test.ts`), so if the export needs
> adjusting, adjust the script, not the format.

## Install

Copy `Editor/SynergyExporter.cs` into the Unity project under any folder named `Editor`,
for example `Assets/Editor/SynergyExporter.cs`. Two items appear under **Tools > Synergy**.

## Tools > Synergy > Export Tilemaps In Open Scenes...

Open the scene (or scenes) that hold the maps, run it, and choose an empty folder.

| File | Holds | Load with |
|------|-------|-----------|
| `tiles.json` | Every Tile asset the tilemaps use: `id` (the asset's name), `sprite`, `color`, and the serialized fields of a custom Tile class under `data` | `TilePalette.load(tiles, { baseUrl })` |
| `map-<Grid name>.json` | One per Grid in the scene: cell layout, swizzle, cell size and gap, and each Tilemap under it as a layer of cells | `createTilemaps(map, palette)` |
| `<texture>.png` | The sprite sheets those tiles use, copied unchanged | (loaded by the palette) |

A custom tile such as

```csharp
public class TerrainTile : Tile {
    public Climate climate;      // enum
    public int elevation;
    public float moveCost = 1f;
}
```

comes out as

```json
{ "id": "Grassland", "sprite": "Terrain/grass_0", "data": { "climate": "Temperate", "elevation": 1, "moveCost": 1 } }
```

Cell coordinates are written as they are in Unity. Hexagonal grids keep their
coordinates: this engine uses Unity's offset layout.

What is carried over, and what is not:

- **Carried:** which tile is in which cell on every z level, the Tilemap's tint and its
  renderer's `sortingOrder`, sprite rectangles (converted to top-left origin), pivots and
  pixels per unit, enum fields as their C# names, references to other assets as the
  asset's name, nested serializable classes and lists.
- **Not carried:** per-cell colour, transform and flags; tile colliders; animated tiles;
  isometric grids (skipped with a warning). A RuleTile or other scripted tile is exported
  with the one sprite it shows in the first cell found, and a warning: port its rule by
  overriding `getTileData` on a `Tile` subclass. Curves and gradients become `null`.
- Sprite rectangles are scaled back to the source image's size when Unity imported the
  texture smaller (Max Size), on Unity 2021.2 or newer. On older versions, set Max Size
  high enough that the texture is imported at full size before exporting.

## Tools > Synergy > Export Selected Assets As Data...

Select ScriptableObject assets in the Project window (unit types, buildings, weapons,
rule sets) and run it. It writes one `<TypeName>.json` per C# type: a list of records,
each with `id` (the asset's name) and the asset's serialized fields.

```json
[
  { "id": "Footman", "maxHealth": 10, "moveRange": 3, "weapon": "Sword" },
  { "id": "Archer", "maxHealth": 6, "moveRange": 3, "weapon": "Bow" }
]
```

Load it into a `Catalog`:

```ts
import { Catalog } from '@synergy/engine/data';
import unitTypes from './data/UnitType.json';

interface UnitType { id: string; maxHealth: number; moveRange: number; weapon: string }
export const units = new Catalog<UnitType>('unit type', unitTypes);
units.get('Footman').moveRange;
```

A reference from one asset to another (`weapon` above) is the other asset's name, which
is its `id` in its own catalog. Keep these names stable: maps, saves and network messages
refer to content by them.

## After exporting

1. Put the folder where the game can read it: `game/public/content/` to fetch it at run
   time (`TilePalette.fromUrl('/content/tiles.json')`), or `game/src/data/` to import the
   JSON into the bundle.
2. Add a test that loads every file and runs `checkTilePaletteData` and
   `checkTilemapData` on it, so a bad export fails `bun run check` rather than showing up
   as a blank tile. `game/test/content.test.ts` does this for the sample.
3. Describe the fields you exported with a TypeScript interface (`Terrain`, `UnitType`),
   so the rest of the port is type-checked against the data.

The formats are documented in [`docs/content.md`](../../docs/content.md).
