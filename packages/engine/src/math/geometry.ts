import { ENGINE_EPSILON } from './Mathf';
import { Vector3 } from './Vector3';

/** An infinite line starting at `origin` going along `direction` (always normalised). */
export class Ray {
  readonly direction: Vector3;

  constructor(
    readonly origin: Vector3,
    direction: Vector3,
  ) {
    this.direction = direction.normalized;
  }

  /** The point `distance` units along the ray. */
  getPoint(distance: number): Vector3 {
    return this.origin.add(this.direction.mul(distance));
  }

  toString(): string {
    return `Origin: ${this.origin}, Dir: ${this.direction}`;
  }
}

/**
 * An infinite plane. Strategy games use this constantly to turn a mouse position into a
 * point on the ground:
 *
 *   const ground = new Plane(Vector3.up, Vector3.zero);
 *   const distance = ground.raycast(camera.screenPointToRay(Input.mousePosition));
 *   if (distance !== null) target = ray.getPoint(distance);
 */
export class Plane {
  readonly normal: Vector3;
  /** Signed distance from the origin to the plane along the normal, negated (Unity's convention). */
  readonly distance: number;

  constructor(normal: Vector3, point: Vector3);
  constructor(normal: Vector3, distance: number);
  constructor(normal: Vector3, pointOrDistance: Vector3 | number) {
    this.normal = normal.normalized;
    this.distance = typeof pointOrDistance === 'number' ? pointOrDistance : -this.normal.dot(pointOrDistance);
  }

  /**
   * Distance along `ray` at which it crosses the plane, or `null` if it is parallel or
   * the plane is behind the ray. (C# returns a bool and writes the distance through `out`.)
   */
  raycast(ray: Ray): number | null {
    const denominator = ray.direction.dot(this.normal);
    if (Math.abs(denominator) < ENGINE_EPSILON) return null;
    const distance = -(ray.origin.dot(this.normal) + this.distance) / denominator;
    return distance >= 0 ? distance : null;
  }

  /** Signed distance from the plane to `point` (positive on the normal's side). */
  getDistanceToPoint(point: Vector3): number {
    return this.normal.dot(point) + this.distance;
  }

  getSide(point: Vector3): boolean {
    return this.getDistanceToPoint(point) > 0;
  }

  closestPointOnPlane(point: Vector3): Vector3 {
    return point.sub(this.normal.mul(this.getDistanceToPoint(point)));
  }
}

/** Immutable axis-aligned bounding box. */
export class Bounds {
  constructor(
    readonly center: Vector3 = Vector3.zero,
    readonly size: Vector3 = Vector3.zero,
  ) {}

  static fromMinMax(min: Vector3, max: Vector3): Bounds {
    return new Bounds(min.add(max).mul(0.5), max.sub(min));
  }

  get extents(): Vector3 {
    return this.size.mul(0.5);
  }

  get min(): Vector3 {
    return this.center.sub(this.extents);
  }

  get max(): Vector3 {
    return this.center.add(this.extents);
  }

  contains(point: Vector3): boolean {
    const { min, max } = this;
    return (
      point.x >= min.x &&
      point.x <= max.x &&
      point.y >= min.y &&
      point.y <= max.y &&
      point.z >= min.z &&
      point.z <= max.z
    );
  }

  intersects(other: Bounds): boolean {
    const a = this;
    return (
      a.min.x <= other.max.x &&
      a.max.x >= other.min.x &&
      a.min.y <= other.max.y &&
      a.max.y >= other.min.y &&
      a.min.z <= other.max.z &&
      a.max.z >= other.min.z
    );
  }

  /** Returns a new bounds grown to include `point`. */
  encapsulate(point: Vector3): Bounds {
    return Bounds.fromMinMax(Vector3.min(this.min, point), Vector3.max(this.max, point));
  }

  closestPoint(point: Vector3): Vector3 {
    return Vector3.max(this.min, Vector3.min(this.max, point));
  }

  /** Distance along `ray` to the box, or `null` on a miss. 0 when the ray starts inside. */
  intersectRay(ray: Ray): number | null {
    return intersectRayBox(ray.origin, ray.direction, this.min, this.max)?.distance ?? null;
  }
}

/** Slab test shared by `Bounds` and `BoxCollider`. Returns entry distance and the face hit. */
export function intersectRayBox(
  origin: Vector3,
  direction: Vector3,
  min: Vector3,
  max: Vector3,
): { distance: number; normal: Vector3 } | null {
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  let axisHit = -1;
  let signHit = 0;
  const o = origin.toArray();
  const d = direction.toArray();
  const lo = min.toArray();
  const hi = max.toArray();
  for (let axis = 0; axis < 3; axis++) {
    const oa = o[axis] as number;
    const da = d[axis] as number;
    const la = lo[axis] as number;
    const ha = hi[axis] as number;
    if (Math.abs(da) < 1e-12) {
      if (oa < la || oa > ha) return null;
      continue;
    }
    let t1 = (la - oa) / da;
    let t2 = (ha - oa) / da;
    let sign = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axisHit = axis;
      signHit = sign;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  if (tMin < 0 || axisHit < 0) {
    // Ray starts inside the box.
    return { distance: 0, normal: direction.neg() };
  }
  const normal = [0, 0, 0];
  normal[axisHit] = signHit;
  return { distance: tMin, normal: new Vector3(normal[0], normal[1], normal[2]) };
}

/** Ray vs sphere. Returns the entry distance, or `null` on a miss. 0 when starting inside. */
export function intersectRaySphere(
  origin: Vector3,
  direction: Vector3,
  center: Vector3,
  radius: number,
): number | null {
  const toOrigin = origin.sub(center);
  const b = toOrigin.dot(direction);
  const c = toOrigin.sqrMagnitude - radius * radius;
  if (c <= 0) return 0;
  if (b > 0) return null;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  return -b - Math.sqrt(discriminant);
}
