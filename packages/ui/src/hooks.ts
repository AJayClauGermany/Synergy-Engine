import type { Engine, Observable, UnityEvent } from '@synergy/engine';
import { useContext, useEffect, useLayoutEffect, useReducer, useRef } from 'preact/hooks';
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
  // Preact's core hooks have no `useSyncExternalStore` (only `preact/compat` does), so
  // this is the same contract written out: read the current value while rendering, and
  // re-render whenever it changes.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const value = observable.getSnapshot();
  const rendered = useRef(value);
  rendered.current = value;
  useLayoutEffect(() => {
    const unsubscribe = observable.subscribe(() => rerender(undefined));
    // The value may have changed between this render and subscribing.
    if (!Object.is(observable.getSnapshot(), rendered.current)) rerender(undefined);
    return unsubscribe;
  }, [observable]);
  return value;
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
 * (as `WorldAnchor` does). Do not set component state here every frame.
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
