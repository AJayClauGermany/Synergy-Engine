import type { MonoBehaviour } from './MonoBehaviour';
import type { TimeState } from './Time';

/** Base class for the things a coroutine can `yield` to wait on. */
export abstract class YieldInstruction {}

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
 * Everything a coroutine may yield:
 * - `null` / `undefined`: wait one frame
 * - a `YieldInstruction` (WaitForSeconds, WaitUntil, ...)
 * - a `Coroutine` handle: wait for that coroutine to finish
 * - a `Promise`: wait for it to settle (a TypeScript-only convenience, e.g. `yield fetch(url)`)
 * - another generator: run it inline, then continue
 */
export type Yieldable =
  | YieldInstruction
  | Coroutine
  | PromiseLike<unknown>
  | Iterator<Yieldable, unknown, unknown>
  | null
  | undefined
  | void;

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
  return (
    typeof value === 'object' && value !== null && typeof (value as Iterator<unknown>).next === 'function'
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
  );
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
    for (const iterator of coroutine._stack) {
      try {
        iterator.return?.(undefined);
      } catch (error) {
        this.reportError(error, `stopping a coroutine on ${coroutine._owner}`);
      }
    }
    coroutine._stack = [];
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
      if (coroutine._ready(phase)) this.step(coroutine);
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
      try {
        result = iterator.next();
      } catch (error) {
        coroutine._done = true;
        coroutine._stack = [];
        this.reportError(error, `a coroutine on ${coroutine._owner}`);
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
      coroutine._ready = this.waitFor(coroutine, value);
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
    if (value instanceof Coroutine) return (phase) => phase === 'update' && value._done;
    if (isThenable(value)) {
      let settled = false;
      value.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          this.stop(coroutine);
          this.reportError(error, `a promise awaited by a coroutine on ${coroutine._owner}`);
        },
      );
      return (phase) => phase === 'update' && settled;
    }
    throw new TypeError(`A coroutine yielded something it cannot wait on: ${String(value)}`);
  }
}
