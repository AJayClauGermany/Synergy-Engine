import { Mathf } from './Mathf';
import { Vector3, type Vector3Like } from './Vector3';

/** Anything usable as a grid cell: `{ x, y }` or `{ x, y, z }`. Plain objects work. */
export interface CellLike {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

/**
 * Immutable integer vector. Unity uses it for grid cells: `x` and `y` are the cell,
 * `z` is the layer (usually 0).
 */
export class Vector3Int implements CellLike {
  constructor(
    readonly x: number = 0,
    readonly y: number = 0,
    readonly z: number = 0,
  ) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) throw notWhole('Vector3Int', [x, y, z]);
  }

  static readonly zero = Object.freeze(new Vector3Int(0, 0, 0));
  static readonly one = Object.freeze(new Vector3Int(1, 1, 1));
  static readonly up = Object.freeze(new Vector3Int(0, 1, 0));
  static readonly down = Object.freeze(new Vector3Int(0, -1, 0));
  static readonly left = Object.freeze(new Vector3Int(-1, 0, 0));
  static readonly right = Object.freeze(new Vector3Int(1, 0, 0));

  /** Accepts a `Vector3Int`, `Vector2Int` or a plain `{ x, y, z? }`. */
  static from(cell: CellLike): Vector3Int {
    return cell instanceof Vector3Int ? cell : new Vector3Int(cell.x, cell.y, cell.z ?? 0);
  }

  static floorToInt(v: Vector3Like): Vector3Int {
    return new Vector3Int(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
  }

  static roundToInt(v: Vector3Like): Vector3Int {
    return new Vector3Int(Mathf.roundToInt(v.x), Mathf.roundToInt(v.y), Mathf.roundToInt(v.z));
  }

  static ceilToInt(v: Vector3Like): Vector3Int {
    return new Vector3Int(Math.ceil(v.x), Math.ceil(v.y), Math.ceil(v.z));
  }

  static distance(a: CellLike, b: CellLike): number {
    return Vector3Int.from(a).sub(b).magnitude;
  }

  get sqrMagnitude(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  get magnitude(): number {
    return Math.sqrt(this.sqrMagnitude);
  }

  add(other: CellLike): Vector3Int {
    return new Vector3Int(this.x + other.x, this.y + other.y, this.z + (other.z ?? 0));
  }

  sub(other: CellLike): Vector3Int {
    return new Vector3Int(this.x - other.x, this.y - other.y, this.z - (other.z ?? 0));
  }

  mul(scalar: number): Vector3Int {
    return new Vector3Int(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  /** Exact comparison (these are integers). A missing `z` counts as 0. */
  equals(other: CellLike): boolean {
    return this.x === other.x && this.y === other.y && this.z === (other.z ?? 0);
  }

  toVector3(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  /** A string unique to this cell, for use as a `Map` or `Set` key. */
  get key(): string {
    return `${this.x},${this.y},${this.z}`;
  }

  toString(): string {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

/**
 * In C# these hold `int`s, and `new Vector3Int(7 / 2, 0, 0)` is (3, 0, 0) because the
 * division already dropped the half. Here `7 / 2` is 3.5, and a vector that kept it would
 * be a cell that equals no cell.
 */
function notWhole(type: string, parts: readonly number[]): RangeError {
  return new RangeError(
    `new ${type}(${parts.join(', ')}): an integer vector holds whole numbers. ` +
      'For a division write Math.trunc(a / b) (C# does that for ints); for a world position use grid.worldToCell(position).',
  );
}

/**
 * The `Map`/`Set` key for any cell-like value. Equal cells give equal keys.
 *
 * A cell is made of whole numbers. A world position has `x` and `y` too, so
 * `tilemap.getTile(unit.transform.position)` type-checks; it would read a cell at
 * (2.5, 0, -3.5) that nothing else can reach. That is refused here, where every lookup
 * by cell passes.
 */
export function cellKey(cell: CellLike): string {
  const z = cell.z ?? 0;
  if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !Number.isInteger(z)) {
    throw new RangeError(
      `(${cell.x}, ${cell.y}, ${z}) is not a cell: a cell's coordinates are whole numbers. ` +
        'For a world position use grid.worldToCell(position); for a division, Math.trunc(a / b).',
    );
  }
  return `${cell.x},${cell.y},${z}`;
}

/** Immutable 2D integer vector. */
export class Vector2Int implements CellLike {
  constructor(
    readonly x: number = 0,
    readonly y: number = 0,
  ) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw notWhole('Vector2Int', [x, y]);
  }

  static readonly zero = Object.freeze(new Vector2Int(0, 0));
  static readonly one = Object.freeze(new Vector2Int(1, 1));
  static readonly up = Object.freeze(new Vector2Int(0, 1));
  static readonly down = Object.freeze(new Vector2Int(0, -1));
  static readonly left = Object.freeze(new Vector2Int(-1, 0));
  static readonly right = Object.freeze(new Vector2Int(1, 0));

  static from(cell: CellLike): Vector2Int {
    return cell instanceof Vector2Int ? cell : new Vector2Int(cell.x, cell.y);
  }

  add(other: CellLike): Vector2Int {
    return new Vector2Int(this.x + other.x, this.y + other.y);
  }

  sub(other: CellLike): Vector2Int {
    return new Vector2Int(this.x - other.x, this.y - other.y);
  }

  mul(scalar: number): Vector2Int {
    return new Vector2Int(this.x * scalar, this.y * scalar);
  }

  equals(other: CellLike): boolean {
    return this.x === other.x && this.y === other.y;
  }

  get sqrMagnitude(): number {
    return this.x * this.x + this.y * this.y;
  }

  get magnitude(): number {
    return Math.sqrt(this.sqrMagnitude);
  }

  toString(): string {
    return `(${this.x}, ${this.y})`;
  }
}

/** An integer box of cells. `min` is inclusive and `max` is exclusive, as in Unity. */
export class BoundsInt {
  constructor(
    readonly position: Vector3Int = Vector3Int.zero,
    readonly size: Vector3Int = Vector3Int.zero,
  ) {}

  /** Builds bounds from an inclusive minimum and an exclusive maximum. */
  static fromMinMax(min: CellLike, max: CellLike): BoundsInt {
    const lo = Vector3Int.from(min);
    // A 2D maximum ({ x, y }) means one layer of cells, not none: z is exclusive.
    const hi = new Vector3Int(max.x, max.y, max.z ?? lo.z + 1);
    return new BoundsInt(lo, hi.sub(lo));
  }

  get min(): Vector3Int {
    return this.position;
  }

  get max(): Vector3Int {
    return this.position.add(this.size);
  }

  contains(cell: CellLike): boolean {
    const { min, max } = this;
    const z = cell.z ?? 0;
    return cell.x >= min.x && cell.x < max.x && cell.y >= min.y && cell.y < max.y && z >= min.z && z < max.z;
  }

  /** Every cell inside the bounds: `for (const cell of bounds.allPositionsWithin())`. */
  *allPositionsWithin(): IterableIterator<Vector3Int> {
    const { min, max } = this;
    for (let z = min.z; z < max.z; z++) {
      for (let y = min.y; y < max.y; y++) {
        for (let x = min.x; x < max.x; x++) yield new Vector3Int(x, y, z);
      }
    }
  }

  toString(): string {
    return `Position: ${this.position}, Size: ${this.size}`;
  }
}
