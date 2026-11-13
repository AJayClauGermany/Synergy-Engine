import { UnityEvent } from './events';
import { currentEngineOrNull } from './runtime';

/** Unity's `LogType`: what kind of message `Application.logMessageReceived` reports. */
export enum LogType {
  Error = 0,
  Assert = 1,
  Warning = 2,
  Log = 3,
  Exception = 4,
}

/**
 * @internal What `@synergy/devtools` (the editor, development builds only) lends the
 * engine. Nothing is attached in a release build, so everything that asks for it is a
 * no-op there, as Unity's editor-only calls are in a player.
 */
export interface EditorHooks {
  /** `Debug.break()`: pause at the end of this frame. */
  pause(): void;
  /** `ScreenCapture.captureScreenshot(name)`: keep the PNG somewhere a person can find it. Resolves to where. */
  saveScreenshot(name: string, dataUrl: string): Promise<string | null>;
}

/**
 * Unity's `Application`, the parts that make sense in a browser.
 *
 *   Application.logMessageReceived.addListener((condition, stackTrace, type) => {
 *     if (type === LogType.Exception) showCrashDialog(condition);
 *   });
 */
export class Application {
  /**
   * Fires for every `Debug.log`, `logWarning`, `logError`, `logException` and failed
   * `assert`, and for each exception a script throws (as `LogType.Exception`). The stack
   * trace is filled in for errors, asserts and exceptions, and empty for the rest.
   *
   * Like Unity's, it is one event for the whole page, not one per engine: remove your
   * listener (`removeListener` with the same function) when you are done with it.
   */
  static readonly logMessageReceived = new UnityEvent<[condition: string, stackTrace: string, type: LogType]>();

  /**
   * True while the editor (`@synergy/devtools`) is attached, which only a development
   * build does. Use it to keep editor-only conveniences out of what players see.
   */
  static get isEditor(): boolean {
    return (currentEngineOrNull()?.editor ?? null) !== null;
  }
}
