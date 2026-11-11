import type * as pc from 'playcanvas';
import type { Component } from './Component';
import type { EngineObject } from './EngineObject';
import { existingGameObjectOf, GameObject, localEnabled } from './GameObject';
import type { MessageName, MonoBehaviour } from './MonoBehaviour';
import type { TimeState } from './Time';
import { Transform } from './Transform';

/** A list that tolerates entries being removed while it is being iterated. */
class BehaviourList {
  private items: (MonoBehaviour | null)[] = [];
  private iterating = 0;
  private dirty = false;

  add(behaviour: MonoBehaviour): void {
    this.items.push(behaviour);
  }

  remove(behaviour: MonoBehaviour): void {
    const index = this.items.indexOf(behaviour);
    if (index < 0) return;
    if (this.iterating > 0) {
      this.items[index] = null;
      this.dirty = true;
    } else {
      this.items.splice(index, 1);
    }
  }

  run(message: MessageName): void {
    this.iterating++;
    // Behaviours added during this pass wait until the next frame.
    const count = this.items.length;
    for (let i = 0; i < count; i++) {
      const behaviour = this.items[i];
      if (behaviour && behaviour._live && behaviour._started) behaviour._send(message);
    }
    this.iterating--;
    if (this.iterating === 0 && this.dirty) {
      this.items = this.items.filter((item) => item !== null);
      this.dirty = false;
    }
  }
}

/**
 * @internal Drives Unity's object lifecycle: awake/onEnable/start ordering, the update
 * lists, and deferred destruction.
 */
export class Lifecycle {
  private suspendDepth = 0;
  private deferred: Component[] = [];
  private pendingStart: MonoBehaviour[] = [];
  private destroyQueue: { target: EngineObject; time: number }[] = [];
  private readonly updates = new BehaviourList();
  private readonly lateUpdates = new BehaviourList();
  private readonly fixedUpdates = new BehaviourList();

  constructor(private readonly time: TimeState) {}

  // ---- Awake / enable ---------------------------------------------------------------

  componentAdded(component: Component): void {
    if (this.suspendDepth > 0) {
      component._deferred = true;
      this.deferred.push(component);
      return;
    }
    // A scene that is still being built wakes all of its scripts together at the end.
    const waiting = component.gameObject.scene._pending;
    if (waiting) {
      component._deferred = true;
      waiting.push(component);
      return;
    }
    this.refresh(component);
  }

  /**
   * Brings a component's awake/enabled state in line with its GameObject's active state
   * and its own `enabled` flag, sending whichever messages are now owed.
   */
  refresh(component: Component): void {
    if (component._destroyed || component._deferred) return;
    if (!component._awoken && component.gameObject.activeInHierarchy) {
      component._awoken = true;
      component._awake();
    }
    // Re-read everything: `awake` may have disabled, deactivated or destroyed things.
    const shouldBeLive =
      !component._destroyed && component._awoken && component._wantsLive() && component.gameObject.activeInHierarchy;
    if (shouldBeLive && !component._live) {
      component._live = true;
      component._enable();
    } else if (!shouldBeLive && component._live) {
      component._live = false;
      component._disable();
    }
  }

  /** Called when `start` (and everything under it) became active or inactive in the hierarchy. */
  hierarchyActiveChanged(start: pc.GraphNode, active: boolean): void {
    const visit = (node: pc.GraphNode): void => {
      const gameObject = existingGameObjectOf(node);
      if (gameObject) {
        for (const component of [...gameObject._components]) {
          this.refresh(component);
          if (!active) component._gameObjectDeactivated();
        }
      }
      for (const child of [...node.children]) {
        // A locally inactive child was inactive before and still is: nothing changed below it.
        if (localEnabled(child)) visit(child);
      }
    };
    visit(start);
  }

  /**
   * While suspended, newly added components do not receive `awake`/`onEnable`. They all
   * get them, in creation order, when the outermost `resume` is called. Scene loading and
   * `instantiate` use this so that a whole hierarchy exists before any script wakes up.
   */
  suspend(): void {
    this.suspendDepth++;
  }

  resume(): void {
    if (this.suspendDepth === 0) return;
    if (--this.suspendDepth > 0) return;
    const batch = this.deferred;
    this.deferred = [];
    // Objects made inside a scene that is still being built keep waiting for that scene.
    const ready = batch.filter((component) => {
      const waiting = component.gameObject.scene._pending;
      if (waiting) waiting.push(component);
      return !waiting;
    });
    this.wake(ready);
  }

