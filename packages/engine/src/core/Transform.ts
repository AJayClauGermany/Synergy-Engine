import * as pc from 'playcanvas';
import { Quaternion } from '../math/Quaternion';
import { Vector3 } from '../math/Vector3';
import { Component } from './Component';
import { gameObjectOf, isSceneRoot } from './GameObject';
import { currentEngine } from './runtime';

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
 * Vectors and quaternions are immutable values: assign a new one to move.
 *
 *   transform.position = transform.position.add(Vector3.forward.mul(speed * Time.deltaTime));
 */
export class Transform extends Component implements Iterable<Transform> {
  /** @internal */
  get _node(): pc.Entity {
    return this.gameObject.entity;
  }

  // ---- World space ------------------------------------------------------------------

  get position(): Vector3 {
    return Vector3.from(this._node.getPosition());
  }

  set position(value: Vector3) {
    this._node.setPosition(value.x, value.y, value.z);
  }

  get rotation(): Quaternion {
    return Quaternion.from(this._node.getRotation());
  }

  set rotation(value: Quaternion) {
    this._node.setRotation(value.x, value.y, value.z, value.w);
  }

  /** World rotation as Euler angles in degrees. */
  get eulerAngles(): Vector3 {
    return Vector3.from(this._node.getEulerAngles());
  }

  set eulerAngles(value: Vector3) {
    this._node.setEulerAngles(value.x, value.y, value.z);
  }

  /** World scale. Read-only, and approximate under rotated non-uniform parents (as in Unity). */
  get lossyScale(): Vector3 {
    return Vector3.from(this._node.getScale());
  }

  /** The direction this object faces (its local -Z axis) in world space. */
  get forward(): Vector3 {
    return Vector3.from(this._node.forward);
  }

  set forward(value: Vector3) {
    this.rotation = Quaternion.lookRotation(value);
  }

  get right(): Vector3 {
    return Vector3.from(this._node.right);
  }

  set right(value: Vector3) {
    this.rotation = Quaternion.fromToRotation(Vector3.right, value);
  }

  get up(): Vector3 {
    return Vector3.from(this._node.up);
  }

  set up(value: Vector3) {
    this.rotation = Quaternion.fromToRotation(Vector3.up, value);
  }

  // ---- Local space ------------------------------------------------------------------

  get localPosition(): Vector3 {
    return Vector3.from(this._node.getLocalPosition());
  }

  set localPosition(value: Vector3) {
    this._node.setLocalPosition(value.x, value.y, value.z);
  }

  get localRotation(): Quaternion {
    return Quaternion.from(this._node.getLocalRotation());
  }

  set localRotation(value: Quaternion) {
    this._node.setLocalRotation(value.x, value.y, value.z, value.w);
  }

  get localEulerAngles(): Vector3 {
    return Vector3.from(this._node.getLocalEulerAngles());
  }

  set localEulerAngles(value: Vector3) {
    this._node.setLocalEulerAngles(value.x, value.y, value.z);
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
      const position = node.getPosition().clone();
      const rotation = node.getRotation().clone();
      const scale = node.getScale().clone();
      node.reparent(newParent);
      node.setPosition(position);
      node.setRotation(rotation);
      const parentScale = newParent.getScale();
      node.setLocalScale(
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

  /** Moves by `translation`, in local space by default. */
  translate(translation: Vector3, relativeTo: Space = Space.Self): void {
    if (relativeTo === Space.World) {
      this._node.translate(translation.x, translation.y, translation.z);
    } else {
      this._node.translateLocal(translation.x, translation.y, translation.z);
    }
  }

  /** Rotates by Euler angles in degrees, in local space by default. */
  rotate(eulers: Vector3, relativeTo?: Space): void;
  /** Rotates `angle` degrees around `axis`, in local space by default. */
  rotate(axis: Vector3, angle: number, relativeTo?: Space): void;
  rotate(first: Vector3, second?: number | Space, third?: Space): void {
    // (eulers), (eulers, space) or (axis, angle, space?).
    if (typeof second !== 'number') {
      const relativeTo = second ?? Space.Self;
      if (relativeTo === Space.World) this._node.rotate(first.x, first.y, first.z);
      else this._node.rotateLocal(first.x, first.y, first.z);
      return;
    }
    const delta = Quaternion.angleAxis(second, first);
    const relativeTo = third ?? Space.Self;
    if (relativeTo === Space.World) this.rotation = delta.mul(this.rotation);
    else this.localRotation = this.localRotation.mul(delta);
  }

  /** Orbits around `point` by `angle` degrees about `axis` (world space). */
  rotateAround(point: Vector3, axis: Vector3, angle: number): void {
    const delta = Quaternion.angleAxis(angle, axis);
    this.position = point.add(delta.rotate(this.position.sub(point)));
    this.rotation = delta.mul(this.rotation);
  }

  /** Turns so that forward points at `target`. */
  lookAt(target: Transform | Vector3, worldUp: Vector3 = Vector3.up): void {
    const point = target instanceof Transform ? target.position : target;
    const direction = point.sub(this.position);
    if (direction.sqrMagnitude < 1e-12) return;
    this.rotation = Quaternion.lookRotation(direction, worldUp);
  }

  // ---- Space conversion -------------------------------------------------------------

  /** Local point -> world point (applies position, rotation and scale). */
  transformPoint(point: Vector3): Vector3 {
    scratchVec.set(point.x, point.y, point.z);
    return Vector3.from(this._node.getWorldTransform().transformPoint(scratchVec, scratchVec));
  }

  /** World point -> local point. */
  inverseTransformPoint(point: Vector3): Vector3 {
    scratchMat.copy(this._node.getWorldTransform()).invert();
    scratchVec.set(point.x, point.y, point.z);
    return Vector3.from(scratchMat.transformPoint(scratchVec, scratchVec));
  }

  /** Local direction -> world direction (rotation only). */
  transformDirection(direction: Vector3): Vector3 {
    return this.rotation.rotate(direction);
  }

  /** World direction -> local direction (rotation only). */
  inverseTransformDirection(direction: Vector3): Vector3 {
    scratchQuat.copy(this._node.getRotation()).invert();
    return Quaternion.from(scratchQuat).rotate(direction);
  }

  /** Local vector -> world vector (rotation and scale, no translation). */
  transformVector(vector: Vector3): Vector3 {
    scratchVec.set(vector.x, vector.y, vector.z);
    return Vector3.from(this._node.getWorldTransform().transformVector(scratchVec, scratchVec));
  }

  /** World vector -> local vector. */
  inverseTransformVector(vector: Vector3): Vector3 {
    scratchMat.copy(this._node.getWorldTransform()).invert();
    scratchVec.set(vector.x, vector.y, vector.z);
    return Vector3.from(scratchMat.transformVector(scratchVec, scratchVec));
  }

  override _copyFrom(source: this): void {
    this.localPosition = source.localPosition;
    this.localRotation = source.localRotation;
    this.localScale = source.localScale;
  }
}
