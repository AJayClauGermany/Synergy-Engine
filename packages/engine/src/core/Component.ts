import { EngineObject } from './EngineObject';
import type { GameObject } from './GameObject';
import type { Transform } from './Transform';
import { currentEngine } from './runtime';

/** A component class, as passed to `addComponent(Health)` / `getComponent(Health)`. */
export type ComponentClass<T extends Component = Component> = abstract new () => T;
/** A component class that can be instantiated by `addComponent`. */
export type ConcreteComponentClass<T extends Component = Component> = new () => T;

let pendingOwner: GameObject | null = null;

/** @internal Constructs a component bound to `owner`. Only `GameObject.addComponent` calls this. */
export function constructComponent<T extends Component>(
  type: ConcreteComponentClass<T>,
  owner: GameObject,
): T {
  pendingOwner = owner;
  try {
    return new type();
  } finally {
    pendingOwner = null;
  }
}

/**
 * Base class for everything attached to a GameObject.
 *
 * Components are never constructed with `new`. Use `gameObject.addComponent(Type)`,
 * exactly as in Unity. Field initialisers may use `this.gameObject` and `this.transform`.
 */
export abstract class Component extends EngineObject {
  readonly gameObject: GameObject;

  /** @internal True once `awake` has run. */
  _awoken = false;
  /** @internal True while the component is active-and-enabled (between onEnable and onDisable). */
  _live = false;
  /** @internal Created while lifecycle callbacks were suspended; awake is still owed. */
  _deferred = false;

  constructor() {
    super();
    if (!pendingOwner) {
      throw new Error(
        `${new.target.name} cannot be created with \`new\`. Use gameObject.addComponent(${new.target.name}).`,
      );
    }
    this.gameObject = pendingOwner;
    pendingOwner = null;
  }

  get transform(): Transform {
    return this.gameObject.transform;
  }

  /** A component's name is its GameObject's name, as in Unity. */
  get name(): string {
    return this.gameObject.name;
  }

  set name(value: string) {
    this.gameObject.name = value;
  }

  get tag(): string {
    return this.gameObject.tag;
  }

  set tag(value: string) {
    this.gameObject.tag = value;
  }

  compareTag(tag: string): boolean {
    return this.gameObject.tag === tag;
  }

  getComponent<T extends Component>(type: ComponentClass<T>): T | null {
    return this.gameObject.getComponent(type);
  }

  getComponents<T extends Component>(type: ComponentClass<T>): T[] {
    return this.gameObject.getComponents(type);
  }

  getComponentInChildren<T extends Component>(
    type: ComponentClass<T>,
    includeInactive = false,
  ): T | null {
    return this.gameObject.getComponentInChildren(type, includeInactive);
  }

  getComponentsInChildren<T extends Component>(
    type: ComponentClass<T>,
    includeInactive = false,
  ): T[] {
    return this.gameObject.getComponentsInChildren(type, includeInactive);
  }

  getComponentInParent<T extends Component>(type: ComponentClass<T>): T | null {
    return this.gameObject.getComponentInParent(type);
  }

  // ---- Internal lifecycle hooks -------------------------------------------------------
  // Built-in components override these. Game code overrides the public MonoBehaviour
  // messages (awake, onEnable, ...) instead.

  /** @internal Called once, right after construction, even on inactive objects. */
  _attach(): void {}
  /** @internal Called once, the first time the GameObject is active. */
  _awake(): void {}
  /** @internal Called each time the component becomes active-and-enabled. */
  _enable(): void {}
  /** @internal Called each time the component stops being active-and-enabled. */
  _disable(): void {}
  /** @internal Called when the GameObject (not just this component) is deactivated. */
  _gameObjectDeactivated(): void {}
  /** @internal Called once when destroyed, after `_disable`. */
  _destroy(): void {}
  /** @internal Whether the component itself is switched on. */
  _wantsLive(): boolean {
    return true;
  }
  /** @internal Copies state from the component this one was cloned from. */
  _copyFrom(_source: this, _remap: <V>(value: V) => V): void {}
  /**
   * @internal A few words for `Debug.hierarchy()` about state that is not held in public
   * fields (a camera's field of view, how many tiles a tilemap has).
   */
  _summary?(): string;
}

/** A component that can be switched on and off with `enabled`. */
export abstract class Behaviour extends Component {
  /** @internal */
  _enabled = true;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (this._enabled === value) return;
    this._enabled = value;
    this._enabledChanged();
    currentEngine().lifecycle.refresh(this);
  }

  /** True when enabled and the GameObject is active in the hierarchy. */
  get isActiveAndEnabled(): boolean {
    return this._enabled && this.gameObject.activeInHierarchy;
  }

  /** @internal Built-ins mirror `enabled` onto their PlayCanvas component here. */
  _enabledChanged(): void {}

  override _wantsLive(): boolean {
    return this._enabled;
  }

  override _copyFrom(source: this, _remap: <V>(value: V) => V): void {
    this._enabled = source._enabled;
    this._enabledChanged();
  }
}
