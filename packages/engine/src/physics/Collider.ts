import { Behaviour } from '../core/Component';
import type { GameObject } from '../core/GameObject';
import { currentEngine } from '../core/runtime';
import type { Transform } from '../core/Transform';
import { Bounds, intersectRayBox, intersectRaySphere, type Ray } from '../math/geometry';
import { Vector3 } from '../math/Vector3';

/** What a raycast hit. */
export interface RaycastHit {
  collider: Collider;
  /** Shortcut for `collider.gameObject`. */
  gameObject: GameObject;
  /** Shortcut for `collider.transform`. */
  transform: Transform;
  /** World-space point where the ray entered the collider. */
  point: Vector3;
  /** World-space surface direction at that point. */
  normal: Vector3;
  /** Distance from the ray's origin to `point`. */
  distance: number;
}

/**
 * Base class for shapes that `Physics` queries (raycasts, overlap tests) can find.
 *
 * Colliders here are for picking and spatial queries only: there is no rigidbody
 * simulation, so nothing falls, bounces, or sends collision/trigger messages yet.
 */
export abstract class Collider extends Behaviour {
  /** Kept for Unity parity; has no effect until trigger events exist. */
  isTrigger = false;

  override _enable(): void {
    currentEngine().colliders.add(this);
  }

  override _disable(): void {
    currentEngine().colliders.delete(this);
  }

  /** World-space axis-aligned box that encloses the collider. */
  abstract get bounds(): Bounds;

  /** @internal Entry distance and surface normal for a world-space ray, or `null`. */
  abstract _intersect(origin: Vector3, direction: Vector3): { distance: number; normal: Vector3 } | null;

  /**
   * Casts a ray against just this collider. Unity: `collider.Raycast(ray, out hit, maxDistance)`.
   */
  raycast(ray: Ray, maxDistance = Number.POSITIVE_INFINITY): RaycastHit | null {
    const result = this._intersect(ray.origin, ray.direction);
    if (!result || result.distance > maxDistance) return null;
    return {
      collider: this,
      gameObject: this.gameObject,
      transform: this.transform,
      point: ray.getPoint(result.distance),
      normal: result.normal,
      distance: result.distance,
    };
  }

  /** The point on (or in) the collider's bounds closest to `position`. */
  closestPointOnBounds(position: Vector3): Vector3 {
    return this.bounds.closestPoint(position);
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    this.isTrigger = source.isTrigger;
  }
}

/** A box in the object's local space. */
export class BoxCollider extends Collider {
  center = Vector3.zero;
  size = Vector3.one;

  get bounds(): Bounds {
    const half = this.size.mul(0.5);
    let bounds: Bounds | null = null;
    for (let i = 0; i < 8; i++) {
      const corner = this.transform.transformPoint(
        new Vector3(
          this.center.x + (i & 1 ? half.x : -half.x),
          this.center.y + (i & 2 ? half.y : -half.y),
          this.center.z + (i & 4 ? half.z : -half.z),
        ),
      );
      bounds = bounds ? bounds.encapsulate(corner) : new Bounds(corner, Vector3.zero);
    }
    return bounds as Bounds;
  }

  override _intersect(origin: Vector3, direction: Vector3) {
    // Work in local space, where the box is axis-aligned. The local direction is left
    // un-normalised so that the hit parameter is still a world-space distance.
    const transform = this.transform;
    const localOrigin = transform.inverseTransformPoint(origin);
    const localDirection = transform.inverseTransformVector(direction);
    const half = this.size.mul(0.5);
    const hit = intersectRayBox(localOrigin, localDirection, this.center.sub(half), this.center.add(half));
    if (!hit) return null;
    const normal = hit.distance === 0 ? direction.neg() : transform.transformDirection(hit.normal).normalized;
    return { distance: hit.distance, normal };
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source);
    this.center = source.center;
    this.size = source.size;
  }
}

/** A sphere in the object's local space. Under non-uniform scale it uses the largest axis, as in Unity. */
export class SphereCollider extends Collider {
  center = Vector3.zero;
  radius = 0.5;

