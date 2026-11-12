import type { MonoBehaviour } from './MonoBehaviour';
import type { TimeState } from './Time';

/** Base class for the things a coroutine can `yield` to wait on. */
export abstract class YieldInstruction {
  /**
   * Makes the type its own: without a member, anything at all would count as a
   * YieldInstruction, and `yield 2` or `yield WaitForSeconds` (the class, without `new`)
   * would compile. It exists only for the type checker.
   */
  declare protected readonly _yieldInstruction: true;
}

/** Waits for scaled game time. `yield new WaitForSeconds(1.5)`. */
export class WaitForSeconds extends YieldInstruction {
  constructor(readonly seconds: number) {
    super();
  }
}

/** Waits for real time, ignoring `Time.timeScale`. */
export class WaitForSecondsRealtime extends YieldInstruction {
  constructor(readonly seconds: number) {
    super();
  }
}

/** Resumes at the end of the current frame, after every update. */
export class WaitForEndOfFrame extends YieldInstruction {}

/** Resumes after the next fixed update step. */
export class WaitForFixedUpdate extends YieldInstruction {}

/** Resumes on the first frame `predicate` returns true. */
export class WaitUntil extends YieldInstruction {
  constructor(readonly predicate: () => boolean) {
    super();
  }
}

/** Resumes on the first frame `predicate` returns false. */
export class WaitWhile extends YieldInstruction {
  constructor(readonly predicate: () => boolean) {
    super();
  }
}

/**
 * Base class for your own wait conditions: the coroutine resumes on the first frame
 * `keepWaiting` is false. Unity: `CustomYieldInstruction`. `Tween` is one of these, so
 * `yield Tween.move(...)` waits for the tween to finish.
 */
export abstract class CustomYieldInstruction extends YieldInstruction {
  abstract get keepWaiting(): boolean;
}

/**
 * Everything a coroutine may yield:
 * - `null` / `undefined`: wait one frame
 * - a `YieldInstruction` (WaitForSeconds, WaitUntil, ...)
 * - a `Coroutine` handle: wait for that coroutine to finish
 * - a `Promise`: wait for it to settle (a TypeScript-only convenience, e.g. `yield fetch(url)`)
 * - another generator: run it inline, then continue
 */
export type Yieldable =
  YieldInstruction | Coroutine | PromiseLike<unknown> | Iterator<Yieldable, unknown, unknown> | null | undefined | void;

/**
 * The type of a coroutine body. Unity's `IEnumerator`:
 *
 *   *fadeOut(): IEnumerator {
 *     yield new WaitForSeconds(1);
 *     this.gameObject.setActive(false);
 *   }
 */
export type IEnumerator = Generator<Yieldable, void, unknown>;

type Phase = 'update' | 'fixed' | 'endOfFrame';

/** Handle returned by `startCoroutine`. Yield it to wait, or pass it to `stopCoroutine`. */
export class Coroutine {
  /** @internal */
  _stack: Iterator<Yieldable, unknown, unknown>[];
  /** @internal */
  _ready: (phase: Phase) => boolean = () => false;
  /** @internal */
  _done = false;
  /** @internal True while this coroutine's generator is executing. */
  _running = false;
  /** @internal What the last wait produced (a promise's value); handed to the generator when it resumes. */
  _resumeWith: unknown = undefined;

  /** @internal */
  constructor(
    /** @internal */ readonly _owner: MonoBehaviour,
    routine: Iterator<Yieldable, unknown, unknown>,
  ) {
    this._stack = [routine];
  }

  get isDone(): boolean {
    return this._done;
  }
}

function isIterator(value: unknown): value is Iterator<Yieldable, unknown, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Iterator<unknown>).next === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

/** @internal Runs every coroutine in the engine. */
export class CoroutineScheduler {
  private active: Coroutine[] = [];

  constructor(
    private readonly time: TimeState,
    private readonly reportError: (error: unknown, context: string) => void,
  ) {}

  start(owner: MonoBehaviour, routine: Iterator<Yieldable, unknown, unknown>): Coroutine {
    if (!isIterator(routine)) {
      throw new TypeError(
        'startCoroutine expects a generator object. Call the generator function: ' +
          'this.startCoroutine(this.myRoutine()).',
      );
    }
    const coroutine = new Coroutine(owner, routine);
    this.active.push(coroutine);
    // Like Unity, run up to the first `yield` straight away.
    this.step(coroutine);
    return coroutine;
  }

  stop(coroutine: Coroutine): void {
    if (coroutine._done) return;
    coroutine._done = true;
    // A coroutine may stop itself (setActive(false), stopAllCoroutines, destroy...). A
    // running generator cannot be closed from inside, so `step` closes it once it yields.
    if (!coroutine._running) this.close(coroutine);
  }

