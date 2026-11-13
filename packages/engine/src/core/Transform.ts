import * as pc from 'playcanvas';
import { nameType } from './typeNames';
import { Quaternion } from '../math/Quaternion';
import { Vector3 } from '../math/Vector3';
import { Component } from './Component';
// fallow-ignore-next-line circular-dependency -- a GameObject owns its Transform and a Transform finds its GameObject; both are used in methods, never while the modules load
import { gameObjectOf, isSceneRoot } from './GameObject';
import { currentEngine } from './runtime';
import { fromPlayCanvasQuat, fromPlayCanvasVec3, toPlayCanvasQuat, toPlayCanvasVec3 } from './handedness';

/** Which coordinate system a movement is expressed in. */
export enum Space {
  World = 'world',
  Self = 'self',
}

const scratchVec = new pc.Vec3();
const scratchQuat = new pc.Quat();
const scratchMat = new pc.Mat4();

/**
 * Position, rotation and scale of a GameObject, plus its place in the hierarchy.
 *
 * Same space as Unity: left-handed, Y up, `forward` is +Z, angles in degrees turning
 * clockwise seen from the axis's tip. Values copied from a Unity scene or script mean
 * the same here. (PlayCanvas, underneath, is right-handed; the engine converts.)
 *
 * Unlike Unity, vectors and quaternions are immutable values: assign a new one to move.
 * `transform.position.x = 5` does not compile, and `transform.position.add(delta);` on
 * its own line changes nothing.
 *
 *   transform.position = transform.position.add(Vector3.forward.mul(speed * Time.deltaTime));
 */
export class Transform extends Component implements Iterable<Transform> {
  /** @internal */
  get _node(): pc.Entity {
    return this.gameObject.entity;
  }

  // ---- World space ------------------------------------------------------------------

  /** World-space position. */
  get position(): Vector3 {
    return fromPlayCanvasVec3(this._node.getPosition());
  }

  set position(value: Vector3) {
    this._node.setPosition(toPlayCanvasVec3(value, scratchVec));
  }

  // World rotation and scale are composed from the local values up the parent chain,
  // not decomposed from the world matrix: decomposition turns a mirrored (negative)
  // scale into a bogus 180 degree rotation.

  /** The parent's world rotation (identity for a root object). */
  private parentRotation(): Quaternion {
    let rotation = Quaternion.identity;
    for (let node = this._node.parent; node; node = node.parent) {
      rotation = fromPlayCanvasQuat(node.getLocalRotation()).mul(rotation);
    }
    return rotation;
  }

  /** The parent's world scale, signs included (one for a root object). */
  private parentScale(): Vector3 {
    let scale = Vector3.one;
    for (let node = this._node.parent; node; node = node.parent) {
      scale = scale.scale(node.getLocalScale());
    }
    return scale;
  }

  /** World-space rotation. */
  get rotation(): Quaternion {
    return this.parentRotation().mul(this.localRotation);
  }

  set rotation(value: Quaternion) {
    this.localRotation = this.parentRotation().inverse().mul(value).normalized;
  }

  /**
   * World rotation as Euler angles in degrees, each read back in [0, 360) as in Unity
   * (Z, then X, then Y). Reading, adding and writing back does not always turn smoothly:
   * keep the angle in a field of your own, or use `rotate`.
   */
  get eulerAngles(): Vector3 {
    return this.rotation.eulerAngles;
  }

  set eulerAngles(value: Vector3) {
    this.rotation = Quaternion.euler(value);
  }

  /** World scale. Read-only, and approximate under rotated non-uniform parents (as in Unity). */
  get lossyScale(): Vector3 {
    return this.parentScale().scale(this._node.getLocalScale());
  }

  /** The direction this object faces (its local +Z axis, the blue arrow) in world space. Setting it turns the object to face that way. */
  get forward(): Vector3 {
    return this.rotation.rotate(Vector3.forward);
  }

