import type { Engine, Observable, UnityEvent } from '@synergy/engine';
import { useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { EngineContext } from './mount';

/** The engine this UI was mounted on. */
export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine must be used inside a tree rendered by mountUI().');
  return engine;
}

/**
 * Reads an `Observable` and re-renders when it changes. This is how game state reaches
 * the HUD:
 *
 *   const gold = useObservable(economy.gold);
 */
export function useObservable<T>(observable: Observable<T>): T {
  return useSyncExternalStore(observable.subscribe, observable.getSnapshot, observable.getSnapshot);
}

/** Calls `listener` whenever a `UnityEvent` fires, for as long as the component is mounted. */
export function useUnityEvent<Args extends unknown[]>(
  event: UnityEvent<Args>,
  listener: (...args: Args) => void,
): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => event.addListener((...args) => latest.current(...args)), [event]);
}

/**
 * Runs `callback` after every rendered frame. Use it to move DOM elements imperatively
 * (as `WorldAnchor` does). Do not set React state here every frame.
 */
export function useFrame(callback: () => void): void {
  const engine = useEngine();
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const handler = () => latest.current();
    engine.app.on('frameend', handler);
    return () => {
      engine.app.off('frameend', handler);
    };
  }, [engine]);
}
