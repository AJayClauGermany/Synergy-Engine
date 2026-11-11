import { type CellLike, Vector3Int } from '../math/Vector3Int';
import { Vector3 } from '../math/Vector3';

/** The shape of a grid's cells. Unity: `GridLayout.CellLayout`. */
export enum CellLayout {
  Rectangle = 'rectangle',
  /**
   * Point-top hexagons in offset rows: odd rows are shifted half a cell to the right,
   * exactly as in Unity. Use a swizzle that swaps X and Y (YXZ, YZX) for flat-top.
   */
  Hexagon = 'hexagon',
}

/**
 * Which axes the grid lies on. Unity: `GridLayout.CellSwizzle`.
 *
 * - `XYZ` (Unity's default): the XY plane, facing the default camera. A classic 2D view.
 * - `XZY`: the ground. Cell x goes right, cell y goes forward, layers stack upward.
 * - `YXZ` / `YZX`: the same two planes with x and y swapped (flat-top hexagons).
 *
 * Because this world is right-handed, "forward" on the ground is -Z; cell y therefore
 * increases away from a default camera, just as it does on screen in Unity.
 */
export enum CellSwizzle {
  XYZ = 'xyz',
  XZY = 'xzy',
  YXZ = 'yxz',
  YZX = 'yzx',
  ZXY = 'zxy',
  ZYX = 'zyx',
}

/** The settings of a grid. The `Grid` component owns one of these. */
export interface GridShape {
  cellSize: Vector3;
  cellGap: Vector3;
  cellLayout: CellLayout;
  cellSwizzle: CellSwizzle;
}

export function defaultGridShape(): GridShape {
  return {
    cellSize: Vector3.one,
    cellGap: Vector3.zero,
    cellLayout: CellLayout.Rectangle,
    cellSwizzle: CellSwizzle.XYZ,
  };
}

/**
 * Cell size for regular point-top hexagons that are `width` across (flat side to flat
 * side). Pass the result as `grid.cellSize`.
 */
export function hexCellSize(width = 1): Vector3 {
  return new Vector3(width, (width * 2) / Math.sqrt(3), 1);
}

/** Reorders a layout-space position into grid-local space. Unity: `Grid.Swizzle`. */
export function swizzle(order: CellSwizzle, v: Vector3): Vector3 {
  // Unity's permutation, then flip Z to go from its left-handed space to this one.
  switch (order) {
    case CellSwizzle.XYZ:
      return new Vector3(v.x, v.y, -v.z);
    case CellSwizzle.XZY:
      return new Vector3(v.x, v.z, -v.y);
    case CellSwizzle.YXZ:
      return new Vector3(v.y, v.x, -v.z);
    case CellSwizzle.YZX:
      return new Vector3(v.y, v.z, -v.x);
    case CellSwizzle.ZXY:
      return new Vector3(v.z, v.x, -v.y);
    case CellSwizzle.ZYX:
      return new Vector3(v.z, v.y, -v.x);
  }
}

/** The inverse of `swizzle`. Unity: `Grid.InverseSwizzle`. */
export function inverseSwizzle(order: CellSwizzle, v: Vector3): Vector3 {
  const z = -v.z;
  switch (order) {
    case CellSwizzle.XYZ:
      return new Vector3(v.x, v.y, z);
    case CellSwizzle.XZY:
      return new Vector3(v.x, z, v.y);
    case CellSwizzle.YXZ:
      return new Vector3(v.y, v.x, z);
    case CellSwizzle.YZX:
      return new Vector3(z, v.x, v.y);
    case CellSwizzle.ZXY:
      return new Vector3(v.y, z, v.x);
    case CellSwizzle.ZYX:
      return new Vector3(z, v.y, v.x);
  }
}

/** Unit vector, in grid-local space, pointing out of the grid's face (up for ground grids). */
export function planeNormal(shape: GridShape): Vector3 {
  switch (shape.cellSwizzle) {
    case CellSwizzle.XYZ:
    case CellSwizzle.YXZ:
      return Vector3.back; // +Z, toward a default camera
    case CellSwizzle.XZY:
    case CellSwizzle.YZX:
      return Vector3.up;
    default:
      return Vector3.right;
  }
}

