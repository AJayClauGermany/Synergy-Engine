import * as pc from 'playcanvas';
import { nameType } from './typeNames';
import {
  type Component,
  type ComponentClass,
  type ConcreteComponentClass,
  constructComponent,
} from './Component';
import { EngineObject } from './EngineObject';
import { adopters, factories, type PrimitiveType } from './hooks';
import { currentEngine } from './runtime';
import type { Scene } from './SceneManager';
import { Transform } from './Transform';

const GAME_OBJECT = Symbol('synergy.gameObject');
const SCENE = Symbol('synergy.scene');

interface Tagged {
  [GAME_OBJECT]?: GameObject;
  [SCENE]?: Scene;
  _enabled?: boolean;
}

function tagged(node: pc.GraphNode): Tagged {
  return node as unknown as Tagged;
}

/** @internal */
export function markSceneRoot(node: pc.GraphNode, scene: Scene): void {
  tagged(node)[SCENE] = scene;
}

/** @internal */
export function isSceneRoot(node: pc.GraphNode): boolean {
  return tagged(node)[SCENE] !== undefined;
}

/** @internal The entity's own enabled flag, ignoring its parents. */
export function localEnabled(node: pc.GraphNode): boolean {
  return tagged(node)._enabled !== false;
}

/** @internal The GameObject already wrapping `entity`, if any. */
export function existingGameObjectOf(node: pc.GraphNode): GameObject | undefined {
  return tagged(node)[GAME_OBJECT];
}

let adoptTarget: pc.Entity | null = null;

/**
 * The GameObject for a PlayCanvas entity, creating the wrapper on first use. This is how
 * entities that came from outside the engine (glTF models, raw PlayCanvas code) join the
 * GameObject world.
 */
export function gameObjectOf(entity: pc.Entity): GameObject {
  const existing = existingGameObjectOf(entity);
  if (existing) return existing;
  adoptTarget = entity;
  try {
    return new GameObject(entity.name);
  } finally {
    adoptTarget = null;
  }
}

/**
 * The thing everything in a scene is made of: a named node with a Transform and a list
 * of components.
 *
 *   const unit = new GameObject('Footman');
 *   unit.addComponent(Health).max = 40;
 *   unit.transform.position = new Vector3(2, 0, -3);
 *
 * New objects are placed at the root of the active scene, as in Unity. `entity` is the
 * underlying PlayCanvas entity for anything this API does not cover yet.
 */
export class GameObject extends EngineObject {
  /** The PlayCanvas entity behind this object. An escape hatch; prefer the Unity-style API. */
  readonly entity: pc.Entity;
  readonly transform: Transform;
  tag = 'Untagged';
  /** Layer index 0-31, used by `Physics` layer masks. See `LayerMask`. */
  layer = 0;

  /** @internal */
  readonly _components: Component[] = [];

  constructor(name = 'GameObject', ...components: ConcreteComponentClass[]) {
    super();
    const adopted = adoptTarget;
    adoptTarget = null;
    if (adopted) {
      this.entity = adopted;
    } else {
      const engine = currentEngine();
      this.entity = new pc.Entity(name, engine.app);
      engine.scenes.targetScene._root.addChild(this.entity);
    }
    tagged(this.entity)[GAME_OBJECT] = this;
    this.transform = constructComponent(Transform, this);
    this._components.push(this.transform);
    if (adopted) {
      for (const adopt of adopters) adopt(this, adopted);
    }
    for (const type of components) this.addComponent(type);
  }

  get name(): string {
    return this.entity.name;
  }

  set name(value: string) {
    this.entity.name = value;
  }

  // ---- Activation -------------------------------------------------------------------

  /** This object's own active flag, ignoring its parents. */
  get activeSelf(): boolean {
    return localEnabled(this.entity);
  }

  /** True when this object and every ancestor is active. */
  get activeInHierarchy(): boolean {
    if (this._destroyed) return false;
    for (let node: pc.GraphNode | null = this.entity; node; node = node.parent) {
      if (isSceneRoot(node)) return true;
      if (!localEnabled(node)) return false;
    }
    return false;
  }

  /** Activates or deactivates this object and, in effect, all of its children. */
  setActive(value: boolean): void {
    if (this._destroyed || value === this.activeSelf) return;
    const wasActive = this.activeInHierarchy;
    this.entity.enabled = value;
    const isActive = this.activeInHierarchy;
    if (wasActive !== isActive) {
      currentEngine().lifecycle.hierarchyActiveChanged(this.entity, isActive);
    }
  }

  /** The scene this object lives in. */
  get scene(): Scene {
    for (let node: pc.GraphNode | null = this.entity; node; node = node.parent) {
      const scene = tagged(node)[SCENE];
      if (scene) return scene;
    }
    return currentEngine().scenes.activeScene;
  }

  compareTag(tag: string): boolean {
    return this.tag === tag;
  }

  // ---- Components -------------------------------------------------------------------