  set forward(value: Vector3) {
    this.rotation = Quaternion.lookRotation(value);
  }

  /** Its local +X axis (the red arrow) in world space. */
  get right(): Vector3 {
    return this.rotation.rotate(Vector3.right);
  }

  set right(value: Vector3) {
    this.rotation = Quaternion.fromToRotation(Vector3.right, value);
  }

  /** Its local +Y axis (the green arrow) in world space. */
  get up(): Vector3 {
    return this.rotation.rotate(Vector3.up);
  }

  set up(value: Vector3) {
    this.rotation = Quaternion.fromToRotation(Vector3.up, value);
  }

  // ---- Local space ------------------------------------------------------------------

  /** Position relative to the parent (the world, for a root object). */
  get localPosition(): Vector3 {
    return fromPlayCanvasVec3(this._node.getLocalPosition());
  }

  set localPosition(value: Vector3) {
    this._node.setLocalPosition(toPlayCanvasVec3(value, scratchVec));
  }

  /** Rotation relative to the parent. */
  get localRotation(): Quaternion {
    return fromPlayCanvasQuat(this._node.getLocalRotation());
  }

  set localRotation(value: Quaternion) {
    this._node.setLocalRotation(toPlayCanvasQuat(value, scratchQuat));
  }

  /** `localRotation` as Euler angles in degrees, read back in [0, 360) as in Unity. See `eulerAngles`. */
  get localEulerAngles(): Vector3 {
    return this.localRotation.eulerAngles;
  }

  set localEulerAngles(value: Vector3) {
    this.localRotation = Quaternion.euler(value);
  }

  get localScale(): Vector3 {
    return Vector3.from(this._node.getLocalScale());
  }

  set localScale(value: Vector3) {
    this._node.setLocalScale(value.x, value.y, value.z);
  }

  setPositionAndRotation(position: Vector3, rotation: Quaternion): void {
    this.position = position;
    this.rotation = rotation;
  }

  setLocalPositionAndRotation(localPosition: Vector3, localRotation: Quaternion): void {
    this.localPosition = localPosition;
    this.localRotation = localRotation;
  }

  // ---- Hierarchy --------------------------------------------------------------------

  /** The parent transform, or `null` for a root object of its scene. */
  get parent(): Transform | null {
    const parentNode = this._node.parent;
    if (!parentNode || isSceneRoot(parentNode)) return null;
    return gameObjectOf(parentNode as pc.Entity).transform;
  }

  set parent(value: Transform | null) {
    this.setParent(value, true);
  }

  /**
   * Re-parents this transform. With `worldPositionStays` (the default) the object stays
   * where it is in the world; pass `false` to keep its local values instead.
   */
  setParent(parent: Transform | null, worldPositionStays = true): void {
    if (parent === this || parent?.isChildOf(this)) {
      throw new Error(`Cannot parent "${this.name}" to itself or one of its own children.`);
    }
    const node = this._node;
    const newParent = parent ? parent._node : this.gameObject.scene._root;
    if (node.parent === newParent) return;

    const wasActive = this.gameObject.activeInHierarchy;
    if (worldPositionStays) {
      const position = this.position;
      const rotation = this.rotation;
      const scale = this.lossyScale;
      node.reparent(newParent);
      this.position = position;
      this.rotation = rotation;
      const parentScale = this.parentScale();
      this.localScale = new Vector3(
        parentScale.x !== 0 ? scale.x / parentScale.x : scale.x,
        parentScale.y !== 0 ? scale.y / parentScale.y : scale.y,
        parentScale.z !== 0 ? scale.z / parentScale.z : scale.z,
      );
    } else {
      node.reparent(newParent);
    }
    const isActive = this.gameObject.activeInHierarchy;
    if (wasActive !== isActive) {
      currentEngine().lifecycle.hierarchyActiveChanged(node, isActive);
    }
  }

