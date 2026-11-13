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

/** Keeps a root GameObject alive when another scene is loaded. */
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
 * prefab's name.
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

/**
 * The first component of `type` on an active GameObject, or `null`. This walks every
 * loaded scene, so call it in `start`/`awake` and keep the result.
 * Unity: `Object.FindFirstObjectByType` (formerly `FindObjectOfType`).
 */
export function findObjectOfType<T extends Component>(type: ComponentClass<T>): T | null {
  return findObjectsOfType(type, 1)[0] ?? null;
}

/** Every component of `type` on active GameObjects. Unity: `Object.FindObjectsByType`. */
export function findObjectsOfType<T extends Component>(type: ComponentClass<T>, limit = Number.POSITIVE_INFINITY): T[] {
  const found: T[] = [];
  walkScenes((node) => {
    const gameObject = existingGameObjectOf(node);
    if (gameObject?.activeInHierarchy) {
      for (const component of gameObject._components) {
        if (component instanceof type && found.length < limit) found.push(component);
      }
    }
    return found.length < limit;
  });
  return found;
}
