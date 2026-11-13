/**
 * Rounds to the nearest whole number, and a value exactly halfway between two goes to
 * the EVEN one: 0.5 -> 0, 1.5 -> 2, 2.5 -> 2, -2.5 -> -2. That is what Unity's
 * `Mathf.Round` and C#'s `Math.Round` do; JavaScript's `Math.round` goes up instead
 * (2.5 -> 3), which would make a ported damage or cost formula differ by one.
 */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * @internal The engine's own tolerance for "too small to divide by" (normalising a
 * near-zero vector, a ray parallel to a plane). It used to be `Mathf.epsilon`, which is
 * now Unity's value. Not part of the public API; game code picks a tolerance that fits
 * its data, as Unity's docs advise.
 */
export const ENGINE_EPSILON = 1e-6;

/**
 * Unity's `Mathf`, with camelCase members. Angles are in degrees unless a name says otherwise.
 */
export const Mathf = {
  PI: Math.PI,
  /** Multiply degrees by this to get radians. Unity: `Mathf.Deg2Rad`. */
  deg2Rad: Math.PI / 180,
  /** Multiply radians by this to get degrees. Unity: `Mathf.Rad2Deg`. */
  rad2Deg: 180 / Math.PI,
  /**
   * Same as Unity: the smallest positive float, 1.401298e-45 (Unity's value where
   * flush-to-zero is off). Comparing against it is the same as comparing exactly; for
   * "close enough" use `Mathf.approximately` or a tolerance that fits your data.
   */
  epsilon: 1.401298e-45,
  infinity: Number.POSITIVE_INFINITY,
  negativeInfinity: Number.NEGATIVE_INFINITY,

  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  /** Halfway values go to the even number, as in Unity. Use `Math.round` for round-half-up. */
  round: roundHalfToEven,
  sqrt: Math.sqrt,
  pow: Math.pow,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan2: Math.atan2,
  /** Same as Unity: 1 for zero and positive values, -1 for negative. `Math.sign(0)` is 0 instead. */
  sign: (value: number): number => (value >= 0 ? 1 : -1),

  floorToInt: (value: number): number => Math.floor(value),
  ceilToInt: (value: number): number => Math.ceil(value),
  /** Halfway values go to the even number, as in Unity: `roundToInt(2.5)` is 2. */
  roundToInt: roundHalfToEven,

  clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
  },

  clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  },

  /** Linear interpolation with `t` clamped to [0, 1], as in Unity. `lerpUnclamped` does not clamp. */
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Mathf.clamp01(t);
  },

  lerpUnclamped(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  },

  /** Where `value` sits between `a` and `b`, clamped to [0, 1]. */
  inverseLerp(a: number, b: number, value: number): number {
    return a === b ? 0 : Mathf.clamp01((value - a) / (b - a));
  },

  /** Moves `current` toward `target` by at most `maxDelta`. */
  moveTowards(current: number, target: number, maxDelta: number): number {
    if (Math.abs(target - current) <= maxDelta) return target;
    return current + Math.sign(target - current) * maxDelta;
  },

  smoothStep(from: number, to: number, t: number): number {
    const k = Mathf.clamp01(t);
    return Mathf.lerpUnclamped(from, to, k * k * (3 - 2 * k));
  },

  /**
   * Same as Unity, with Unity's formula: true when `|b - a| < max(1e-6 * max(|a|, |b|), epsilon * 8)`,
   * a difference of about one part in a million. Near zero that is almost exact equality:
   * `approximately(0, 1e-9)` is false. For values that should be near zero, compare
   * against a tolerance of your own: `Math.abs(x) < 1e-4`.
   */
  approximately(a: number, b: number): boolean {
    return Math.abs(b - a) < Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), Mathf.epsilon * 8);
  },

  /** Wraps `t` into [0, length). Like `%`, but never negative (`%` keeps the sign, as C#'s does). Same as Unity. */
  repeat(t: number, length: number): number {
    return Mathf.clamp(t - Math.floor(t / length) * length, 0, length);
  },

  pingPong(t: number, length: number): number {
    const wrapped = Mathf.repeat(t, length * 2);
    return length - Math.abs(wrapped - length);
  },

  /** Shortest signed difference between two angles, in degrees, in (-180, 180]. */
  deltaAngle(current: number, target: number): number {
    let delta = Mathf.repeat(target - current, 360);
    if (delta > 180) delta -= 360;
    return delta;
  },

  lerpAngle(a: number, b: number, t: number): number {
    return a + Mathf.deltaAngle(a, b) * Mathf.clamp01(t);
  },

  moveTowardsAngle(current: number, target: number, maxDelta: number): number {
    const delta = Mathf.deltaAngle(current, target);
    if (-maxDelta < delta && delta < maxDelta) return target;
    return Mathf.moveTowards(current, current + delta, maxDelta);
  },

  /**
   * Critically damped spring toward `target`. C# returns the value and writes velocity through `ref`;
   * here both come back as a tuple: `[value, velocity] = Mathf.smoothDamp(...)`.
   * The parameters are in Unity's order, and the last two are required (C# defaults them
   * to no limit and `Time.deltaTime`): pass `Infinity` and `Time.deltaTime`.
   */
  smoothDamp(
    current: number,
    target: number,
    currentVelocity: number,
    smoothTime: number,
    maxSpeed: number,
    deltaTime: number,
  ): [value: number, velocity: number] {
    if (!Number.isFinite(deltaTime)) {
      throw new RangeError(
        `Mathf.smoothDamp: deltaTime is ${deltaTime}. The last two arguments are (maxSpeed, deltaTime), in Unity's order: ` +
          'Mathf.smoothDamp(current, target, velocity, smoothTime, Infinity, Time.deltaTime).',
      );
    }
    const time = Math.max(0.0001, smoothTime);
    const omega = 2 / time;
    const x = omega * deltaTime;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const maxChange = maxSpeed * time;
    const change = Mathf.clamp(current - target, -maxChange, maxChange);
    const clampedTarget = current - change;
    const temp = (currentVelocity + omega * change) * deltaTime;
    let velocity = (currentVelocity - omega * temp) * exp;
    let output = clampedTarget + (change + temp) * exp;
    // Prevent overshooting.
    if (target - current > 0 === output > target) {
      output = target;
      velocity = deltaTime > 0 ? (output - target) / deltaTime : 0;
    }
    return [output, velocity];
  },
} as const;