  /** Runs the generators' `finally` blocks and drops them. */
  private close(coroutine: Coroutine): void {
    const stack = coroutine._stack;
    coroutine._stack = [];
    for (const iterator of stack.reverse()) {
      try {
        iterator.return?.(undefined);
      } catch (error) {
        this.reportError(error, `stopping a coroutine on ${coroutine._owner}`);
      }
    }
  }

  stopAll(owner: MonoBehaviour): void {
    for (const coroutine of this.active) {
      if (coroutine._owner === owner) this.stop(coroutine);
    }
  }

  tick(phase: Phase): void {
    if (this.active.length === 0) return;
    const count = this.active.length;
    for (let i = 0; i < count; i++) {
      const coroutine = this.active[i];
      if (!coroutine || coroutine._done) continue;
      if (coroutine._owner._destroyed) {
        this.stop(coroutine);
        continue;
      }
      let ready: boolean;
      try {
        ready = coroutine._ready(phase);
      } catch (error) {
        // A wait condition (WaitUntil, keepWaiting, ...) threw: end this coroutine only.
        this.stop(coroutine);
        this.reportError(error, `a wait condition of a coroutine on ${coroutine._owner}`);
        continue;
      }
      if (ready) this.step(coroutine);
    }
    if (phase === 'endOfFrame') {
      this.active = this.active.filter((coroutine) => !coroutine._done);
    }
  }

  private step(coroutine: Coroutine): void {
    while (!coroutine._done) {
      const iterator = coroutine._stack[coroutine._stack.length - 1];
      if (!iterator) {
        coroutine._done = true;
        return;
      }
      let result: IteratorResult<Yieldable, unknown>;
      coroutine._running = true;
      // What the coroutine waited on hands back a value: `const data = yield fetch(url)`.
      const resumeWith = coroutine._resumeWith;
      coroutine._resumeWith = undefined;
      try {
        result = iterator.next(resumeWith);
      } catch (error) {
        coroutine._running = false;
        coroutine._done = true;
        coroutine._stack.pop(); // this generator is finished; close any it was nested in
        this.close(coroutine);
        this.reportError(error, `a coroutine on ${coroutine._owner}`);
        return;
      }
      coroutine._running = false;
      if (coroutine._done) {
        // It stopped itself while running.
        this.close(coroutine);
        return;
      }
      if (result.done) {
        coroutine._stack.pop();
        continue; // Resume the parent generator (or finish) right away.
      }
      const value = result.value;
      if (isIterator(value) && !(value instanceof Coroutine)) {
        coroutine._stack.push(value);
        continue;
      }
      try {
        coroutine._ready = this.waitFor(coroutine, value);
      } catch (error) {
        // It yielded something that cannot be waited on: end this coroutine, not the frame.
        this.stop(coroutine);
        this.reportError(error, `a coroutine on ${coroutine._owner}`);
      }
      return;
    }
  }

  private waitFor(coroutine: Coroutine, value: Yieldable): (phase: Phase) => boolean {
    const time = this.time;
    const yieldFrame = time.frameCount;
    // Waits never resume in the frame they were yielded in, matching Unity.
    const nextUpdate = (phase: Phase) => phase === 'update' && time.frameCount > yieldFrame;

    if (value == null) return nextUpdate;
    if (value instanceof WaitForSeconds) {
      const resumeAt = time.time + value.seconds;
      return (phase) => nextUpdate(phase) && time.time >= resumeAt - 1e-9;
    }
    if (value instanceof WaitForSecondsRealtime) {
      const resumeAt = time.unscaledTime + value.seconds;
      return (phase) => nextUpdate(phase) && time.unscaledTime >= resumeAt - 1e-9;
    }
    if (value instanceof WaitForEndOfFrame) return (phase) => phase === 'endOfFrame';
    if (value instanceof WaitForFixedUpdate) return (phase) => phase === 'fixed';
    if (value instanceof WaitUntil) return (phase) => nextUpdate(phase) && value.predicate();
    if (value instanceof WaitWhile) return (phase) => nextUpdate(phase) && !value.predicate();
    if (value instanceof CustomYieldInstruction) return (phase) => nextUpdate(phase) && !value.keepWaiting;
    if (value instanceof Coroutine) return (phase) => phase === 'update' && value._done;
    if (isThenable(value)) {
      let settled = false;
      value.then(
        (result: unknown) => {
          settled = true;
          coroutine._resumeWith = result;
        },
        (error: unknown) => {
          settled = true;
          this.stop(coroutine);
          this.reportError(error, `a promise awaited by a coroutine on ${coroutine._owner}`);
        },
      );
      return (phase) => phase === 'update' && settled;
    }
    const shown =
      typeof value === 'function' ? `the function ${(value as { name: string }).name}` : JSON.stringify(value);
    throw new TypeError(
      `A coroutine yielded ${shown}, which is not something to wait on. Yield null (one frame), ` +
        'a wait such as new WaitForSeconds(1) (with `new`), a Tween, a Coroutine, a promise, or another generator.',
    );
  }
}