  /** The topmost transform in this object's hierarchy. */
  get root(): Transform {
    let current: Transform = this;
    for (let parent = current.parent; parent; parent = current.parent) current = parent;
    return current;
  }

  get childCount(): number {
    return this._node.children.length;
  }

  getChild(index: number): Transform {
    const child = this._node.children[index];
    if (!child) {
      throw new RangeError(`Transform "${this.name}" has no child at index ${index}.`);
    }
    return gameObjectOf(child as pc.Entity).transform;
  }

  /** Moves this transform before its siblings (drawn first, i.e. underneath, in UI). */
  setAsFirstSibling(): void {
    this.setSiblingIndex(0);
  }

  /** Moves this transform after its siblings (drawn last, i.e. on top, in UI). */
  setAsLastSibling(): void {
    this.setSiblingIndex(Number.MAX_SAFE_INTEGER);
  }

  /** Iterate direct children: `for (const child of transform) { ... }`. */
  *[Symbol.iterator](): IterableIterator<Transform> {
    // Copy first so children may be re-parented or destroyed while iterating.
    for (const child of [...this._node.children]) {
      yield gameObjectOf(child as pc.Entity).transform;
    }
  }

  /** Finds a descendant by name. `path` may contain `/` to walk several levels. */
  find(path: string): Transform | null {
    let node: pc.GraphNode | null = this._node;
    for (const part of path.split('/')) {
      if (!part) continue;
      node = node?.children.find((child) => child.name === part) ?? null;
      if (!node) return null;
    }
    return node && node !== this._node ? gameObjectOf(node as pc.Entity).transform : null;
  }

  /** True if this transform is `parent` or one of its descendants. */
  isChildOf(parent: Transform): boolean {
    for (let current: Transform | null = this; current; current = current.parent) {
      if (current === parent) return true;
    }
    return false;
  }

  getSiblingIndex(): number {
    return this._node.parent ? this._node.parent.children.indexOf(this._node) : 0;
  }

  /** Moves this transform among its siblings. Under a Canvas, later siblings draw on top. */
  setSiblingIndex(index: number): void {
    const parentNode = this._node.parent;
    if (!parentNode) return;
    const clamped = Math.max(0, Math.min(index, parentNode.children.length - 1));
    // Same parent, so local values are unchanged.
    this._node.reparent(parentNode, clamped);
  }

  detachChildren(): void {
    for (const child of this) child.setParent(null);
  }

  // ---- Movement ---------------------------------------------------------------------

  /**
   * Moves by `translation`, measured in world units. As in Unity, the direction is
   * relative to this object's own axes by default (`Space.Self`), so
   * `translate(Vector3.forward)` moves one unit the way it is facing, whatever the scale.
   * Pass `Space.World` for world axes, or a Transform to use that object's axes.
   */
  translate(translation: Vector3, relativeTo?: Space | Transform): void;
  /** Unity's `Translate(x, y, z, relativeTo)`. */
  translate(x: number, y: number, z: number, relativeTo?: Space | Transform): void;
  translate(
    first: Vector3 | number,
    second?: number | Space | Transform,
    third?: number,
    fourth?: Space | Transform,
  ): void {
    const translation =
      typeof first === 'number' ? new Vector3(first, typeof second === 'number' ? second : 0, third ?? 0) : first;
    const relativeTo = (typeof first === 'number' ? fourth : (second as Space | Transform | undefined)) ?? Space.Self;
    const offset =
      relativeTo === Space.World
        ? translation
        : relativeTo === Space.Self
          ? this.rotation.rotate(translation)
          : relativeTo.transformDirection(translation);
    this.position = this.position.add(offset);
  }