function stride(shape: GridShape): Vector3 {
  return shape.cellSize.add(shape.cellGap);
}

const isOdd = (n: number) => (n & 1) === 1;

/** Position of a (possibly fractional) cell coordinate before swizzling. */
function layoutPosition(shape: GridShape, x: number, y: number, z: number): Vector3 {
  const s = stride(shape);
  if (shape.cellLayout === CellLayout.Hexagon) {
    return new Vector3((x + (isOdd(Math.round(y)) ? 0.5 : 0)) * s.x, y * s.y * 0.75, z * s.z);
  }
  return new Vector3(x * s.x, y * s.y, z * s.z);
}

/**
 * Cell -> grid-local position. For rectangles this is the cell's minimum corner; for
 * hexagons it is the cell's centre (as in Unity). When you want the middle of a cell,
 * use `cellCenterToLocal`, which is right for both.
 */
export function cellToLocal(shape: GridShape, cell: CellLike): Vector3 {
  return swizzle(shape.cellSwizzle, layoutPosition(shape, cell.x, cell.y, cell.z ?? 0));
}

/** Cell -> the grid-local position of its centre. */
export function cellCenterToLocal(shape: GridShape, cell: CellLike): Vector3 {
  const position = layoutPosition(shape, cell.x, cell.y, cell.z ?? 0);
  if (shape.cellLayout === CellLayout.Rectangle) {
    return swizzle(shape.cellSwizzle, position.add(new Vector3(shape.cellSize.x / 2, shape.cellSize.y / 2, 0)));
  }
  return swizzle(shape.cellSwizzle, position);
}

/** Grid-local position -> the cell containing it. The layer (z) is the nearest one. */
export function localToCell(shape: GridShape, local: Vector3): Vector3Int {
  const p = inverseSwizzle(shape.cellSwizzle, local);
  const s = stride(shape);
  const layer = s.z !== 0 ? Math.round(p.z / s.z) : 0;
  if (shape.cellLayout === CellLayout.Rectangle) {
    return new Vector3Int(s.x !== 0 ? Math.floor(p.x / s.x) : 0, s.y !== 0 ? Math.floor(p.y / s.y) : 0, layer);
  }
  // Fractional axial coordinates, rounded to the nearest hexagon via cube coordinates.
  const r = p.y / (s.y * 0.75);
  const q = p.x / s.x - r / 2;
  const [aq, ar] = roundAxial(q, r);
  return axialToOffset(aq, ar, layer);
}

/** The corners of a cell in grid-local space, in order around the cell. */
export function cellCorners(shape: GridShape, cell: CellLike): Vector3[] {
  const centre = layoutPosition(shape, cell.x, cell.y, cell.z ?? 0);
  const w = shape.cellSize.x / 2;
  const h = shape.cellSize.y / 2;
  let offsets: [number, number][];
  if (shape.cellLayout === CellLayout.Hexagon) {
    offsets = [
      [0, h],
      [w, h / 2],
      [w, -h / 2],
      [0, -h],
      [-w, -h / 2],
      [-w, h / 2],
    ];
  } else {
    // Rectangle cells are positioned by their minimum corner.
    offsets = [
      [0, 0],
      [w * 2, 0],
      [w * 2, h * 2],
      [0, h * 2],
    ];
  }
  return offsets.map(([dx, dy]) => swizzle(shape.cellSwizzle, new Vector3(centre.x + dx, centre.y + dy, centre.z)));
}

// ---- Hexagon coordinate conversions (shared with hex.ts) ---------------------------------

/** Unity-style offset cell (odd rows shifted right) -> axial (q, r). */
export function offsetToAxial(cell: CellLike): { q: number; r: number } {
  return { q: cell.x - (cell.y - (cell.y & 1)) / 2, r: cell.y };
}

/** Axial (q, r) -> Unity-style offset cell. */
export function axialToOffset(q: number, r: number, z = 0): Vector3Int {
  return new Vector3Int(q + (r - (r & 1)) / 2, r, z);
}

function roundAxial(q: number, r: number): [number, number] {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // Avoid -0, which would leak into cell keys and comparisons.
  return [rq + 0, rr + 0];
}
