const names = new WeakMap<object, string>();

/**
 * Records the name a class was written with, for `Debug.hierarchy()`, `toString()` and
 * error messages. A bundler may rename a class behind your back: a release build shortens
 * `UnitView` to something like `a`, and two classes with the same name in one bundle
 * (this engine's `Camera` and PlayCanvas's) come out as `Camera` and `Camera2`. The
 * engine's own components are all registered, so they always print as you import them.
 *
 *   export class UnitView extends MonoBehaviour { ... }
 *   nameType(UnitView, 'UnitView');   // optional: keeps the name readable in a release build
 */
export function nameType<T extends object>(type: T, name: string): T {
  names.set(type, name);
  return type;
}

/** The name of a class (or of an object's class) as it was written. */
export function typeNameOf(value: object): string {
  const type = typeof value === 'function' ? value : (value.constructor as object);
  return names.get(type) ?? (type as { name?: string }).name ?? 'Object';
}
