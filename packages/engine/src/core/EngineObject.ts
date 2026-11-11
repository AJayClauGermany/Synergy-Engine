import { typeNameOf } from './typeNames';

let nextInstanceId = 1;

/**
 * Base class of everything the engine tracks. Unity calls this `UnityEngine.Object`;
 * it is renamed here because `Object` is already a JavaScript global.
 */
export abstract class EngineObject {
  /** @internal */
  _instanceId = nextInstanceId++;
  /** @internal */
  _destroyed = false;

  abstract name: string;

  /** A number unique to this object for the lifetime of the page. */
  getInstanceId(): number {
    return this._instanceId;
  }

  /** True once the object has been destroyed. Prefer `isAlive(obj)` for null-safe checks. */
  get isDestroyed(): boolean {
    return this._destroyed;
  }

  toString(): string {
    return `${this.name} (${typeNameOf(this)})`;
  }
}

/**
 * Unity lets you write `if (target != null)` to ask "does this object still exist?",
 * because destroyed objects compare equal to null. JavaScript cannot overload `==`, so
 * use this instead:
 *
 *   if (isAlive(this.target)) this.transform.lookAt(this.target.transform);
 */
export function isAlive<T extends EngineObject>(value: T | null | undefined): value is T {
  return value != null && !value._destroyed;
}
