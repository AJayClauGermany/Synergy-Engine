/** A minimal typed event. `add` returns the function that removes the listener. */
export class Signal<Args extends unknown[] = []> {
  private listeners: ((...args: Args) => void)[] = [];

  add(listener: (...args: Args) => void): () => void {
    this.listeners.push(listener);
    return () => this.remove(listener);
  }

  remove(listener: (...args: Args) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  emit(...args: Args): void {
    for (const listener of [...this.listeners]) listener(...args);
  }

  clear(): void {
    this.listeners = [];
  }
}
