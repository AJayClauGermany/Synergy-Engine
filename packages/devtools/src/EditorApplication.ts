import { Engine, UnityEvent } from '@synergy/engine';

/** Unity's `PauseState`, passed to `EditorApplication.pauseStateChanged`. */
export enum PauseState {
  Paused = 0,
  Unpaused = 1,
}

function engine(): Engine {
  const current = Engine.current;
  if (!current) throw new Error('EditorApplication needs a running engine. Create one with Engine.create() first.');
  return current;
}

/** A headless engine has no frame loop to stop, so its pause is only remembered. */
const headlessPaused = new WeakSet<Engine>();

/**
 * Unity's `EditorApplication`: the Play, Pause and Step buttons, for code. The game is
 * always "playing" here (there is no edit mode); pausing stops the frame loop, so nothing
 * updates or draws until it is unpaused or stepped.
 *
 *   EditorApplication.isPaused = true;
 *   EditorApplication.step();          // one frame, then paused again
 *
 * Part of `@synergy/devtools`, which only development builds load. Game code that must also
 * build for release uses `Debug.break()` instead, which does nothing there.
 */
export class EditorApplication {
  /** Fires when the game is paused or unpaused, by the toolbar, a shortcut or code. */
  static readonly pauseStateChanged = new UnityEvent<[state: PauseState]>();

  /** Always true: the game runs from the moment the page loads. */
  static get isPlaying(): boolean {
    return true;
  }

  static get isPaused(): boolean {
    const current = engine();
    return current.isHeadless ? headlessPaused.has(current) : !current.isRunning;
  }

  static set isPaused(value: boolean) {
    const current = engine();
    if (EditorApplication.isPaused === value) return;
    if (current.isHeadless) {
      if (value) headlessPaused.add(current);
      else headlessPaused.delete(current);
    } else if (value) {
      current.stop();
    } else {
      current.start();
    }
    EditorApplication.pauseStateChanged.invoke(value ? PauseState.Paused : PauseState.Unpaused);
  }

  /** Pauses (if needed) and advances exactly one frame, as Unity's Step button. */
  static step(): void {
    EditorApplication.isPaused = true;
    engine().step(1 / 60);
  }
}
