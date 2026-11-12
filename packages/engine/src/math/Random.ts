/**
 * A seeded random number generator. The same seed always produces the same sequence, on
 * every machine, which is what multiplayer rules and reproducible map generation need.
 * `Math.random()` gives neither.
 *
 * Unity's `Random` is a single global generator. This one is an object, so game state
 * can own its generator explicitly:
 *
 *   const random = new Random(state.seed);
 *   const damage = random.rangeInt(2, 5);
 *   return { ...state, seed: random.state };   // carry the generator forward
 *
 * The numbers do not match Unity's for the same seed. To reproduce content generated in
 * Unity, export it as data instead of regenerating it.
 */
export class Random {
  private current: number;

  /**
   * `seed` is a whole number, and it is required: a generator made without one would give
   * every caller the same sequence, and a fraction (`Math.random()`) would be cut to 0.
   * In rules, use a seed kept in the game state; in view code `Date.now()` will do.
   */
  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new RangeError(
        `new Random(${seed}): the seed must be a whole number. It becomes a 32-bit integer, so every ` +
          'fraction below 1 would be the same seed. Use a number stored in the game state, or Date.now() in view code.',
      );
    }
    this.current = seed >>> 0;
  }

  /** The generator's whole state as one integer. Store it, and pass it to `new Random()` to continue the sequence. */
  get state(): number {
    return this.current;
  }

  set state(value: number) {
    this.current = value >>> 0;
  }

  /** The next number in [0, 1). */
  next(): number {
    // mulberry32: small, fast and well distributed for gameplay purposes.
    this.current = (this.current + 0x6d2b79f5) >>> 0;
    let t = this.current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Unity: `Random.value`. Each read advances the sequence. */
  get value(): number {
    return this.next();
  }

  /** A float in [min, max). Unity: `Random.Range(float, float)`. */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** An integer in [min, max), i.e. `max` is exclusive. Unity: `Random.Range(int, int)`. */
  rangeInt(min: number, maxExclusive: number): number {
    return min + Math.floor((maxExclusive - min) * this.next());
  }

  /** True with the given probability (0 to 1). */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** A random element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Random.pick: the list is empty.');
    return items[this.rangeInt(0, items.length)] as T;
  }

  /** A shuffled copy; the input is not changed. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.rangeInt(0, i + 1);
      [result[i], result[j]] = [result[j] as T, result[i] as T];
    }
    return result;
  }
}
