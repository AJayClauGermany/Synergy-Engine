import { Mathf } from './Mathf';
import { Vector3, type Vector3Like } from './Vector3';

/** Below this, a length or denominator counts as zero (engine tolerance, not `Mathf.epsilon`). */
const TINY = 1e-6;

/** Anything with x/y/z/w, e.g. a PlayCanvas `Quat`. */
export interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Immutable rotation, with Unity's conventions throughout. C# operators become methods:
 *
 *   a * b        -> a.mul(b)      (apply `b` first, then `a`)
 *   rotation * v -> rotation.rotate(v)
 *   a == b       -> a.equals(b)
 *
 * Same as Unity: angles are in degrees, a positive angle turns clockwise as seen from
 * the positive end of the axis, e.g. from above for `up` (so `Quaternion.euler(0, 90, 0)` turns `forward` into `right`, and
 * `euler(30, 0, 0)` tilts it down), and Euler angles apply Z, then X, then Y. Values
 * copied from Unity's Inspector or code give the same orientation here.
 */
export class Quaternion implements QuaternionLike {
  constructor(
    readonly x: number = 0,
    readonly y: number = 0,
    readonly z: number = 0,
    readonly w: number = 1,
  ) {}

  static readonly identity = Object.freeze(new Quaternion(0, 0, 0, 1));

  static from(value: QuaternionLike): Quaternion {
    return new Quaternion(value.x, value.y, value.z, value.w);
  }

  /**
   * Rotation from Euler angles in degrees: `z` about forward, then `x` about right, then
   * `y` about up. Same as Unity's `Quaternion.Euler(x, y, z)`, including the order.
   */
  static euler(x: number, y: number, z: number): Quaternion;
  static euler(angles: Vector3Like): Quaternion;
  static euler(xOrAngles: number | Vector3Like, y = 0, z = 0): Quaternion {
    let x: number;
    if (typeof xOrAngles === 'number') {
      x = xOrAngles;
    } else {
      x = xOrAngles.x;
      y = xOrAngles.y;
      z = xOrAngles.z;
    }
    const halfToRad = 0.5 * Mathf.deg2Rad;
    const sx = Math.sin(x * halfToRad);
    const cx = Math.cos(x * halfToRad);
    const sy = Math.sin(y * halfToRad);
    const cy = Math.cos(y * halfToRad);
    const sz = Math.sin(z * halfToRad);
    const cz = Math.cos(z * halfToRad);
    // Unity's order: rotate about Z, then X, then Y (q = qy * qx * qz).
    return new Quaternion(
      cy * sx * cz + sy * cx * sz,
      sy * cx * cz - cy * sx * sz,
      cy * cx * sz - sy * sx * cz,
      cy * cx * cz + sy * sx * sz,
    );
  }

  /**
   * Rotation of `angle` degrees around `axis` (clockwise seen from the axis's tip). Angle
   * first, as in Unity's `Quaternion.AngleAxis(angle, axis)`. A zero axis gives identity.
   */
  static angleAxis(angle: number, axis: Vector3): Quaternion {
    if (axis.sqrMagnitude < 1e-12) return Quaternion.identity;
    const unit = axis.normalized;
    const half = angle * 0.5 * Mathf.deg2Rad;
    const s = Math.sin(half);
    return new Quaternion(unit.x * s, unit.y * s, unit.z * s, Math.cos(half));
  }

  /**
   * Rotation that points an object's forward (+Z) along `forward`, keeping its up as
   * close to `up` as possible. Same as Unity's `Quaternion.LookRotation`; a zero
   * `forward` gives identity.
   */
  static lookRotation(forward: Vector3, up: Vector3 = Vector3.up): Quaternion {
    const f = forward.normalized;
    if (f.sqrMagnitude < TINY) return Quaternion.identity;
    let right = up.cross(f);
    if (right.sqrMagnitude < TINY) {
      // `forward` is parallel to `up`: pick any perpendicular axis.
      right = (Math.abs(f.y) > 0.999 ? Vector3.forward : Vector3.up).cross(f);
    }
    right = right.normalized;
    const newUp = f.cross(right);
    return Quaternion.fromBasis(right, newUp, f);
  }

  /** Shortest rotation that turns `from` into `to`. */
  static fromToRotation(from: Vector3, to: Vector3): Quaternion {
    const a = from.normalized;
    const b = to.normalized;
    const d = a.dot(b);
    if (d >= 1 - 1e-9) return Quaternion.identity;
    if (d <= -1 + 1e-9) {
      let axis = Vector3.right.cross(a);
      if (axis.sqrMagnitude < TINY) axis = Vector3.up.cross(a);
      return Quaternion.angleAxis(180, axis);
    }
    const c = a.cross(b);
    return new Quaternion(c.x, c.y, c.z, 1 + d).normalized;
  }