  private world(): { center: Vector3; radius: number } {
    const scale = this.transform.lossyScale;
    return {
      center: this.transform.transformPoint(this.center),
      radius: this.radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)),
    };
  }

  get bounds(): Bounds {
    const { center, radius } = this.world();
    return new Bounds(center, Vector3.one.mul(radius * 2));
  }

  override _intersect(origin: Vector3, direction: Vector3) {
    const { center, radius } = this.world();
    const distance = intersectRaySphere(origin, direction, center, radius);
    if (distance === null) return null;
    const point = origin.add(direction.mul(distance));
    const normal = distance === 0 ? direction.neg() : point.sub(center).normalized;
    return { distance, normal };
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source);
    this.center = source.center;
    this.radius = source.radius;
  }
}

/** A capsule along the object's local Y axis. `height` includes both rounded ends. */
export class CapsuleCollider extends Collider {
  center = Vector3.zero;
  radius = 0.5;
  height = 2;

  private world(): { a: Vector3; b: Vector3; radius: number } {
    const scale = this.transform.lossyScale;
    const radius = this.radius * Math.max(Math.abs(scale.x), Math.abs(scale.z));
    const halfSegment = Math.max(0, (this.height * Math.abs(scale.y)) / 2 - radius);
    const center = this.transform.transformPoint(this.center);
    const axis = this.transform.up.mul(halfSegment);
    return { a: center.sub(axis), b: center.add(axis), radius };
  }

  get bounds(): Bounds {
    const { a, b, radius } = this.world();
    const pad = Vector3.one.mul(radius);
    return Bounds.fromMinMax(Vector3.min(a, b).sub(pad), Vector3.max(a, b).add(pad));
  }

  override _intersect(origin: Vector3, direction: Vector3) {
    const { a, b, radius } = this.world();
    const distance = intersectRayCapsule(origin, direction, a, b, radius);
    if (distance === null) return null;
    if (distance === 0) return { distance, normal: direction.neg() };
    const point = origin.add(direction.mul(distance));
    const axis = b.sub(a);
    const lengthSquared = axis.sqrMagnitude;
    const t = lengthSquared > 0 ? Math.min(1, Math.max(0, point.sub(a).dot(axis) / lengthSquared)) : 0;
    return { distance, normal: point.sub(a.add(axis.mul(t))).normalized };
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source);
    this.center = source.center;
    this.radius = source.radius;
    this.height = source.height;
  }
}

/** Ray vs capsule (segment `a`-`b` with `radius`). Returns entry distance or `null`. */
function intersectRayCapsule(
  origin: Vector3,
  direction: Vector3,
  a: Vector3,
  b: Vector3,
  radius: number,
): number | null {
  const ba = b.sub(a);
  const oa = origin.sub(a);
  const baba = ba.dot(ba);
  if (baba < 1e-12) return intersectRaySphere(origin, direction, a, radius);

  const candidates: number[] = [];
  const bard = ba.dot(direction);
  const baoa = ba.dot(oa);
  const rdoa = direction.dot(oa);
  const oaoa = oa.dot(oa);
  const qa = baba - bard * bard;
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - radius * radius * baba;
  const h = qb * qb - qa * qc;
  if (qa > 1e-12 && h >= 0) {
    const t = (-qb - Math.sqrt(h)) / qa;
    const y = baoa + t * bard;
    // Only the cylindrical part counts here; the ends are handled as spheres below.
    if (t >= 0 && y > 0 && y < baba) candidates.push(t);
  }
  for (const end of [a, b]) {
    const t = intersectRaySphere(origin, direction, end, radius);
    if (t !== null) candidates.push(t);
  }
  // Starting inside the cylindrical part.
  const along = Math.min(1, Math.max(0, baoa / baba));
  if (origin.sub(a.add(ba.mul(along))).sqrMagnitude <= radius * radius) return 0;
  return candidates.length ? Math.min(...candidates) : null;
}
