import { type CellLike, Vector3Int } from '../math/Vector3Int';
import { axialToOffset, offsetToAxial } from './layout';

const AXIAL_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/**
 * Hexagon grid maths on the same cell coordinates a hexagonal `Grid`/`Tilemap` uses
 * (Unity's offset layout, where odd rows are shifted right). Unity has no equivalent;
 * most hex strategy games end up writing this themselves.
 *
 * Everything here is pure: no engine, no scene. Safe for game rules and servers.
 */
export const Hex = {
  /** Offset cell -> axial coordinates, where the six neighbours are simple offsets. */
  toAxial(cell: CellLike): { q: number; r: number } {
    return offsetToAxial(cell);
  },

  /** Axial coordinates -> offset cell. */
  fromAxial(q: number, r: number, z = 0): Vector3Int {
    return axialToOffset(q, r, z);
  },

  /** The six cells touching `cell`, in a fixed order (so results are deterministic). */
  neighbors(cell: CellLike): Vector3Int[] {
    const { q, r } = offsetToAxial(cell);
    return AXIAL_DIRECTIONS.map(([dq, dr]) => axialToOffset(q + dq, r + dr, cell.z ?? 0));
  },

  /** Number of steps between two cells, ignoring obstacles. */
  distance(a: CellLike, b: CellLike): number {
    const from = offsetToAxial(a);
    const to = offsetToAxial(b);
    const dq = from.q - to.q;
    const dr = from.r - to.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  },

  /** Every cell within `radius` steps of `center`, including `center` itself. */
  range(center: CellLike, radius: number): Vector3Int[] {
    const { q, r } = offsetToAxial(center);
    const cells: Vector3Int[] = [];
    for (let dq = -radius; dq <= radius; dq++) {
      const from = Math.max(-radius, -dq - radius);
      const to = Math.min(radius, -dq + radius);
      for (let dr = from; dr <= to; dr++) cells.push(axialToOffset(q + dq, r + dr, center.z ?? 0));
    }
    return cells;
  },

  /** The cells exactly `radius` steps from `center`. */
  ring(center: CellLike, radius: number): Vector3Int[] {
    if (radius <= 0) return [Vector3Int.from(center)];
    const { q, r } = offsetToAxial(center);
    const cells: Vector3Int[] = [];
    // Start `radius` steps out in direction 4, then walk each of the six sides.
    let cq = q + (AXIAL_DIRECTIONS[4] as readonly [number, number])[0] * radius;
    let cr = r + (AXIAL_DIRECTIONS[4] as readonly [number, number])[1] * radius;
    for (const [dq, dr] of AXIAL_DIRECTIONS) {
      for (let step = 0; step < radius; step++) {
        cells.push(axialToOffset(cq, cr, center.z ?? 0));
        cq += dq;
        cr += dr;
      }
    }
    return cells;
  },

  /** The cells a straight line from `a` to `b` passes through, both ends included. */
  line(a: CellLike, b: CellLike): Vector3Int[] {
    const steps = Hex.distance(a, b);
    const from = offsetToAxial(a);
    const to = offsetToAxial(b);
    const cells: Vector3Int[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      // A tiny nudge keeps points that fall exactly on an edge on a consistent side.
      const q = from.q + (to.q - from.q) * t + 1e-6;
      const r = from.r + (to.r - from.r) * t + 1e-6;
      const s = -q - r;
      let rq = Math.round(q);
      let rr = Math.round(r);
      const rs = Math.round(s);
      const dq = Math.abs(rq - q);
      const dr = Math.abs(rr - r);
      const ds = Math.abs(rs - s);
      if (dq > dr && dq > ds) rq = -rr - rs;
      else if (dr > ds) rr = -rq - rs;
      cells.push(axialToOffset(rq + 0, rr + 0, a.z ?? 0));
    }
    return cells;
  },
};

/** The same helpers for square grids. */
export const Square = {
  /** Up, right, down, left. */
  neighbors4(cell: CellLike): Vector3Int[] {
    const z = cell.z ?? 0;
    return [
      new Vector3Int(cell.x, cell.y + 1, z),
      new Vector3Int(cell.x + 1, cell.y, z),
      new Vector3Int(cell.x, cell.y - 1, z),
      new Vector3Int(cell.x - 1, cell.y, z),
    ];
  },

  /** The four sides plus the four diagonals. */
  neighbors8(cell: CellLike): Vector3Int[] {
    const z = cell.z ?? 0;
    const cells: Vector3Int[] = [];
    for (let dy = 1; dy >= -1; dy--) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) cells.push(new Vector3Int(cell.x + dx, cell.y + dy, z));
      }
    }
    return cells;
  },

  /** Steps between cells when moving on the four sides only. */
  manhattan(a: CellLike, b: CellLike): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  },

  /** Steps between cells when diagonal moves are allowed. */
  chebyshev(a: CellLike, b: CellLike): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  },
};