  /** Builds a rotation from its three (orthonormal) local axes. */
  private static fromBasis(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): Quaternion {
    const m00 = xAxis.x;
    const m10 = xAxis.y;
    const m20 = xAxis.z;
    const m01 = yAxis.x;
    const m11 = yAxis.y;
    const m21 = yAxis.z;
    const m02 = zAxis.x;
    const m12 = zAxis.y;
    const m22 = zAxis.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return new Quaternion((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
    }
    if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return new Quaternion(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
    }
    if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return new Quaternion((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
    }
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return new Quaternion((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
  }

  static dot(a: QuaternionLike, b: QuaternionLike): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  }

  /** Angle in degrees between two rotations. */
  static angle(a: Quaternion, b: Quaternion): number {
    const d = Math.min(Math.abs(Quaternion.dot(a, b)), 1);
    return d > 1 - 1e-9 ? 0 : Math.acos(d) * 2 * Mathf.rad2Deg;
  }

  static inverse(rotation: Quaternion): Quaternion {
    return rotation.inverse();
  }

  /** Spherical interpolation with `t` clamped to [0, 1]. */
  static slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
    return Quaternion.slerpUnclamped(a, b, Mathf.clamp01(t));
  }

  static slerpUnclamped(a: Quaternion, b: Quaternion, t: number): Quaternion {
    let cosHalfTheta = Quaternion.dot(a, b);
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    if (cosHalfTheta < 0) {
      // Take the short way round.
      cosHalfTheta = -cosHalfTheta;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cosHalfTheta >= 1 - 1e-9) return a;
    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
    if (Math.abs(sinHalfTheta) < 1e-6) {
      return new Quaternion((a.x + bx) * 0.5, (a.y + by) * 0.5, (a.z + bz) * 0.5, (a.w + bw) * 0.5).normalized;
    }
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    return new Quaternion(
      a.x * ratioA + bx * ratioB,
      a.y * ratioA + by * ratioB,
      a.z * ratioA + bz * ratioB,
      a.w * ratioA + bw * ratioB,
    );
  }

  /** Normalised linear interpolation: cheaper than slerp, fine for small angles. */
  static lerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
    const k = Mathf.clamp01(t);
    const sign = Quaternion.dot(a, b) < 0 ? -1 : 1;
    return new Quaternion(
      a.x + (b.x * sign - a.x) * k,
      a.y + (b.y * sign - a.y) * k,
      a.z + (b.z * sign - a.z) * k,
      a.w + (b.w * sign - a.w) * k,
    ).normalized;
  }

  /** Rotates `from` toward `to` by at most `maxDegreesDelta`. */
  static rotateTowards(from: Quaternion, to: Quaternion, maxDegreesDelta: number): Quaternion {
    const angle = Quaternion.angle(from, to);
    if (angle < 1e-6) return to;
    return Quaternion.slerpUnclamped(from, to, Math.min(1, maxDegreesDelta / angle));
  }

  /**
   * Euler angles in degrees, each in [0, 360), as Unity returns them: `euler(-30, 0, 0)`
   * reads back as (330, 0, 0). Several angle sets describe one rotation, so the values
   * read back can differ from the ones set (pitch beyond 90 comes back as yaw and roll
   * of 180). To turn by a step, keep the angle in a field of your own or use
   * `transform.rotate`, rather than adding to what this returns.
   */
  get eulerAngles(): Vector3 {
    const { x: qx, y: qy, z: qz, w: qw } = this;
    // Rotation-matrix terms for q = qy * qx * qz (Unity's Z, X, Y order).
    const m12 = 2 * (qy * qz - qx * qw);
    const sinX = Mathf.clamp(-m12, -1, 1);
    let x: number;
    let y: number;
    let z: number;
    if (Math.abs(sinX) > 0.999999) {
      // Looking straight up or down: yaw and roll turn about the same axis. Put it all in yaw.
      x = (Math.sign(sinX) * Math.PI) / 2;
      const m00 = 1 - 2 * (qy * qy + qz * qz);
      const m20 = 2 * (qx * qz - qy * qw);
      y = Math.atan2(-m20, m00);
      z = 0;
    } else {
      x = Math.asin(sinX);
      y = Math.atan2(2 * (qx * qz + qy * qw), 1 - 2 * (qx * qx + qy * qy));
      z = Math.atan2(2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz));
    }
    return new Vector3(wrapDegrees(x * Mathf.rad2Deg), wrapDegrees(y * Mathf.rad2Deg), wrapDegrees(z * Mathf.rad2Deg));
  }

  get normalized(): Quaternion {
    const length = Math.sqrt(Quaternion.dot(this, this));
    if (length < TINY) return Quaternion.identity;
    return new Quaternion(this.x / length, this.y / length, this.z / length, this.w / length);
  }

  inverse(): Quaternion {
    const sqrLength = Quaternion.dot(this, this);
    if (sqrLength < TINY) return Quaternion.identity;
    return new Quaternion(-this.x / sqrLength, -this.y / sqrLength, -this.z / sqrLength, this.w / sqrLength);
  }

  /** Combines rotations. Unity: `this * other` (`other` is applied first). */
  mul(other: QuaternionLike): Quaternion {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = other;
    return new Quaternion(
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by + ay * bw + az * bx - ax * bz,
      aw * bz + az * bw + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }

  /** Rotates a vector. Unity: `this * vector`. */
  rotate(vector: Vector3Like): Vector3 {
    const { x: qx, y: qy, z: qz, w: qw } = this;
    const { x: vx, y: vy, z: vz } = vector;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v' = v + w * t + cross(q.xyz, t)
    return new Vector3(
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    );
  }

  /**
   * Unity's `a == b`: true when `dot(a, b) > 1 - tolerance` (1e-6 by default, as in
   * Unity, about 0.16 degrees apart). As in Unity, `q` and `-q` (the same orientation
   * written two ways) are not equal; compare `Quaternion.angle(a, b) < 0.1` when either
   * form may come up.
   */
  equals(other: QuaternionLike, tolerance = 1e-6): boolean {
    return Quaternion.dot(this, other) > 1 - tolerance;
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }

  toString(): string {
    return `(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)}, ${this.w.toFixed(3)})`;
  }
}

/** An angle in degrees brought into [0, 360), with values a hair under 360 read as 0. */
function wrapDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 360 - 1e-7 ? 0 : wrapped;
}
