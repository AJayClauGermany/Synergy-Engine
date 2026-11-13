import * as pc from 'playcanvas';
import type { Quaternion } from '../math/Quaternion';
import { Vector3 } from '../math/Vector3';
import { Component, type ComponentClass, type ConcreteComponentClass } from './Component';
import { existingGameObjectOf, GameObject, gameObjectOf, walkScenes } from './GameObject';
import { currentEngine } from './runtime';
import { Transform } from './Transform';

/**
 * A reusable recipe for a GameObject. In Unity a prefab is an asset made in the editor;
 * here it is a named function that fills in a fresh GameObject:
 *
 *   export const FootmanPrefab = new Prefab('Footman', (go) => {
 *     go.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Capsule);
 *     go.addComponent(MeshRenderer);
 *     go.addComponent(Health).max = 40;
 *   });
 *
 *   const unit = instantiate(FootmanPrefab, new Vector3(2, 0, 0));
 *
 * Scripts in the instance wake up after `build` has finished, so values set inside it
 * are visible in `awake`, like serialized fields in Unity.
 */
export class Prefab {
  constructor(
    readonly name: string,
    readonly build: (gameObject: GameObject) => void,
  ) {}
}

/**
 * Destroys a GameObject (with its children) or a single component. It happens at the end
 * of the current frame, or `delay` seconds later. Unity: `Object.Destroy`.
 */
export function destroy(target: GameObject | Component, delay = 0): void {
  currentEngine().lifecycle.destroy(target, delay);
}

/** Destroys right now instead of at the end of the frame. Prefer `destroy` in game code. */
export function destroyImmediate(target: GameObject | Component): void {
  currentEngine().lifecycle.destroyNow(target);
}

/**
 * Keeps a root GameObject alive when another scene is loaded. Unity only logs a warning
 * for an object that has a parent and leaves it be; here that throws, with the name.
 */
export function dontDestroyOnLoad(target: GameObject | Component): void {
  const gameObject = target instanceof GameObject ? target : target.gameObject;
  if (gameObject.transform.parent) {
    throw new Error(`dontDestroyOnLoad only works on root GameObjects; "${gameObject.name}" has a parent.`);
  }
  gameObject.entity.reparent(currentEngine().scenes.persistent._root);
}

/**
 * Creates a copy of a GameObject (and its children), or builds a `Prefab`.
 * Unity: `Object.Instantiate`.
 *
 *   instantiate(original)
 *   instantiate(original, parent)
 *   instantiate(original, position, rotation?, parent?)
 *
 * Passing a component clones its whole GameObject and returns the matching component.
 * Clones of a GameObject are named "Name(Clone)" as in Unity; prefab instances keep the
 * prefab's name (Unity names those "Name(Clone)" too).
 *
 * Same as Unity: with only a `parent`, the original's position and rotation are taken as
 * local to the parent (Unity's `instantiateInWorldSpace = false`); with a `position`
 * (and `rotation`), they are world values.
 */
export function instantiate(original: Prefab, parent?: Transform | null): GameObject;
export function instantiate(
  original: Prefab,
  position: Vector3,
  rotation?: Quaternion,
  parent?: Transform | null,
): GameObject;
export function instantiate<T extends GameObject | Component>(original: T, parent?: Transform | null): T;
export function instantiate<T extends GameObject | Component>(
  original: T,
  position: Vector3,
  rotation?: Quaternion,
  parent?: Transform | null,
): T;
export function instantiate(
  original: Prefab | GameObject | Component,
  positionOrParent?: Vector3 | Transform | null,
  rotation?: Quaternion,
  parentArgument?: Transform | null,
): GameObject | Component {
  const engine = currentEngine();
  const position = positionOrParent instanceof Vector3 ? positionOrParent : null;
  const parent = positionOrParent instanceof Transform ? positionOrParent : (parentArgument ?? null);
  const parentNode = parent ? parent._node : engine.scenes.targetScene._root;

  return engine.lifecycle.runDeferred(() => {
    let root: GameObject;
    let result: GameObject | Component;
    if (original instanceof Prefab) {
      root = new GameObject(original.name);
      if (parent) root.transform.setParent(parent, false);
      place(root, position, rotation);
      const made: unknown = original.build(root);
      checkPrefabBuild(original, root, made);
      result = root;
    } else {
      const source = original instanceof GameObject ? original : original.gameObject;
      if (source.isDestroyed) throw new Error('Cannot instantiate a destroyed object.');
      const map = cloneHierarchy(source, parentNode);
      root = map.get(source) as GameObject;
      root.name = `${source.name}(Clone)`;
      place(root, position, rotation);
      result = map.get(original) as GameObject | Component;
    }
    return result;
  });
}

