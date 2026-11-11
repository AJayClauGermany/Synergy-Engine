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
 * Unity's `Mathf`, with camelCase members. Angles are in degrees unless a name says otherwise.
 */
export const Mathf = {
  PI: Math.PI,
  /** Multiply degrees by this to get radians. Unity: `Mathf.Deg2Rad`. */
  deg2Rad: Math.PI / 180,
  /** Multiply radians by this to get degrees. Unity: `Mathf.Rad2Deg`. */
  rad2Deg: 180 / Math.PI,
  epsilon: 1e-6,
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

  /** Linear interpolation with `t` clamped to [0, 1]. */
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

  approximately(a: number, b: number, tolerance = 1e-5): boolean {
    return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
  },

  /** Wraps `t` into [0, length). Like modulo, but never negative. */
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
   */
  smoothDamp(
    current: number,
    target: number,
    currentVelocity: number,
    smoothTime: number,
    deltaTime: number,
    maxSpeed = Number.POSITIVE_INFINITY,
  ): [value: number, velocity: number] {
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