  /**
   * Rotates by Euler angles in degrees (Z, then X, then Y, as in Unity), about this
   * object's own axes by default (`Space.Self`) or the world's (`Space.World`).
   */
  rotate(eulers: Vector3, relativeTo?: Space): void;
  /** Unity's `Rotate(xAngle, yAngle, zAngle, relativeTo)`. */
  rotate(xAngle: number, yAngle: number, zAngle: number, relativeTo?: Space): void;
  /** Rotates `angle` degrees around `axis`, in local space by default. Same as Unity's `Rotate(axis, angle, relativeTo)`. */
  rotate(axis: Vector3, angle: number, relativeTo?: Space): void;
  rotate(first: Vector3 | number, second?: number | Space, third?: number | Space, fourth?: Space): void {
    let delta: Quaternion;
    let relativeTo: Space | undefined;
    if (typeof first === 'number') {
      // (x, y, z, space?)
      delta = Quaternion.euler(first, typeof second === 'number' ? second : 0, typeof third === 'number' ? third : 0);
      relativeTo = fourth;
    } else if (typeof second === 'number') {
      // (axis, angle, space?)
      delta = Quaternion.angleAxis(second, first);
      relativeTo = typeof third === 'number' ? undefined : third;
    } else {
      // (eulers, space?)
      delta = Quaternion.euler(first);
      relativeTo = second;
    }
    if ((relativeTo ?? Space.Self) === Space.World) this.rotation = delta.mul(this.rotation);
    else this.localRotation = this.localRotation.mul(delta);
  }

  /** Orbits around `point` by `angle` degrees about `axis` (world space). */
  rotateAround(point: Vector3, axis: Vector3, angle: number): void {
    const delta = Quaternion.angleAxis(angle, axis);
    this.position = point.add(delta.rotate(this.position.sub(point)));
    this.rotation = delta.mul(this.rotation);
  }

  /** Turns so that `forward` (+Z) points at `target`, with `up` as close to `worldUp` as possible. Same as Unity. */
  lookAt(target: Transform | Vector3, worldUp: Vector3 = Vector3.up): void {
    const point = target instanceof Transform ? target.position : target;
    const direction = point.sub(this.position);
    if (direction.sqrMagnitude < 1e-12) return;
    this.rotation = Quaternion.lookRotation(direction, worldUp);
  }

  // ---- Space conversion -------------------------------------------------------------

  /** Local point -> world point (applies position, rotation and scale). */
  transformPoint(point: Vector3): Vector3 {
    const world = this._node.getWorldTransform();
    return fromPlayCanvasVec3(world.transformPoint(toPlayCanvasVec3(point, scratchVec), scratchVec));
  }

  /** World point -> local point. */
  inverseTransformPoint(point: Vector3): Vector3 {
    scratchMat.copy(this._node.getWorldTransform()).invert();
    return fromPlayCanvasVec3(scratchMat.transformPoint(toPlayCanvasVec3(point, scratchVec), scratchVec));
  }

  /** Local direction -> world direction (rotation only; the length is kept). */
  transformDirection(direction: Vector3): Vector3 {
    return this.rotation.rotate(direction);
  }

  /** World direction -> local direction (rotation only). */
  inverseTransformDirection(direction: Vector3): Vector3 {
    return this.rotation.inverse().rotate(direction);
  }

  /** Local vector -> world vector (rotation and scale, no translation). */
  transformVector(vector: Vector3): Vector3 {
    const world = this._node.getWorldTransform();
    return fromPlayCanvasVec3(world.transformVector(toPlayCanvasVec3(vector, scratchVec), scratchVec));
  }

  /** World vector -> local vector. */
  inverseTransformVector(vector: Vector3): Vector3 {
    scratchMat.copy(this._node.getWorldTransform()).invert();
    return fromPlayCanvasVec3(scratchMat.transformVector(toPlayCanvasVec3(vector, scratchVec), scratchVec));
  }

  override _copyFrom(source: this): void {
    this.localPosition = source.localPosition;
    this.localRotation = source.localRotation;
    this.localScale = source.localScale;
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Transform, 'Transform');