const emptyPrefabs = new WeakSet<Prefab>();

/** Exactly as `new GameObject(name)` left it: no component, no child, no tag, no layer. */
function isUntouched(root: GameObject): boolean {
  return root._components.length <= 1 && root.transform.childCount === 0 && root.tag === 'Untagged' && root.layer === 0;
}

/**
 * A prefab's build function is handed the instance and adds to it. Written as a factory
 * (`() => { const enemy = new GameObject(); ...; return enemy; }`) it compiles, and every
 * instance comes out empty while a stray object sits in the scene.
 */
function checkPrefabBuild(prefab: Prefab, root: GameObject, made: unknown): void {
  const fix = `Add to the GameObject build() is given: new Prefab('${prefab.name}', (go) => { go.addComponent(...); }).`;
  // (An arrow that returns what it just added, `(go) => instantiate(Child, go.transform)`, is fine.)
  if (made instanceof GameObject && made !== root && !made.transform.isChildOf(root.transform)) {
    currentEngine().reportError(
      new Error(
        `Prefab "${prefab.name}": build() made and returned a GameObject of its own ("${made.name}"). ` +
          `That is not the instance, so the instance has none of it. ${fix}`,
      ),
      `instantiating the prefab "${prefab.name}"`,
    );
  } else if (isUntouched(root) && !emptyPrefabs.has(prefab)) {
    emptyPrefabs.add(prefab);
    console.warn(`Prefab "${prefab.name}": build() added nothing to the GameObject it was given. ${fix}`);
  }
}

function place(root: GameObject, position: Vector3 | null, rotation: Quaternion | undefined): void {
  if (position) root.transform.position = position;
  if (rotation) root.transform.rotation = rotation;
}

/** Clones `source` under `parentNode` and returns the mapping from originals to clones. */
function cloneHierarchy(source: GameObject, parentNode: pc.GraphNode): Map<object, object> {
  // PlayCanvas clones the entity tree and its own components (meshes, cameras, lights).
  const clonedEntity = source.entity.clone();
  parentNode.addChild(clonedEntity);

  const map = new Map<object, object>();
  const pairs: [Component, Component][] = [];

  const wrap = (from: pc.Entity, to: pc.Entity): void => {
    const fromObject = existingGameObjectOf(from);
    if (fromObject) {
      const toObject = gameObjectOf(to);
      toObject.tag = fromObject.tag;
      toObject.layer = fromObject.layer;
      map.set(fromObject, toObject);
      // Wrapping `to` may already have added built-in components for what PlayCanvas cloned.
      const unused = new Set(toObject._components);
      for (const component of fromObject._components) {
        let copy: Component | undefined;
        for (const candidate of unused) {
          if (candidate.constructor === component.constructor) {
            copy = candidate;
            break;
          }
        }
        copy ??= toObject.addComponent(component.constructor as ConcreteComponentClass);
        unused.delete(copy);
        map.set(component, copy);
        pairs.push([component, copy]);
      }
      // Built-ins that wrapping added but the original did not have (e.g. a mesh with no renderer).
      for (const extra of unused) currentEngine().lifecycle.destroyNow(extra);
    }
    const fromChildren = from.children.filter((child): child is pc.Entity => child instanceof pc.Entity);
    const toChildren = to.children.filter((child): child is pc.Entity => child instanceof pc.Entity);
    fromChildren.forEach((child, index) => {
      const match = toChildren[index];
      if (match) wrap(child, match);
    });
  };
  wrap(source.entity, clonedEntity);

  const remap = <V>(value: V): V => (map.get(value as object) as V | undefined) ?? value;
  for (const [from, to] of pairs) {
    if (!(from instanceof Transform)) to._copyFrom(from, remap);
  }
  return map;
}

/** Unity's `FindObjectsInactive`: whether the `find...ByType` functions look at inactive GameObjects. */
export enum FindObjectsInactive {
  /** Only components on GameObjects active in the hierarchy (the default). */
  Exclude = 0,
  /** Components on inactive GameObjects too. */
  Include = 1,
}

