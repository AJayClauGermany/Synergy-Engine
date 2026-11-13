import { Color } from '../math/Color';
import { Quaternion } from '../math/Quaternion';
import { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';
import { Component } from './Component';
import { CustomYieldInstruction } from './Coroutine';
import { type EngineObject, isAlive } from './EngineObject';
import { currentEngine } from './runtime';
import type { Transform } from './Transform';

/** Maps progress 0..1 to eased progress. Results may leave 0..1 (e.g. `OutBack` overshoots). */
export type EaseFunction = (t: number) => number;

const BACK = 1.70158;

/** Standard easing curves. Pass one to `tween.setEase(...)`, or supply your own function. */
export const Ease = {
  Linear: (t: number) => t,
  InQuad: (t: number) => t * t,
  OutQuad: (t: number) => 1 - (1 - t) * (1 - t),
  InOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  InCubic: (t: number) => t * t * t,
  OutCubic: (t: number) => 1 - (1 - t) ** 3,
  InOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  InSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  OutSine: (t: number) => Math.sin((t * Math.PI) / 2),
  InOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  InBack: (t: number) => (BACK + 1) * t * t * t - BACK * t * t,
  OutBack: (t: number) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  OutBounce: (t: number) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
    if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
    return n * (t - 2.625 / d) ** 2 + 0.984375;
  },
} as const satisfies Record<string, EaseFunction>;

export enum LoopType {
  /** Start again from the beginning each loop. */
  Restart = 'restart',
  /** Play forward, then backward, and so on. */
  Yoyo = 'yoyo',
}

type Tweenable = number | Vector2 | Vector3 | Color | Quaternion;

function interpolate<T extends Tweenable>(from: T, to: T, t: number): T {
  if (typeof from === 'number') return (from + ((to as number) - from) * t) as T;
  if (from instanceof Vector3) return Vector3.lerpUnclamped(from, to as Vector3, t) as T;
  if (from instanceof Vector2) return Vector2.lerpUnclamped(from, to as Vector2, t) as T;
  if (from instanceof Quaternion) return Quaternion.slerpUnclamped(from, to as Quaternion, t) as T;
  const a = from as Color;
  const b = to as Color;
  return new Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t) as T;
}

/**
 * Animates a value over time. Unity has no built-in tweening; this covers what DOTween
 * is typically used for, with similar names:
 *
 *   Tween.move(transform, target, 0.4).setEase(Ease.OutCubic).onComplete(() => ...);
 *   Tween.to(0, 1, 0.3, (alpha) => (material.color = material.color.withAlpha(alpha)));
 *   yield Tween.scale(transform, Vector3.one.mul(1.2), 0.1).setLoops(2, LoopType.Yoyo);   // in a coroutine
 *
 * Tweens run on game time (`Time.timeScale` affects them) unless `setUpdate(true)` is
 * used. A tween with a target is cancelled automatically when that object is destroyed.
 */
export class Tween extends CustomYieldInstruction {
  private elapsed = 0;
  private delay = 0;
  private ease: EaseFunction = Ease.OutQuad;
  private loops = 1;
  private loopType = LoopType.Restart;
  private unscaled = false;
  private completed = false;
  private killed = false;
  private completeHandlers: (() => void)[] = [];
  /** @internal */
  _target: EngineObject | null = null;

  private constructor(
    private readonly duration: number,
    private readonly apply: (t: number) => void,
  ) {
    super();
  }

  // ---- Creating tweens ----------------------------------------------------------------

  /** Animates from `from` to `to` over `duration` seconds, calling `onUpdate` with each value. */
  static to<T extends Tweenable>(from: T, to: T, duration: number, onUpdate: (value: T) => void): Tween {
    const tween = new Tween(Math.max(0, duration), (t) => onUpdate(interpolate(from, to, t)));
    currentEngine().tweens.add(tween);
    return tween;
  }

  /** Moves a transform to a world position. DOTween: `transform.DOMove`. */
  static move(transform: Transform, to: Vector3, duration: number): Tween {
    return Tween.to(transform.position, to, duration, (value) => {
      transform.position = value;
    }).setTarget(transform.gameObject);
  }

  /** Moves a transform to a local position. DOTween: `transform.DOLocalMove`. */
  static moveLocal(transform: Transform, to: Vector3, duration: number): Tween {
    return Tween.to(transform.localPosition, to, duration, (value) => {
      transform.localPosition = value;
    }).setTarget(transform.gameObject);
  }

  /** Rotates a transform to a world rotation. DOTween: `transform.DORotateQuaternion`. */
  static rotate(transform: Transform, to: Quaternion, duration: number): Tween {
    return Tween.to(transform.rotation, to, duration, (value) => {
      transform.rotation = value;
    }).setTarget(transform.gameObject);
  }

  /** Scales a transform to a local scale. DOTween: `transform.DOScale`. */
  static scale(transform: Transform, to: Vector3, duration: number): Tween {
    return Tween.to(transform.localScale, to, duration, (value) => {
      transform.localScale = value;
    }).setTarget(transform.gameObject);
  }

