import { currentEngine } from './runtime';

/** @internal Per-engine clock state behind the static `Time` API. */
export class TimeState {
  time = 0;
  unscaledTime = 0;
  deltaTime = 0;
  unscaledDeltaTime = 0;
  fixedDeltaTime = 0.02;
  fixedTime = 0;
  frameCount = 0;
  timeScale = 1;
  maximumDeltaTime = 0.1;
  /** True while `fixedUpdate` callbacks are running. */
  inFixedTimeStep = false;
  /** Unprocessed simulation time carried between frames for the fixed-step loop. */
  accumulator = 0;
  readonly startedAt = performance.now();

  /** Advances the clock by one frame of `unscaledDelta` real seconds. */
  beginFrame(unscaledDelta: number): void {
    const clamped = Math.min(Math.max(unscaledDelta, 0), this.maximumDeltaTime);
    this.frameCount++;
    this.unscaledDeltaTime = clamped;
    this.unscaledTime += clamped;
    this.deltaTime = clamped * this.timeScale;
    this.time += this.deltaTime;
    this.accumulator += this.deltaTime;
  }
}

/**
 * Unity's `Time`. Read `Time.deltaTime` in `update` to make movement frame-rate independent.
 */
export class Time {
  /** Seconds since the last frame, scaled by `timeScale`. Inside `fixedUpdate` this is `fixedDeltaTime`. */
  static get deltaTime(): number {
    const state = currentEngine().time;
    return state.inFixedTimeStep ? state.fixedDeltaTime : state.deltaTime;
  }

  /** Seconds since the last frame, ignoring `timeScale`. Use for UI and pause menus. */
  static get unscaledDeltaTime(): number {
    return currentEngine().time.unscaledDeltaTime;
  }

  /** Scaled seconds since the engine started. Inside `fixedUpdate` this is `fixedTime`. */
  static get time(): number {
    const state = currentEngine().time;
    return state.inFixedTimeStep ? state.fixedTime : state.time;
  }

  static get unscaledTime(): number {
    return currentEngine().time.unscaledTime;
  }

  /** The interval between `fixedUpdate` calls. Default 0.02 (50 Hz). */
  static get fixedDeltaTime(): number {
    return currentEngine().time.fixedDeltaTime;
  }

  static set fixedDeltaTime(value: number) {
    if (!(value > 0)) throw new RangeError('Time.fixedDeltaTime must be greater than 0.');
    currentEngine().time.fixedDeltaTime = value;
  }

  static get fixedTime(): number {
    return currentEngine().time.fixedTime;
  }

  /** 1 is normal speed, 0.5 is slow motion, 0 pauses everything driven by `deltaTime`. */
  static get timeScale(): number {
    return currentEngine().time.timeScale;
  }

  static set timeScale(value: number) {
    if (!(value >= 0)) throw new RangeError('Time.timeScale cannot be negative.');
    currentEngine().time.timeScale = value;
  }

  /** The longest `deltaTime` a single frame may report. Stops huge jumps after a stall. */
  static get maximumDeltaTime(): number {
    return currentEngine().time.maximumDeltaTime;
  }

  static set maximumDeltaTime(value: number) {
    currentEngine().time.maximumDeltaTime = value;
  }

  /** Number of frames started so far. */
  static get frameCount(): number {
    return currentEngine().time.frameCount;
  }

  static get inFixedTimeStep(): boolean {
    return currentEngine().time.inFixedTimeStep;
  }

  /** Real seconds since the engine was created. */
  static get realtimeSinceStartup(): number {
    return (performance.now() - currentEngine().time.startedAt) / 1000;
  }
}
