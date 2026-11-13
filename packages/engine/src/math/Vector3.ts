import { Mathf } from './Mathf';

/** Below this, a length or denominator counts as zero (engine tolerance, not `Mathf.epsilon`). */
const TINY = 1e-6;

/** Unity's `Vector3.kEpsilon`: shorter vectors normalise to zero. */
const NORMALIZE_EPSILON = 1e-5;

/** Anything with x/y/z, e.g. a PlayCanvas `Vec3`. */
export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Immutable 3D vector. Every operation returns a new instance, which gives the same
 * "value type" behaviour as a C# struct. C# operators become methods:
 *
 *   a + b  -> a.add(b)      a * 2 -> a.mul(2)      -a -> a.neg()
 *   a - b  -> a.sub(b)      a / 2 -> a.div(2)
 *
 * Same axes as Unity: left-handed, Y up, X right, Z forward. `Vector3.forward` is
 * (0, 0, 1), so positions, directions and angles copied from Unity code or a Unity scene
 * mean the same thing here. (The renderer underneath, PlayCanvas, is right-handed; the
 * engine converts at that boundary, so game code never sees its convention.)
 */
export class Vector3 implements Vector3Like {
  constructor(
    readonly x: number = 0,
    readonly y: number = 0,
    readonly z: number = 0,
  ) {}

  static readonly zero = Object.freeze(new Vector3(0, 0, 0));
  static readonly one = Object.freeze(new Vector3(1, 1, 1));
  static readonly up = Object.freeze(new Vector3(0, 1, 0));
  static readonly down = Object.freeze(new Vector3(0, -1, 0));
  static readonly left = Object.freeze(new Vector3(-1, 0, 0));
  static readonly right = Object.freeze(new Vector3(1, 0, 0));
  /** (0, 0, 1): the direction an unrotated object (and camera) faces. Same as Unity. */
  static readonly forward = Object.freeze(new Vector3(0, 0, 1));
  /** (0, 0, -1). Same as Unity. */
  static readonly back = Object.freeze(new Vector3(0, 0, -1));

  static from(value: Vector3Like): Vector3 {
    return new Vector3(value.x, value.y, value.z);
  }

  get sqrMagnitude(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  get magnitude(): number {
    return Math.sqrt(this.sqrMagnitude);
  }

  /** This vector with a length of 1, or `Vector3.zero` when its length is 1e-5 or less (as in Unity). */
  get normalized(): Vector3 {
    const length = this.magnitude;
    return length > NORMALIZE_EPSILON ? new Vector3(this.x / length, this.y / length, this.z / length) : Vector3.zero;
  }

  /** Unity: `a + b`. */
  add(other: Vector3Like): Vector3 {
    return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  /** Unity: `a - b`. */
  sub(other: Vector3Like): Vector3 {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** Unity: `a * scalar`. */
  mul(scalar: number): Vector3 {
    return new Vector3(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  /** Unity: `a / scalar`. */
  div(scalar: number): Vector3 {
    return new Vector3(this.x / scalar, this.y / scalar, this.z / scalar);
  }

  /** Component-wise multiply. Unity: `Vector3.Scale(a, b)`. */
  scale(other: Vector3Like): Vector3 {
    return new Vector3(this.x * other.x, this.y * other.y, this.z * other.z);
  }

  /** Unity: `-a`. */
  neg(): Vector3 {
    return new Vector3(-this.x, -this.y, -this.z);
  }

  dot(other: Vector3Like): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  /**
   * Cross product, same formula and result as Unity's `Vector3.Cross(this, other)`. In
   * Unity's left-handed world `Vector3.Cross(Vector3.right, Vector3.up)` is `forward`.
   */
  cross(other: Vector3Like): Vector3 {
    return new Vector3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  withX(x: number): Vector3 {
    return new Vector3(x, this.y, this.z);
  }

  withY(y: number): Vector3 {
    return new Vector3(this.x, y, this.z);
  }

  withZ(z: number): Vector3 {
    return new Vector3(this.x, this.y, z);
  }

  /**
   * Approximate equality: Unity's `a == b` on vectors (true when the two are less than
   * `tolerance` apart, 1e-5 by default, as in Unity). `===` compares object identity and
   * is false for two equal vectors; write `!a.equals(b)` for Unity's `a != b`.
   */
  equals(other: Vector3Like, tolerance = 1e-5): boolean {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return dx * dx + dy * dy + dz * dz < tolerance * tolerance;
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)}, ${this.z.toFixed(2)})`;
  }

  static dot(a: Vector3Like, b: Vector3Like): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  static cross(a: Vector3, b: Vector3Like): Vector3 {
    return a.cross(b);
  }

  static distance(a: Vector3Like, b: Vector3Like): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  static lerp(a: Vector3Like, b: Vector3Like, t: number): Vector3 {
    return Vector3.lerpUnclamped(a, b, Mathf.clamp01(t));
  }

  static lerpUnclamped(a: Vector3Like, b: Vector3Like, t: number): Vector3 {
    return new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }

  /** Moves `current` toward `target` by at most `maxDistanceDelta`, never overshooting. */
  static moveTowards(current: Vector3, target: Vector3, maxDistanceDelta: number): Vector3 {
    const delta = target.sub(current);
    const distance = delta.magnitude;
    if (distance <= maxDistanceDelta || distance < TINY) return target;
    return current.add(delta.mul(maxDistanceDelta / distance));
  }

  /** Unsigned angle in degrees between two directions. */
  static angle(from: Vector3, to: Vector3): number {
    const denominator = Math.sqrt(from.sqrMagnitude * to.sqrMagnitude);
    if (denominator < 1e-15) return 0;
    return Math.acos(Mathf.clamp(from.dot(to) / denominator, -1, 1)) * Mathf.rad2Deg;
  }

  /**
   * Signed angle in degrees from `from` to `to`, measured around `axis`: positive when the
   * turn is clockwise seen from the tip of `axis` (Unity's left-handed rule, so a turn from
   * `forward` to `right` around `up` is +90, as in Unity).
   */
  static signedAngle(from: Vector3, to: Vector3, axis: Vector3): number {
    const unsigned = Vector3.angle(from, to);
    return unsigned * Mathf.sign(axis.dot(from.cross(to)));
  }

  static project(vector: Vector3, onNormal: Vector3): Vector3 {
    const sqrMagnitude = onNormal.sqrMagnitude;
    if (sqrMagnitude < TINY) return Vector3.zero;
    return onNormal.mul(vector.dot(onNormal) / sqrMagnitude);
  }

  static projectOnPlane(vector: Vector3, planeNormal: Vector3): Vector3 {
    return vector.sub(Vector3.project(vector, planeNormal));
  }

  static reflect(inDirection: Vector3, inNormal: Vector3): Vector3 {
    return inDirection.sub(inNormal.mul(2 * inDirection.dot(inNormal)));
  }

  static clampMagnitude(vector: Vector3, maxLength: number): Vector3 {
    const sqrMagnitude = vector.sqrMagnitude;
    if (sqrMagnitude <= maxLength * maxLength) return vector;
    return vector.mul(maxLength / Math.sqrt(sqrMagnitude));
  }

  static min(a: Vector3Like, b: Vector3Like): Vector3 {
    return new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  }

  static max(a: Vector3Like, b: Vector3Like): Vector3 {
    return new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
  }

  static scale(a: Vector3, b: Vector3Like): Vector3 {
    return a.scale(b);
  }
}
