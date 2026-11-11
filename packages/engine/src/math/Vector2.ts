import { Mathf } from './Mathf';

/**
 * Immutable 2D vector. Every operation returns a new instance, which gives the same
 * "value type" behaviour as a C# struct: nobody can mutate a vector you are holding.
 */
export class Vector2 {
  constructor(
    readonly x: number = 0,
    readonly y: number = 0,
  ) {}

  static readonly zero = new Vector2(0, 0);
  static readonly one = new Vector2(1, 1);
  static readonly up = new Vector2(0, 1);
  static readonly down = new Vector2(0, -1);
  static readonly left = new Vector2(-1, 0);
  static readonly right = new Vector2(1, 0);

  get sqrMagnitude(): number {
    return this.x * this.x + this.y * this.y;
  }

  get magnitude(): number {
    return Math.sqrt(this.sqrMagnitude);
  }

  get normalized(): Vector2 {
    const length = this.magnitude;
    return length > Mathf.epsilon ? new Vector2(this.x / length, this.y / length) : Vector2.zero;
  }

  /** Unity: `a + b`. */
  add(other: Vector2): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  /** Unity: `a - b`. */
  sub(other: Vector2): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  /** Unity: `a * scalar`. */
  mul(scalar: number): Vector2 {
    return new Vector2(this.x * scalar, this.y * scalar);
  }

  /** Unity: `a / scalar`. */
  div(scalar: number): Vector2 {
    return new Vector2(this.x / scalar, this.y / scalar);
  }

  /** Component-wise multiply. Unity: `Vector2.Scale(a, b)`. */
  scale(other: Vector2): Vector2 {
    return new Vector2(this.x * other.x, this.y * other.y);
  }

  /** Unity: `-a`. */
  neg(): Vector2 {
    return new Vector2(-this.x, -this.y);
  }

  dot(other: Vector2): number {
    return this.x * other.x + this.y * other.y;
  }

  withX(x: number): Vector2 {
    return new Vector2(x, this.y);
  }

  withY(y: number): Vector2 {
    return new Vector2(this.x, y);
  }

  equals(other: Vector2, tolerance = 1e-5): boolean {
    return Math.abs(this.x - other.x) <= tolerance && Math.abs(this.y - other.y) <= tolerance;
  }

  toArray(): [number, number] {
    return [this.x, this.y];
  }

  toString(): string {
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }

  static dot(a: Vector2, b: Vector2): number {
    return a.dot(b);
  }

  static distance(a: Vector2, b: Vector2): number {
    return a.sub(b).magnitude;
  }

  static lerp(a: Vector2, b: Vector2, t: number): Vector2 {
    return Vector2.lerpUnclamped(a, b, Mathf.clamp01(t));
  }

  static lerpUnclamped(a: Vector2, b: Vector2, t: number): Vector2 {
    return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }

  static moveTowards(current: Vector2, target: Vector2, maxDistanceDelta: number): Vector2 {
    const delta = target.sub(current);
    const distance = delta.magnitude;
    if (distance <= maxDistanceDelta || distance < Mathf.epsilon) return target;
    return current.add(delta.mul(maxDistanceDelta / distance));
  }

  /** Unsigned angle in degrees between two directions. */
  static angle(from: Vector2, to: Vector2): number {
    const denominator = Math.sqrt(from.sqrMagnitude * to.sqrMagnitude);
    if (denominator < 1e-15) return 0;
    return Math.acos(Mathf.clamp(from.dot(to) / denominator, -1, 1)) * Mathf.rad2Deg;
  }

  static min(a: Vector2, b: Vector2): Vector2 {
    return new Vector2(Math.min(a.x, b.x), Math.min(a.y, b.y));
  }

  static max(a: Vector2, b: Vector2): Vector2 {
    return new Vector2(Math.max(a.x, b.x), Math.max(a.y, b.y));
  }
}
