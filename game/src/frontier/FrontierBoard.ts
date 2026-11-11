import {
  createTilemaps,
  GameObject,
  type Grid,
  MonoBehaviour,
  type Ray,
  type Tile,
  Tilemap,
  type TilePalette,
  TilemapRenderer,
  Vector3,
} from '@synergy/engine';
import { cellKey } from '@synergy/engine/grid';
import { allCells, type Cell, map, type Terrain } from './rules';

/**
 * The map on screen. It is built from the map and palette files (`createTilemaps`), plus
 * two layers made here for what changes during play: order highlights and fog of war.
 *
 *   Board (FrontierBoard)
 *     Map (Grid)
 *       Terrain    (Tilemap, TilemapRenderer)   from data/map.json
 *       Highlight  (Tilemap, TilemapRenderer)   where the selected unit can go
 *       Fog        (Tilemap, TilemapRenderer)   cells the local player's units cannot see
 *
 * It shows things and answers "which cell is that?". It decides nothing about the game.
 */
export class FrontierBoard extends MonoBehaviour {
  /** Set by the scene before `awake`: the tiles to paint with. */
  palette: TilePalette<Terrain> | null = null;

  private _grid: Grid | null = null;
  private _terrain: Tilemap | null = null;
  private _highlight: Tilemap | null = null;
  private _fog: Tilemap | null = null;
  /** The cells currently fogged, so only the ones that change are repainted. */
  private _fogged = new Set<string>();

  awake() {
    if (!this.palette)
      throw new Error('FrontierBoard needs its palette before it wakes: set board.palette in the scene.');
    const built = createTilemaps(map, this.palette, { name: 'Map', parent: this.transform });
    this._grid = built.grid;
    this._terrain = built.layer('Terrain');
    this._highlight = this.addLayer('Highlight', 1);
    this._fog = this.addLayer('Fog', 2);

    // Centre the map on the world origin.
    const cells = allCells();
    const first = built.grid.getCellCenterWorld(cells[0] as Cell);
    const last = built.grid.getCellCenterWorld(cells[cells.length - 1] as Cell);
    this.transform.position = this.transform.position.sub(Vector3.lerp(first, last, 0.5)).withY(0);
  }

  private addLayer(name: string, sortingOrder: number): Tilemap {
    const layer = new GameObject(name);
    layer.transform.setParent((this._grid as Grid).transform, false);
    const tilemap = layer.addComponent(Tilemap);
    const renderer = layer.addComponent(TilemapRenderer);
    renderer.sortingOrder = sortingOrder;
    renderer.lit = false; // flat colour, unaffected by the sun
    return tilemap;
  }

  /** World position of the middle of a cell: where a unit stands. */
  cellToWorld(cell: Cell): Vector3 {
    return (this._grid as Grid).getCellCenterWorld(cell);
  }

  /** The map cell a ray (usually from the mouse) points at, or `null` when it misses the map. */
  rayToCell(ray: Ray): Cell | null {
    const hit = this._grid?.raycast(ray);
    return hit && this._terrain?.hasTile(hit.cell) ? { x: hit.cell.x, y: hit.cell.y } : null;
  }

  /** The terrain painted on a cell, straight from the Tilemap (the rules read the same data from the file). */
  terrainAt(cell: Cell): Terrain | null {
    return this._terrain?.getTile<Tile<Terrain>>(cell)?.data ?? null;
  }

  /** Marks the selected unit's cell, where it can move, and which enemies it can strike. Pass nothing to clear. */
  showOrders(selected: Cell | null = null, reach: readonly Cell[] = [], targets: readonly Cell[] = []) {
    const layer = this._highlight;
    const palette = this.palette;
    if (!layer || !palette) return;
    layer.clearAllTiles();
    layer.setTiles(reach, palette.get('reach'));
    layer.setTiles(targets, palette.get('target'));
    if (selected) layer.setTile(selected, palette.get('selected'));
  }

  /**
   * Covers every cell that is not in `visible` (a set of `cellKey`s). `null` lifts the
   * fog entirely. Only cells whose state changed are repainted, so calling this whenever
   * a unit moves costs a few cells, not the map.
   */
  showFog(visible: ReadonlySet<string> | null) {
    const layer = this._fog;
    const palette = this.palette;
    if (!layer || !palette) return;
    const fog = palette.get('fog');
    for (const cell of allCells()) {
      const key = cellKey(cell);
      const fogged = visible !== null && !visible.has(key);
      if (fogged === this._fogged.has(key)) continue;
      layer.setTile(cell, fogged ? fog : null);
      if (fogged) this._fogged.add(key);
      else this._fogged.delete(key);
    }
  }
}