  /** Sends the owed awake/onEnable to a batch of deferred components, in creation order. */
  wake(batch: Component[]): void {
    for (const component of batch) component._deferred = false;
    this.each(batch, (component) => this.refresh(component));
  }

  /**
   * Calls `action` for every item even if one throws, then rethrows the first error.
   * Without this, one failing script would leave the rest of a batch in limbo.
   */
  private each<T>(items: readonly T[], action: (item: T) => void): void {
    let failure: { error: unknown } | null = null;
    for (const item of items) {
      try {
        action(item);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** Runs `build` with lifecycle callbacks deferred until it returns. */
  runDeferred<T>(build: () => T): T {
    this.suspend();
    try {
      return build();
    } finally {
      this.resume();
    }
  }

  // ---- Update lists -----------------------------------------------------------------

  register(behaviour: MonoBehaviour): void {
    if (behaviour._has('update')) this.updates.add(behaviour);
    if (behaviour._has('lateUpdate')) this.lateUpdates.add(behaviour);
    if (behaviour._has('fixedUpdate')) this.fixedUpdates.add(behaviour);
  }

  unregister(behaviour: MonoBehaviour): void {
    if (behaviour._has('update')) this.updates.remove(behaviour);
    if (behaviour._has('lateUpdate')) this.lateUpdates.remove(behaviour);
    if (behaviour._has('fixedUpdate')) this.fixedUpdates.remove(behaviour);
  }

  queueStart(behaviour: MonoBehaviour): void {
    if (behaviour._startQueued) return;
    behaviour._startQueued = true;
    this.pendingStart.push(behaviour);
  }

  /** Sends `start` to everything waiting for it, including objects created by a `start`. */
  runStarts(): void {
    while (this.pendingStart.length > 0) {
      const batch = this.pendingStart;
      this.pendingStart = [];
      this.each(batch, (behaviour) => {
        behaviour._startQueued = false;
        // If it was disabled before starting, `_enable` will queue it again later.
        if (behaviour._destroyed || behaviour._started || !behaviour._live) return;
        behaviour._started = true;
        behaviour._send('start');
      });
    }
  }

  runFixedUpdates(): void {
    this.runStarts();
    this.fixedUpdates.run('fixedUpdate');
  }

  runUpdates(): void {
    this.runStarts();
    this.updates.run('update');
  }

  runLateUpdates(): void {
    this.runStarts();
    this.lateUpdates.run('lateUpdate');
  }

  // ---- Destruction ------------------------------------------------------------------

  /** Queues `target` to be destroyed at the end of the frame, `delay` seconds from now. */
  destroy(target: GameObject | Component, delay = 0): void {
    if (target._destroyed) return;
    if (target instanceof Transform) {
      throw new Error(`Cannot destroy the Transform of "${target.name}". Destroy the GameObject instead.`);
    }
    this.destroyQueue.push({ target, time: this.time.time + Math.max(0, delay) });
  }

  processDestroyQueue(): void {
    if (this.destroyQueue.length === 0) return;
    const now = this.time.time;
    const due: EngineObject[] = [];
    this.destroyQueue = this.destroyQueue.filter((entry) => {
      if (entry.time > now + 1e-9) return true;
      due.push(entry.target);
      return false;
    });
    this.each(due, (target) => this.destroyNow(target as GameObject | Component));
  }

  destroyNow(target: GameObject | Component): void {
    if (target._destroyed) return;
    if (target instanceof GameObject) this.destroyGameObject(target);
    else this.destroyComponent(target);
  }

  private destroyGameObject(root: GameObject): void {
    const all: GameObject[] = [];
    const collect = (node: pc.GraphNode): void => {
      const gameObject = existingGameObjectOf(node);
      if (gameObject) all.push(gameObject);
      for (const child of node.children) collect(child);
    };
    collect(root.entity);

    for (const gameObject of all) {
      for (const component of [...gameObject._components]) {
        if (component._live) {
          component._live = false;
          component._disable();
        }
      }
    }
    for (const gameObject of all) {
      for (const component of [...gameObject._components]) {
        if (component._destroyed) continue;
        component._destroyed = true;
        component._destroy();
      }
      gameObject._destroyed = true;
    }
    root.entity.destroy();
  }

  private destroyComponent(component: Component): void {
    if (component instanceof Transform) {
      throw new Error(`Cannot destroy the Transform of "${component.name}". Destroy the GameObject instead.`);
    }
    if (component._live) {
      component._live = false;
      component._disable();
    }
    component._destroyed = true;
    component._destroy();
    const list = component.gameObject._components;
    const index = list.indexOf(component);
    if (index >= 0) list.splice(index, 1);
  }
}
