import { Behaviour } from './Component';
import {
  type Coroutine,
  type IEnumerator,
  WaitForSeconds,
  type Yieldable,
} from './Coroutine';
import { currentEngine } from './runtime';

/**
 * Base class for your game scripts, with Unity's lifecycle. Define only the messages you
 * need; the engine calls them for you:
 *
 *   export class Spinner extends MonoBehaviour {
 *     speed = 90;
 *     update() {
 *       this.transform.rotate(Vector3.up, this.speed * Time.deltaTime);
 *     }
 *   }
 *
 * Order within a frame: awake -> onEnable -> start -> fixedUpdate (0..n times) ->
 * update -> coroutines -> lateUpdate -> destroy queue. Do setup in `awake`/`start`, not
 * in a constructor.
 */
export abstract class MonoBehaviour extends Behaviour {
  /** @internal */
  _started = false;
  /** @internal */
  _startQueued = false;
  /** @internal */
  _invokes: { method: () => void; coroutine: Coroutine }[] = [];

  // ---- Messages (all optional) ------------------------------------------------------

  /** Called once when the object first becomes active, before any `start`. */
  protected awake?(): void;
  /** Called each time the behaviour becomes enabled and active. */
  protected onEnable?(): void;
  /** Called once, just before the first update. Other objects have finished `awake` by now. */
  protected start?(): void;
  /** Called every frame. Use `Time.deltaTime`. */
  protected update?(): void;
  /** Called every frame after all `update`s. Good for cameras that follow things. */
  protected lateUpdate?(): void;
  /** Called on a fixed timestep (`Time.fixedDeltaTime`). Good for simulation. */
  protected fixedUpdate?(): void;
  /** Called each time the behaviour becomes disabled or inactive. */
  protected onDisable?(): void;
  /** Called once when destroyed (only if `awake` ran). */
  protected onDestroy?(): void;

  /** Mouse pressed while over this object's Collider. Needs a `Camera.main`. */
  protected onMouseDown?(): void;
  /** Mouse released, sent to the object that received `onMouseDown`. */
  protected onMouseUp?(): void;
  /** Mouse moved onto this object's Collider. */
  protected onMouseEnter?(): void;
  /** Called every frame the mouse is over this object's Collider. */
  protected onMouseOver?(): void;
  /** Mouse moved off this object's Collider. */
  protected onMouseExit?(): void;

  // ---- Coroutines -------------------------------------------------------------------

  /**
   * Starts a coroutine: a generator that can pause with `yield`.
   *
   *   this.startCoroutine(this.spawnWaves());
   *
   *   *spawnWaves(): IEnumerator {
   *     while (true) {
   *       this.spawn();
   *       yield new WaitForSeconds(5);
   *     }
   *   }
   *
   * It stops by itself when this GameObject is deactivated or destroyed.
   */
  startCoroutine(routine: Iterator<Yieldable, unknown, unknown>): Coroutine {
    if (!this.gameObject.activeInHierarchy) {
      throw new Error(
        `Coroutine could not be started because GameObject "${this.name}" is inactive.`,
      );
    }
    return currentEngine().coroutines.start(this, routine);
  }

  stopCoroutine(coroutine: Coroutine): void {
    currentEngine().coroutines.stop(coroutine);
  }

  stopAllCoroutines(): void {
    currentEngine().coroutines.stopAll(this);
    this._invokes = [];
  }

  /** Calls `method` (bound to this behaviour) after `time` seconds. Pass the method itself, not its name. */
  invoke(method: () => void, time: number): void {
    const bound = method;
    const self = this;
    function* run(): IEnumerator {
      yield new WaitForSeconds(time);
      self._invokes = self._invokes.filter((entry) => entry.coroutine !== coroutine);
      bound.call(self);
    }
    const coroutine: Coroutine = this.startCoroutine(run());
    if (!coroutine.isDone) this._invokes.push({ method, coroutine });
  }

  /** Calls `method` after `time` seconds, then every `repeatRate` seconds. */
  invokeRepeating(method: () => void, time: number, repeatRate: number): void {
    const self = this;
    function* run(): IEnumerator {
      yield new WaitForSeconds(time);
      while (true) {
        method.call(self);
        yield new WaitForSeconds(repeatRate);
      }
    }
    this._invokes.push({ method, coroutine: this.startCoroutine(run()) });
  }

  /** Cancels pending `invoke`/`invokeRepeating` calls, for one method or for all. */
  cancelInvoke(method?: () => void): void {
    const coroutines = currentEngine().coroutines;
    this._invokes = this._invokes.filter((entry) => {
      if (method && entry.method !== method) return true;
      coroutines.stop(entry.coroutine);
      return false;
    });
  }

  isInvoking(method?: () => void): boolean {
    return this._invokes.some(
      (entry) => !entry.coroutine.isDone && (!method || entry.method === method),
    );
  }

  // ---- Engine plumbing --------------------------------------------------------------

  /** @internal Calls an optional message, routing exceptions to the engine's error handler. */
  _send(message: MessageName): void {
    const handler = (this as unknown as Record<MessageName, (() => void) | undefined>)[message];
    if (typeof handler !== 'function') return;
    try {
      handler.call(this);
    } catch (error) {
      currentEngine().reportError(error, `${this.constructor.name}.${message} on "${this.name}"`);
    }
  }

  /** @internal */
  _has(message: MessageName): boolean {
    return (
      typeof (this as unknown as Record<MessageName, unknown>)[message] === 'function'
    );
  }

  override _awake(): void {
    this._send('awake');
  }

  override _enable(): void {
    const lifecycle = currentEngine().lifecycle;
    lifecycle.register(this);
    this._send('onEnable');
    if (!this._started && this._live) lifecycle.queueStart(this);
  }

  override _disable(): void {
    currentEngine().lifecycle.unregister(this);
    this._send('onDisable');
  }

  override _gameObjectDeactivated(): void {
    this.stopAllCoroutines();
  }

  override _destroy(): void {
    this.stopAllCoroutines();
    if (this._awoken) this._send('onDestroy');
  }

  /**
   * Cloning (`instantiate`) copies every own field except those starting with `_`,
   * which play the role of Unity's non-serialized private fields. References to objects
   * inside the cloned hierarchy are re-pointed at their clones.
   */
  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    const target = this as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key.startsWith('_') || key === 'gameObject') continue;
      const value = (source as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        target[key] = value.map((item) => remap(item));
      } else if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        target[key] = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, remap(v)]),
        );
      } else {
        target[key] = remap(value);
      }
    }
  }
}

/** @internal */
export type MessageName =
  | 'awake'
  | 'onEnable'
  | 'start'
  | 'update'
  | 'lateUpdate'
  | 'fixedUpdate'
  | 'onDisable'
  | 'onDestroy'
  | 'onMouseDown'
  | 'onMouseUp'
  | 'onMouseEnter'
  | 'onMouseOver'
  | 'onMouseExit';
