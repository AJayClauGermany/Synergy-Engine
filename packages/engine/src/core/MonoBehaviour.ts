import { Behaviour } from './Component';
import { type Coroutine, type IEnumerator, WaitForSeconds, type Yieldable } from './Coroutine';
import { Observable, UnityEvent } from './events';
import { checkMessageNames, type UseCamelCase } from './messageNames';
import { currentEngine } from './runtime';
import { typeNameOf } from './typeNames';

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
  /**
   * @internal The messages the engine sends to this kind of script. Subclasses that add
   * their own (netcode's `onNetworkSpawn`) extend the list, so a misspelling of those is
   * caught too.
   */
  static readonly _messageNames: readonly string[] = [
    'awake',
    'onEnable',
    'start',
    'update',
    'lateUpdate',
    'fixedUpdate',
    'onDisable',
    'onDestroy',
    'onMouseDown',
    'onMouseUp',
    'onMouseEnter',
    'onMouseOver',
    'onMouseExit',
    'onDrawGizmos',
    'onDrawGizmosSelected',
  ];

  /** @internal */
  _started = false;
  /** @internal */
  _startQueued = false;
  /** @internal */
  _invokes: { method: () => void; coroutine: Coroutine }[] = [];

  // ---- Messages (all optional) ------------------------------------------------------
  // The return types are unions on purpose. A plain `void` accepts a method that returns
  // anything, so `*update(): IEnumerator` and `async update()` would compile, and the
  // engine would call them and get a generator or a promise it has no use for. With a
  // union the compiler checks what is returned: nothing, or (where Unity allows a
  // coroutine) an IEnumerator.

  /** Called once when the object first becomes active, before any `start`. */
  protected awake?(): void | undefined;
  /** Called each time the behaviour becomes enabled and active. */
  protected onEnable?(): void | undefined;
  /**
   * Called once, just before the first update. Other objects have finished `awake` by now.
   * May be a coroutine, as in Unity: `*start(): IEnumerator { yield new WaitForSeconds(1); ... }`.
   */
  protected start?(): void | IEnumerator;
  /** Called every frame. Use `Time.deltaTime`. */
  protected update?(): void | undefined;
  /** Called every frame after all `update`s. Good for cameras that follow things. */
  protected lateUpdate?(): void | undefined;
  /** Called on a fixed timestep (`Time.fixedDeltaTime`). Good for simulation. */
  protected fixedUpdate?(): void | undefined;
  /** Called each time the behaviour becomes disabled or inactive. */
  protected onDisable?(): void | undefined;
  /** Called once when destroyed (only if `awake` ran). */
  protected onDestroy?(): void | undefined;

  /** Mouse pressed while over this object's Collider. Needs a `Camera.main`. May be a coroutine. */
  protected onMouseDown?(): void | IEnumerator;
  /** Mouse released, sent to the object that received `onMouseDown`. May be a coroutine. */
  protected onMouseUp?(): void | IEnumerator;
  /** Mouse moved onto this object's Collider. May be a coroutine. */
  protected onMouseEnter?(): void | IEnumerator;
  /** Called every frame the mouse is over this object's Collider. */
  protected onMouseOver?(): void | undefined;
  /** Mouse moved off this object's Collider. May be a coroutine. */
  protected onMouseExit?(): void | IEnumerator;

  /**
   * Draw with `Gizmos` here: ranges, paths, targets. Called every frame while the editor
   * (`@synergy/devtools`, development builds only) is open with Gizmos on, and never in a
   * release build, as in Unity.
   */
  protected onDrawGizmos?(): void | undefined;
  /** As `onDrawGizmos`, only while this object or one of its parents is selected in the Hierarchy. */
  protected onDrawGizmosSelected?(): void | undefined;

  // ---- Unity's spellings --------------------------------------------------------------
  // A method named `Update` would compile and never be called. These declarations turn
  // that into a type error on the offending line; they produce no code. A check at
  // run time (see messageNames.ts) covers code that is not type-checked before it runs.

  /** @deprecated Write `awake()`. */
  declare protected Awake?: UseCamelCase<'awake'>;
  /** @deprecated Write `onEnable()`. */
  declare protected OnEnable?: UseCamelCase<'onEnable'>;
  /** @deprecated Write `start()`. */
  declare protected Start?: UseCamelCase<'start'>;
  /** @deprecated Write `update()`. */
  declare protected Update?: UseCamelCase<'update'>;
  /** @deprecated Write `lateUpdate()`. */
  declare protected LateUpdate?: UseCamelCase<'lateUpdate'>;
  /** @deprecated Write `fixedUpdate()`. */
  declare protected FixedUpdate?: UseCamelCase<'fixedUpdate'>;
  /** @deprecated Write `onDisable()`. */
  declare protected OnDisable?: UseCamelCase<'onDisable'>;
  /** @deprecated Write `onDestroy()`. */
  declare protected OnDestroy?: UseCamelCase<'onDestroy'>;
  /** @deprecated Write `onMouseDown()`. */
  declare protected OnMouseDown?: UseCamelCase<'onMouseDown'>;
  /** @deprecated Write `onMouseUp()`. */
  declare protected OnMouseUp?: UseCamelCase<'onMouseUp'>;
  /** @deprecated Write `onMouseEnter()`. */
  declare protected OnMouseEnter?: UseCamelCase<'onMouseEnter'>;
  /** @deprecated Write `onMouseOver()`. */
  declare protected OnMouseOver?: UseCamelCase<'onMouseOver'>;
  /** @deprecated Write `onMouseExit()`. */
  declare protected OnMouseExit?: UseCamelCase<'onMouseExit'>;
  /** @deprecated Write `onDrawGizmos()`. */
  declare protected OnDrawGizmos?: UseCamelCase<'onDrawGizmos'>;
  /** @deprecated Write `onDrawGizmosSelected()`. */
  declare protected OnDrawGizmosSelected?: UseCamelCase<'onDrawGizmosSelected'>;

  constructor() {
    super();
    checkMessageNames(new.target);
  }

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
    if (this._destroyed) {
      throw new Error(`Coroutine could not be started because "${this.name}" has been destroyed.`);
    }
    if (!this.gameObject.activeInHierarchy) {
      throw new Error(`Coroutine could not be started because GameObject "${this.name}" is inactive.`);
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
    return this._invokes.some((entry) => !entry.coroutine.isDone && (!method || entry.method === method));
  }

  // ---- Engine plumbing --------------------------------------------------------------

  /** @internal Calls an optional message, routing exceptions to the engine's error handler. */
  _send(message: MessageName): void {
    const handler = (this as unknown as Record<MessageName, (() => void) | undefined>)[message];
    if (typeof handler !== 'function') return;
    try {
      const result: unknown = (handler as () => unknown).call(this);
      if (result !== undefined && result !== null) this._returned(message, result);
    } catch (error) {
      currentEngine().reportError(error, `${typeNameOf(this)}.${message} on "${this.name}"`);
    }
  }

  /**
   * A message that returned something. Unity: `IEnumerator Start()` runs as a coroutine,
   * and so does `*start(): IEnumerator` here. An `async` message returns a promise; if
   * that fails, the error is reported instead of vanishing.
   */
  private _returned(message: MessageName, result: unknown): void {
    const candidate = result as { next?: unknown; then?: unknown };
    if (typeof candidate.next === 'function') {
      currentEngine().coroutines.start(this, result as Iterator<Yieldable, unknown, unknown>);
    } else if (typeof candidate.then === 'function') {
      const engine = currentEngine();
      const context = `${typeNameOf(this)}.${message} on "${this.name}" (after an await)`;
      (result as PromiseLike<unknown>).then(undefined, (error: unknown) => engine.reportError(error, context));
    }
  }

  /** @internal */
  _has(message: MessageName): boolean {
    return typeof (this as unknown as Record<MessageName, unknown>)[message] === 'function';
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
   *
   * Arrays and object literals are copied all the way down. Class instances (vectors,
   * materials, your own classes) are shared by reference.
   *
   * Not copied, so the clone keeps what its own field initialisers created: functions
   * (an arrow-function field would stay bound to the original), and per-instance
   * containers (`UnityEvent`, `Observable`, `Map`, `Set`) that must not be shared.
   */
  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    const target = this as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key.startsWith('_') || key === 'gameObject') continue;
      const value = (source as Record<string, unknown>)[key];
      if (
        typeof value === 'function' ||
        value instanceof UnityEvent ||
        value instanceof Observable ||
        value instanceof Map ||
        value instanceof Set
      ) {
        continue;
      }
      target[key] = copyData(value, remap);
    }
  }
}

/**
 * Copies plain data (arrays and object literals) all the way down, so a clone never
 * shares nested state with its original. Class instances are kept by reference: values
 * such as `Vector3` are immutable, and assets such as `Material` are meant to be shared.
 */
function copyData(value: unknown, remap: <V>(value: V) => V): unknown {
  if (Array.isArray(value)) return value.map((item) => copyData(item, remap));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyData(item, remap)]));
  }
  return remap(value);
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
  | 'onMouseExit'
  | 'onDrawGizmos'
  | 'onDrawGizmosSelected';
