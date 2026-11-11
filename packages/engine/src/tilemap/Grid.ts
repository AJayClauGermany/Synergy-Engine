import { Behaviour } from '../core/Component';
import { nameType } from '../core/typeNames';
import {
  cellCenterToLocal,
  cellCorners,
  type CellLayout,
  type CellSwizzle,
  cellToLocal,
  defaultGridShape,
  type GridShape,
  localToCell,
  planeNormal,
} from '../grid/layout';
import { Plane, type Ray } from '../math/geometry';
import type { Vector3 } from '../math/Vector3';
import type { CellLike, Vector3Int } from '../math/Vector3Int';

/** What `Grid.raycast` found. */
export interface GridHit {
  /** The cell under the ray. */
  cell: Vector3Int;
  /** World-space point where the ray meets the grid's plane. */
  point: Vector3;
  distance: number;
}

/**
 * Defines a grid of cells and converts between cells and positions. Unity: `Grid`.
 * Put Tilemaps on child GameObjects; each child is a layer that shares this layout.
 *
 *   const grid = new GameObject('Grid').addComponent(Grid);
 *   grid.cellLayout = CellLayout.Hexagon;
 *   grid.cellSwizzle = CellSwizzle.XZY;        // lay it on the ground
 *   grid.cellSize = hexCellSize(1);
 *
 * The default is Unity's: square cells on the XY plane. For a 3D game with units
 * standing on the map, use `CellSwizzle.XZY`.
 */
export class Grid extends Behaviour {
  static readonly disallowMultiple = true;

  /** @internal */
  readonly _shape: GridShape = defaultGridShape();
  /** @internal Bumped whenever the layout changes, so renderers know to rebuild. */
  _version = 0;

  override _summary(): string {
    const { x, y, z } = this.cellSize;
    const size = [x, y, z].map((value) => Math.round(value * 1000) / 1000).join(', ');
    return `${this.cellLayout} cells, swizzle ${this.cellSwizzle}, cellSize (${size})`;
  }

  get cellSize(): Vector3 {
    return this._shape.cellSize;
  }

  set cellSize(value: Vector3) {
    this._shape.cellSize = value;
    this._version++;
  }

  /** Empty space between cells. Tiles keep their size; their spacing grows. */
  get cellGap(): Vector3 {
    return this._shape.cellGap;
  }

  set cellGap(value: Vector3) {
    this._shape.cellGap = value;
    this._version++;
  }

  get cellLayout(): CellLayout {
    return this._shape.cellLayout;
  }

  set cellLayout(value: CellLayout) {
    this._shape.cellLayout = value;
    this._version++;
  }

  get cellSwizzle(): CellSwizzle {
    return this._shape.cellSwizzle;
  }

  set cellSwizzle(value: CellSwizzle) {
    this._shape.cellSwizzle = value;
    this._version++;
  }

  /** Cell -> local position: the cell's corner for rectangles, its centre for hexagons. */
  cellToLocal(cell: CellLike): Vector3 {
    return cellToLocal(this._shape, cell);
  }

  localToCell(localPosition: Vector3): Vector3Int {
    return localToCell(this._shape, localPosition);
  }

  cellToWorld(cell: CellLike): Vector3 {
    return this.transform.transformPoint(this.cellToLocal(cell));
  }

  /** The cell containing a world position. */
  worldToCell(worldPosition: Vector3): Vector3Int {
    return this.localToCell(this.transform.inverseTransformPoint(worldPosition));
  }

  getCellCenterLocal(cell: CellLike): Vector3 {
    return cellCenterToLocal(this._shape, cell);
  }

  /** World position of the middle of a cell. This is where to put a unit. */
  getCellCenterWorld(cell: CellLike): Vector3 {
    return this.transform.transformPoint(this.getCellCenterLocal(cell));
  }

  /** The corners of a cell in world space, in order: 4 for rectangles, 6 for hexagons. */
  getCellCornersWorld(cell: CellLike): Vector3[] {
    return cellCorners(this._shape, cell).map((corner) => this.transform.transformPoint(corner));
  }

  /** World-space direction pointing out of the grid's face (up, for a ground grid). */
  get normal(): Vector3 {
    return this.transform.transformDirection(planeNormal(this._shape)).normalized;
  }

  /**
   * Finds the cell a ray points at, by intersecting the grid's plane. No colliders
   * needed. This is how to turn the mouse into a cell (it has no Unity equivalent):
   *
   *   const hit = grid.raycast(Camera.main.screenPointToRay(Input.mousePosition));
   *   if (hit && terrain.hasTile(hit.cell)) select(hit.cell);
   *
   * `layer` picks which z layer's plane to test.
   */
  raycast(ray: Ray, layer = 0): GridHit | null {
    const origin = this.cellToWorld({ x: 0, y: 0, z: layer });
    const distance = new Plane(this.normal, origin).raycast(ray);
    if (distance === null) return null;
    const point = ray.getPoint(distance);
    const found = this.worldToCell(point);
    // Rounding can land on a neighbouring layer when the ray grazes the plane.
    const cell = found.z === layer ? found : found.add({ x: 0, y: 0, z: layer - found.z });
    return { cell, point, distance };
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    Object.assign(this._shape, source._shape);
    this._version++;
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Grid, 'Grid');
