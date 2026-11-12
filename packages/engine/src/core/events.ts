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

  /** Adds a listener and returns a function that removes it again. */
  addListener(listener: (...args: Args) => void): () => void {
    this.listeners.push(listener);
    return () => this.removeListener(listener);
  }

  removeListener(listener: (...args: Args) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  removeAllListeners(): void {
    this.listeners = [];
  }

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
 * object whose fields cannot be assigned, a Map without `set`. Engine objects (a
 * GameObject, a component) are handed over as they are.
 *
 * This is what `observable.value` gives. The Observable only knows it changed when it is
 * given a new value, so `hud.value.gold += 5` would change what the HUD should show and
 * tell nobody; with this type it does not compile.
 */
export type ReadonlyValue<T> = T extends EngineObject | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Item[]
    : T extends ReadonlyMap<infer Key, infer Value>
      ? ReadonlyMap<Key, Value>
      : T extends ReadonlySet<infer Item>
        ? ReadonlySet<Item>
        : T extends object
          ? Readonly<T>
          : T;

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
      if (typeof next === 'object' && next !== null && !(next instanceof EngineObject) && !this.warned) {
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