  /** Calls `callback` after `delay` seconds. DOTween: `DOVirtual.DelayedCall`. */
  static delayedCall(delay: number, callback: () => void): Tween {
    return Tween.to(0, 1, 0, () => {})
      .setDelay(delay)
      .onComplete(callback);
  }

  /**
   * Cancels every running tween whose target is `target`. Returns how many were cancelled.
   * `Tween.move`, `scale` and `rotate` belong to the GameObject, so a Transform stands for
   * it here: `Tween.kill(this.transform)` is `Tween.kill(this.gameObject)` (DOTween:
   * `transform.DOKill()`). Any other target, such as a script given to `setTarget(this)`,
   * means only the tweens tied to that very object.
   */
  static kill(target: EngineObject): number {
    const tweens = currentEngine().tweens;
    const isTransform = target instanceof Component && target === target.gameObject.transform;
    return tweens.killTarget(target) + (isTransform ? tweens.killTarget(target.gameObject) : 0);
  }

  // ---- Options (chainable) ------------------------------------------------------------

  /** The easing curve. The default is `Ease.OutQuad`, as in DOTween. */
  setEase(ease: EaseFunction): this {
    this.ease = ease;
    return this;
  }

  /** Waits this many seconds before starting. */
  setDelay(seconds: number): this {
    this.delay = Math.max(0, seconds);
    return this;
  }

  /** Plays `count` times in total; `-1` loops forever. */
  setLoops(count: number, type: LoopType = LoopType.Restart): this {
    this.loops = count;
    this.loopType = type;
    return this;
  }

  /** `true` runs on real time, ignoring `Time.timeScale` (for pause menus and UI). */
  setUpdate(independentOfTimeScale: boolean): this {
    this.unscaled = independentOfTimeScale;
    return this;
  }

  /** Ties the tween to an object: it is cancelled when that object is destroyed. */
  setTarget(target: EngineObject): this {
    this._target = target;
    return this;
  }

  onComplete(handler: () => void): this {
    this.completeHandlers.push(handler);
    return this;
  }

  // ---- State --------------------------------------------------------------------------

  /** Still running (or waiting out its delay). */
  get isActive(): boolean {
    return !this.completed && !this.killed;
  }

  get isComplete(): boolean {
    return this.completed;
  }

  /** Lets a coroutine `yield` a tween to wait for it. */
  get keepWaiting(): boolean {
    return this.isActive;
  }

  /** Stops the tween where it is. With `complete`, jumps to the end and fires `onComplete` first. */
  kill(complete = false): void {
    if (!this.isActive) return;
    if (complete) this.finish();
    else this.killed = true;
  }

  /** @internal Advances the tween. Returns false once it should be dropped. */
  _tick(scaledDelta: number, unscaledDelta: number): boolean {
    if (!this.isActive) return false;
    if (this._target && !isAlive(this._target)) {
      this.killed = true;
      return false;
    }
    this.elapsed += this.unscaled ? unscaledDelta : scaledDelta;
    const time = this.elapsed - this.delay;
    if (time < 0) return true;

    const total = this.loops < 0 ? Number.POSITIVE_INFINITY : this.duration * this.loops;
    if (time >= total) {
      this.finish();
      return false;
    }
    const loop = this.duration > 0 ? Math.floor(time / this.duration) : 0;
    let t = this.duration > 0 ? time / this.duration - loop : 1;
    if (this.loopType === LoopType.Yoyo && loop % 2 === 1) t = 1 - t;
    this.apply(this.ease(t));
    return true;
  }

  private finish(): void {
    // A yoyo with an even number of loops ends back where it started.
    const endsAtStart = this.loopType === LoopType.Yoyo && this.loops > 0 && this.loops % 2 === 0;
    this.apply(this.ease(endsAtStart ? 0 : 1));
    this.completed = true;
    for (const handler of this.completeHandlers) handler();
  }
}

/** @internal Runs every tween of one engine. */
export class TweenRunner {
  private tweens: Tween[] = [];

  constructor(private readonly reportError: (error: unknown, context: string) => void) {}

  add(tween: Tween): void {
    this.tweens.push(tween);
  }

  killTarget(target: EngineObject): number {
    let count = 0;
    for (const tween of this.tweens) {
      if (tween._target === target && tween.isActive) {
        tween.kill();
        count++;
      }
    }
    return count;
  }

  tick(scaledDelta: number, unscaledDelta: number): void {
    if (this.tweens.length === 0) return;
    // Tweens started by a callback join the list and first advance next frame.
    const current = this.tweens;
    this.tweens = [];
    const alive: Tween[] = [];
    for (const tween of current) {
      try {
        if (tween._tick(scaledDelta, unscaledDelta)) alive.push(tween);
      } catch (error) {
        tween.kill();
        this.reportError(error, 'a tween callback');
      }
    }
    this.tweens = [...alive, ...this.tweens];
  }

  clear(): void {
    this.tweens = [];
  }
}