/**
 * Unity's `FindObjectsSortMode`. Unity 6 deprecates it, and so does this engine.
 * @deprecated Leave it out: `findObjectsByType(T)`. Results always come in scene order here.
 */
export enum FindObjectsSortMode {
  // Text, not Unity's 0 and 1, so that (type, sortMode) and (type, findObjectsInactive) can be told apart.
  None = 'None',
  InstanceID = 'InstanceID',
}

/**
 * Every component of `type` (or derived from it) in the loaded scenes, in scene order
 * (depth first, parents before children). Unity: `Object.FindObjectsByType<T>()`.
 *
 * Same as Unity: components on inactive GameObjects are left out unless you pass
 * `FindObjectsInactive.Include`. Disabled components on active GameObjects are returned.
 * Unlike Unity, it finds components only (no assets such as materials).
 *
 * This walks every loaded scene, so call it in `start`/`awake` and keep the result.
 */
export function findObjectsByType<T extends Component>(
  type: ComponentClass<T>,
  findObjectsInactive?: FindObjectsInactive,
): T[];
/**
 * @deprecated Unity 6 deprecates the sort mode. Leave it out: results come in scene
 * order here, whatever you pass, which is also what `FindObjectsSortMode.None` asks for.
 */
export function findObjectsByType<T extends Component>(type: ComponentClass<T>, sortMode: FindObjectsSortMode): T[];
/** @deprecated Unity 6 deprecates the sort mode. Leave it out: results come in scene order here. */
export function findObjectsByType<T extends Component>(
  type: ComponentClass<T>,
  findObjectsInactive: FindObjectsInactive,
  sortMode: FindObjectsSortMode,
): T[];
export function findObjectsByType<T extends Component>(
  type: ComponentClass<T>,
  inactiveOrSort: FindObjectsInactive | FindObjectsSortMode = FindObjectsInactive.Exclude,
  _sortMode?: FindObjectsSortMode, // accepted for Unity's signatures; scene order either way
): T[] {
  return findComponents(type, inactiveOrSort === FindObjectsInactive.Include, Number.POSITIVE_INFINITY);
}

/**
 * The first component of `type` on an active GameObject, in scene order, or `null`.
 * Unity: `Object.FindFirstObjectByType<T>()`. Unity's newest docs (6.6) deprecate it for
 * `findAnyObjectByType`, because Unity's "first" depended on instance ids; here "first"
 * is simply scene order, and both functions return the same object.
 */
export function findFirstObjectByType<T extends Component>(
  type: ComponentClass<T>,
  findObjectsInactive = FindObjectsInactive.Exclude,
): T | null {
  return findComponents(type, findObjectsInactive === FindObjectsInactive.Include, 1)[0] ?? null;
}

/**
 * A component of `type` on an active GameObject, or `null`. Unity:
 * `Object.FindAnyObjectByType<T>()`, which promises no particular one; here it is the
 * first in scene order, the same as `findFirstObjectByType`. Walks every loaded scene:
 * call it in `start`/`awake` and keep the result.
 */
export function findAnyObjectByType<T extends Component>(
  type: ComponentClass<T>,
  findObjectsInactive = FindObjectsInactive.Exclude,
): T | null {
  return findComponents(type, findObjectsInactive === FindObjectsInactive.Include, 1)[0] ?? null;
}

/**
 * @deprecated Unity 6 renamed this: write `findAnyObjectByType(T)` (or `findFirstObjectByType(T)`).
 * Behaves the same: the first component of `type` on an active GameObject, or `null`.
 */
export function findObjectOfType<T extends Component>(type: ComponentClass<T>): T | null {
  return findComponents(type, false, 1)[0] ?? null;
}

/**
 * @deprecated Unity 6 renamed this: write `findObjectsByType(T)`, with
 * `FindObjectsInactive.Include` to look at inactive GameObjects too.
 */
export function findObjectsOfType<T extends Component>(type: ComponentClass<T>): T[] {
  return findComponents(type, false, Number.POSITIVE_INFINITY);
}

function findComponents<T extends Component>(type: ComponentClass<T>, includeInactive: boolean, limit: number): T[] {
  const found: T[] = [];
  walkScenes((node) => {
    const gameObject = existingGameObjectOf(node);
    if (gameObject && !gameObject.isDestroyed && (includeInactive || gameObject.activeInHierarchy)) {
      for (const component of gameObject._components) {
        if (component instanceof type && found.length < limit) found.push(component);
      }
    }
    return found.length < limit;
  });
  return found;
}
