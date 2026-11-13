import { EngineObject } from './EngineObject';

/**
 * A list of callbacks you can invoke. Unity's `UnityEvent` / C# `event Action<...>`.
 *
 *   readonly died = new UnityEvent<[killer: GameObject]>();
 *   health.died.addListener((killer) => ...);
 *   this.died.invoke(attacker);
 */
export class UnityEvent<Args extends unknown[] = []> {
  private listeners: ((...args: Args) => void)[] = [];

  /**
   * Adds a listener and returns a function that removes it again. Same as Unity: adding
   * the same function twice registers it twice, and it is called twice per `invoke`.
   * Unity's returns nothing; the remover is an addition, and it removes only this one
   * registration (`removeListener` removes them all).
   */
  addListener(listener: (...args: Args) => void): () => void {
    this.listeners.push(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = this.listeners.lastIndexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /**
   * Removes every registration of `listener`, as Unity does. It must be the very function
   * that was added: a new arrow such as `() => this.onDied()` is another function and
   * removes nothing. Keep the function in a field, or keep the remover `addListener` returned.
   */
  removeListener(listener: (...args: Args) => void): void {
    this.listeners = this.listeners.filter((existing) => existing !== listener);
  }

  /** Removes every listener. Same as Unity's `RemoveAllListeners` (which keeps Inspector ones; there are none here). */
  removeAllListeners(): void {
    this.listeners = [];
  }

  /** Calls the listeners in the order they were added. Listeners added or removed meanwhile count from the next `invoke`. */
  invoke(...args: Args): void {
    // Copy so listeners may add or remove listeners while being called.
    for (const listener of [...this.listeners]) listener(...args);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/**
 * A value as something to read, not to change in place: an array without `push`, an
 * object whose fields cannot be assigned, a Map without `set`. It goes one level deep.
 * Anything with methods (a GameObject, a session, a Material: a class instance) is handed
 * over as it is, since there is no telling its own fields from its workings.
 *
 * A generic helper returns this type too: `function read<T>(o: Observable<T>): ReadonlyValue<T>`.
 *
 * This is what `observable.value` gives. The Observable only knows it changed when it is
 * given a new value, so `hud.value.gold += 5` would change what the HUD should show and
 * tell nobody; with this type it does not compile.
 */
export type ReadonlyValue<T> = T extends EngineObject | ((...args: never[]) => unknown)
  ? T
  : T extends readonly unknown[]
    ? Readonly<T>
    : T extends ReadonlyMap<infer Key, infer Value>
      ? ReadonlyMap<Key, Value>
      : T extends ReadonlySet<infer Item>
        ? ReadonlySet<Item>
        : T extends object
          ? HasMethods<T> extends true
            ? T
            : Readonly<T>
          : T;

/** Whether any member of `T` is a function: the mark of a class instance rather than plain data. */
type HasMethods<T> = true extends {
  [Key in keyof T]-?: T[Key] extends (...args: never[]) => unknown ? true : never;
}[keyof T]
  ? true
  : false;

/**
 * A value that tells subscribers when it changes. This is the bridge between game code
 * and the Preact HUD (`useObservable` in `@synergy/ui`), and has no Unity equivalent.
 *
 *   export const gold = new Observable(100);
 *   gold.value += 25;                       // game code
 *   const amount = useObservable(gold);     // HUD component re-renders
 *
 * Setting a value that is `Object.is`-equal to the current one does nothing, so replace
 * objects and arrays instead of mutating them: `list.value = [...list.value, item]`.
 */
export class Observable<T> {
  private current: T;
  private readonly subscribers = new Set<(value: ReadonlyValue<T>) => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  /** The current value, to read. To change it, assign a new one. */
  get value(): ReadonlyValue<T> {
    return this.current as ReadonlyValue<T>;
  }

  set value(next: T | ReadonlyValue<T>) {
    if (Object.is(this.current, next)) {
      // The same object or array again: it was changed in place and handed back, which
      // looks like an update and tells no subscriber.
      // (A frozen value or an empty list cannot have been changed: a shared constant set again.)
      const unchangeable = Object.isFrozen(next) || (Array.isArray(next) && next.length === 0);
      if (
        typeof next === 'object' &&
        next !== null &&
        !(next instanceof EngineObject) &&
        !unchangeable &&
        !this.warned
      ) {
        this.warned = true;
        console.warn(
          'An Observable was given the object it already holds, so nothing was told that it changed. ' +
            'Changing a value in place is not seen: assign a new one, such as { ...old, gold } or [...old, item].',
        );
      }
      return;
    }
    this.current = next as T;
    for (const subscriber of [...this.subscribers]) subscriber(this.current as ReadonlyValue<T>);
  }

  private warned = false;

  /** Sets the value from the previous one: `score.update((s) => s + 1)`. */
  update(change: (previous: ReadonlyValue<T>) => T | ReadonlyValue<T>): void {
    this.value = change(this.current as ReadonlyValue<T>);
  }

  /** Subscribes to changes. Returns the unsubscribe function. */
  subscribe = (subscriber: (value: ReadonlyValue<T>) => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  };

  /** Stable getter for the current value (what `useObservable` reads while rendering). */
  getSnapshot = (): ReadonlyValue<T> => this.current as ReadonlyValue<T>;
}
