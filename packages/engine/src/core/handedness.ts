import * as pc from 'playcanvas';
import { Bounds } from '../math/geometry';
import { Quaternion, type QuaternionLike } from '../math/Quaternion';
import { Vector3, type Vector3Like } from '../math/Vector3';

// The engine's API uses Unity's space: left-handed, Y up, +Z forward. PlayCanvas is
// right-handed with -Z forward. The two differ by a mirror of the Z axis, so every value
// that crosses into or out of PlayCanvas goes through one of these functions:
//
//   position or direction   (x, y, z)    <->  (x, y, -z)
//   rotation                (x, y, z, w) <->  (-x, -y, z, w)
//   scale                   unchanged
//
// The mirror is its own inverse, so the same function converts in both directions. A
// rotation converted this way is still a proper rotation, so the result renders exactly
// as the same numbers would in Unity: a camera at (0, 1, -10) looking along +Z sees an
// object at the origin with +X on its right, as in Unity's default scene.

/** @internal A Unity-space point or direction as PlayCanvas's. Writes into `out` when given. */
export function toPlayCanvasVec3(value: Vector3Like, out: pc.Vec3 = new pc.Vec3()): pc.Vec3 {
  return out.set(value.x, value.y, -value.z);
}

/** @internal A PlayCanvas point or direction as a Unity-space `Vector3`. */
export function fromPlayCanvasVec3(value: Vector3Like): Vector3 {
  return new Vector3(value.x, value.y, -value.z);
}

/** @internal A Unity-space rotation as PlayCanvas's. Writes into `out` when given. */
export function toPlayCanvasQuat(value: QuaternionLike, out: pc.Quat = new pc.Quat()): pc.Quat {
  return out.set(-value.x, -value.y, value.z, value.w);
}

/** @internal A PlayCanvas rotation as a Unity-space `Quaternion`. */
export function fromPlayCanvasQuat(value: QuaternionLike): Quaternion {
  return new Quaternion(-value.x, -value.y, value.z, value.w);
}

/** @internal A PlayCanvas bounding box (world or mesh space) as Unity-space `Bounds`. */
export function fromPlayCanvasAabb(aabb: pc.BoundingBox): Bounds {
  const min = aabb.getMin();
  const max = aabb.getMax();
  // Mirroring Z swaps which end is the minimum.
  return Bounds.fromMinMax(new Vector3(min.x, min.y, -max.z), new Vector3(max.x, max.y, -min.z));
}
