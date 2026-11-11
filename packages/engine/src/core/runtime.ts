import type { Engine } from './Engine';

/**
 * Holds the engine the static APIs (`Time`, `Input`, `SceneManager`, ...) talk to.
 * Kept in its own tiny module so those APIs do not import `Engine` at load time.
 */
let current: Engine | null = null;

export function setCurrentEngine(engine: Engine | null): void {
  current = engine;
}

export function currentEngineOrNull(): Engine | null {
  return current;
}

export function currentEngine(): Engine {
  if (!current) {
    throw new Error(
      'No Synergy engine is running. Call `await Engine.create({ canvas })` (or ' +
        '`Engine.createHeadless()` in tests) before using GameObject, Time, Input or SceneManager.',
    );
  }
  return current;
}
