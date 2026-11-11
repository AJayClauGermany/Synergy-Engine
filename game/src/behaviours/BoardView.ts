import {
  CellLayout,
  CellSwizzle,
  Color,
  GameObject,
  Grid,
  hexCellSize,
  Material,
  Mesh,
  MeshFilter,
  MeshRenderer,
  MonoBehaviour,
  Prefab,
  PrimitiveType,
  type Ray,
  Tile,
  type TileData,
  Tilemap,
  TilemapRenderer,
  Vector3,
  type Vector3Int,
} from '@synergy/engine';
import { type Cell, COLUMNS, ROWS, type Terrain, terrainAt } from '../rules/skirmish';

export type Highlight = 'move' | 'attack' | 'selected';

/** A terrain tile. Subclassing `Tile` is how game data rides along with the artwork. */
class TerrainTile extends Tile {
  constructor(
    readonly terrain: Terrain,
    color: string,
    gameObject: Prefab | null = null,
  ) {
    super({ name: terrain, color: Color.fromHex(color), gameObject });
  }

  /** Vary the shade a little from cell to cell so the map does not look flat. */
  override getTileData(cell: Vector3Int, tilemap: Tilemap): TileData {
    const shade = 0.92 + ((cell.x * 7 + cell.y * 13) % 3) * 0.04;
    return { ...super.getTileData(cell, tilemap), color: this.color.mul(shade) };
  }
}

let treeMaterial: Material | null = null;

/** Spawned on every forest cell through `Tile.gameObject`. */
const TreePrefab = new Prefab('Tree', (tree) => {
  if (!treeMaterial) {
    treeMaterial = new Material();
    treeMaterial.color = Color.fromHex('#2f5d3a');
    treeMaterial.smoothness = 0.1;
  }
  // The tile places this object at the cell centre; the canopy is a child so it can sit above the ground.
  const canopy = new GameObject('Canopy');
  canopy.transform.setParent(tree.transform, false);
  canopy.transform.localPosition = new Vector3(0, 0.35, 0);
  canopy.transform.localScale = new Vector3(0.55, 0.7, 0.55);
  canopy.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Sphere);
  canopy.addComponent(MeshRenderer).sharedMaterial = treeMaterial;
});

const TERRAIN_TILES: Record<Terrain, TerrainTile> = {
  plain: new TerrainTile('plain', '#6f9166'),
  forest: new TerrainTile('forest', '#4f7a55', TreePrefab),
  water: new TerrainTile('water', '#3f7fb5'),
};

const HIGHLIGHT_TILES: Record<Highlight, Tile> = {
  move: new Tile({ name: 'move', color: Color.fromHex('#5aa7e8').withAlpha(0.6) }),
  attack: new Tile({ name: 'attack', color: Color.fromHex('#e8695a').withAlpha(0.7) }),
  selected: new Tile({ name: 'selected', color: Color.fromHex('#f2d264').withAlpha(0.7) }),
};

/**
 * Draws the hex map with the engine's tile system and converts between cells and world
 * positions. It knows nothing about the rules beyond the terrain layout.
 *
 *   Board (Grid, BoardView)
 *     Terrain   (Tilemap, TilemapRenderer)                 one tile per cell
 *     Highlight (Tilemap, TilemapRenderer, drawn on top)   move/attack/selection overlay
 */
export class BoardView extends MonoBehaviour {
  private grid: Grid | null = null;
  private terrain: Tilemap | null = null;
  private overlay: Tilemap | null = null;

  awake() {
    const grid = this.gameObject.addComponent(Grid);
    grid.cellLayout = CellLayout.Hexagon;
    grid.cellSwizzle = CellSwizzle.XZY; // lay the map on the ground
    grid.cellSize = hexCellSize(1);
    grid.cellGap = hexCellSize(0.05); // a sliver between tiles reads as grid lines
    this.grid = grid;

    this.terrain = this.addLayer('Terrain', 0);
    this.overlay = this.addLayer('Highlight', 1);
    // Highlights are flat colour, unaffected by the sun.
    (this.overlay.getComponent(TilemapRenderer) as TilemapRenderer).lit = false;

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLUMNS; x++) {
        const terrain = terrainAt({ x, y });
        if (terrain) this.terrain.setTile({ x, y }, TERRAIN_TILES[terrain]);
      }
    }

    // Centre the map on the world origin.
    const first = grid.getCellCenterWorld({ x: 0, y: 0 });
    const last = grid.getCellCenterWorld({ x: COLUMNS - 1, y: ROWS - 1 });
    this.transform.position = this.transform.position.sub(Vector3.lerp(first, last, 0.5)).withY(0);
  }

  private addLayer(name: string, sortingOrder: number): Tilemap {
    const layer = new GameObject(name);
    layer.transform.setParent(this.transform, false);
    const tilemap = layer.addComponent(Tilemap);
    layer.addComponent(TilemapRenderer).sortingOrder = sortingOrder;
    return tilemap;
  }

  /** World position of the middle of a cell: where a unit stands. */
  cellToWorld(cell: Cell): Vector3 {
    return (this.grid as Grid).getCellCenterWorld(cell);
  }

  /** The map cell a ray (usually from the mouse) points at, or `null` when it misses the map. */
  rayToCell(ray: Ray): Cell | null {
    const hit = this.grid?.raycast(ray);
    return hit && this.terrain?.hasTile(hit.cell) ? { x: hit.cell.x, y: hit.cell.y } : null;
  }

  clearHighlights() {
    this.overlay?.clearAllTiles();
  }

  highlight(cells: readonly Cell[], kind: Highlight) {
    this.overlay?.setTiles(cells, HIGHLIGHT_TILES[kind]);
  }
}