  /** Adds a component and returns it. Its `awake` runs immediately if this object is active. */
  addComponent<T extends Component>(type: ConcreteComponentClass<T>): T {
    if (this._destroyed) {
      throw new Error(`Cannot add ${type.name} to destroyed GameObject "${this.name}".`);
    }
    if ((type as unknown) === Transform) {
      throw new Error('Every GameObject already has exactly one Transform.');
    }
    const meta = type as ComponentMeta;
    if (meta.disallowMultiple && this.getComponent(type)) {
      throw new Error(`"${this.name}" already has a ${type.name}; only one is allowed.`);
    }
    for (const required of meta.requireComponents ?? []) {
      if (!this.getComponent(required)) this.addComponent(required);
    }
    const component = constructComponent(type, this);
    this._components.push(component);
    component._attach();
    currentEngine().lifecycle.componentAdded(component);
    return component;
  }

  /** The first component of (or derived from) `type`, or `null`. */
  getComponent<T extends Component>(type: ComponentClass<T>): T | null {
    for (const component of this._components) {
      if (component instanceof type) return component;
    }
    return null;
  }

  getComponents<T extends Component>(type: ComponentClass<T>): T[] {
    return this._components.filter((component): component is T => component instanceof type);
  }

  /** Searches this object, then its descendants (depth first). Skips inactive objects by default. */
  getComponentInChildren<T extends Component>(
    type: ComponentClass<T>,
    includeInactive = false,
  ): T | null {
    return this.getComponentsInChildren(type, includeInactive, 1)[0] ?? null;
  }

  getComponentsInChildren<T extends Component>(
    type: ComponentClass<T>,
    includeInactive = false,
    limit = Number.POSITIVE_INFINITY,
  ): T[] {
    const found: T[] = [];
    const visit = (node: pc.GraphNode, active: boolean): void => {
      if (found.length >= limit) return;
      const nodeActive = active && localEnabled(node);
      if (!nodeActive && !includeInactive) return;
      if (node instanceof pc.Entity) {
        for (const component of gameObjectOf(node)._components) {
          if (component instanceof type && found.length < limit) found.push(component);
        }
      }
      for (const child of [...node.children]) visit(child, nodeActive);
    };
    visit(this.entity, this.entity.parent ? parentActive(this) : true);
    return found;
  }

  /** Searches this object, then its ancestors. */
  getComponentInParent<T extends Component>(type: ComponentClass<T>): T | null {
    for (let t: Transform | null = this.transform; t; t = t.parent) {
      const component = t.gameObject.getComponent(type);
      if (component) return component;
    }
    return null;
  }

  getComponentsInParent<T extends Component>(type: ComponentClass<T>): T[] {
    const found: T[] = [];
    for (let t: Transform | null = this.transform; t; t = t.parent) {
      found.push(...t.gameObject.getComponents(type));
    }
    return found;
  }

  // ---- Lookup -----------------------------------------------------------------------

  /**
   * Finds an active GameObject by name in the loaded scenes. A name containing `/` is
   * treated as a path, e.g. `GameObject.find('Army/Footman')`. This walks the scene, so
   * cache the result instead of calling it every frame.
   */
  static find(name: string): GameObject | null {
    const [first, ...rest] = name.split('/').filter(Boolean);
    if (!first) return null;
    let result: GameObject | null = null;
    walkScenes((node) => {
      if (node.name !== first || !(node instanceof pc.Entity)) return true;
      const candidate = gameObjectOf(node);
      if (!candidate.activeInHierarchy) return true;
      const target = rest.length ? candidate.transform.find(rest.join('/'))?.gameObject : candidate;
      if (!target || !target.activeInHierarchy) return true;
      result = target;
      return false;
    });
    return result;
  }

  /** The first active GameObject with `tag`, or `null`. */
  static findWithTag(tag: string): GameObject | null {
    return GameObject.findGameObjectsWithTag(tag, 1)[0] ?? null;
  }

  static findGameObjectsWithTag(tag: string, limit = Number.POSITIVE_INFINITY): GameObject[] {
    const found: GameObject[] = [];
    walkScenes((node) => {
      const gameObject = existingGameObjectOf(node);
      if (gameObject && gameObject.tag === tag && gameObject.activeInHierarchy) {
        found.push(gameObject);
      }
      return found.length < limit;
    });
    return found;
  }

  /** Creates a GameObject with a mesh, a renderer and a matching collider. */
  static createPrimitive(type: PrimitiveType): GameObject {
    if (!factories.createPrimitive) {
      throw new Error('Primitive support is not loaded. Import from "@synergy/engine".');
    }
    return factories.createPrimitive(type);
  }
}

/** Optional static metadata a component class can declare. Unity uses attributes for these. */
interface ComponentMeta {
  /** Unity: `[DisallowMultipleComponent]`. */
  disallowMultiple?: boolean;
  /** Unity: `[RequireComponent(typeof(X))]`. Missing ones are added automatically. */
  requireComponents?: ConcreteComponentClass[];
}

function parentActive(gameObject: GameObject): boolean {
  for (let node = gameObject.entity.parent; node; node = node.parent) {
    if (isSceneRoot(node)) return true;
    if (!localEnabled(node)) return false;
  }
  return true;
}

/** @internal Depth-first walk over every loaded scene. Return `false` from `visit` to stop. */
export function walkScenes(visit: (node: pc.GraphNode) => boolean): void {
  const walk = (node: pc.GraphNode): boolean => {
    for (const child of [...node.children]) {
      if (!visit(child) || !walk(child)) return false;
    }
    return true;
  };
  for (const scene of currentEngine().scenes.allScenes()) {
    if (!walk(scene._root)) return;
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(GameObject, 'GameObject');
