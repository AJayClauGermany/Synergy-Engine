// Game content as plain data, with no engine or renderer attached. Import from
// '@synergy/engine/data' in game rules, tests and server code:
//   Catalog           definitions looked up by id (Unity: ScriptableObject assets)
//   tile data shapes  what a palette or map JSON file holds, and helpers to read it
export { Catalog, deepFreeze } from './Catalog';
export {
  type SpriteData,
  type SpriteSheetData,
  type TileDefinition,
  type TilePaletteData,
  type TilemapLayerData,
  type TilemapData,
  type LayerCell,
  layerNamed,
  layerTileAt,
  layerCells,
  encodeLayer,
  checkTilemapData,
  checkTilePaletteData,
  splitSpritePath,
} from './tiles';
