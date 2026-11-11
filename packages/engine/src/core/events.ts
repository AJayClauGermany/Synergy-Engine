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
 * A value that tells subscribers when it changes. This is the bridge between game code
 * and the React HUD (`useObservable` in `@synergy/ui`), and has no Unity equivalent.
 *
 *   export const gold = new Observable(100);
 *   gold.value += 25;                       // game code
 *   const amount = useObservable(gold);     // React component re-renders
 *
 * Setting a value that is `Object.is`-equal to the current one does nothing, so replace
 * objects and arrays instead of mutating them: `list.value = [...list.value, item]`.
 */
export class Observable<T> {
  private current: T;
  private readonly subscribers = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  set value(next: T) {
    if (Object.is(this.current, next)) return;
    this.current = next;
    for (const subscriber of [...this.subscribers]) subscriber(next);
  }

  /** Sets the value from the previous one: `score.update((s) => s + 1)`. */
  update(change: (previous: T) => T): void {
    this.value = change(this.current);
  }

  /** Subscribes to changes. Returns the unsubscribe function. */
  subscribe = (subscriber: (value: T) => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  };

  /** Stable getter, convenient for React's `useSyncExternalStore`. */
  getSnapshot = (): T => this.current;
}
