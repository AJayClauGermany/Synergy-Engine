import * as pc from 'playcanvas';
import { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { Application, LogType } from './Application';
import { EngineObject } from './EngineObject';
import type { Engine } from './Engine';
import { toPlayCanvasVec3 } from './handedness';
import { describeHierarchy, type HierarchyOptions } from './hierarchy';
import { currentEngineOrNull } from './runtime';

/** A `Debug.drawLine` with a duration, kept until `until` (unscaled seconds). */
interface TimedLine {
  start: pc.Vec3;
  end: pc.Vec3;
  color: pc.Color;
  depthTest: boolean;
  until: number;
}

/** The timed lines of one engine, redrawn before every render until they expire. */
function timedLines(engine: Engine): TimedLine[] {
  let lines = engine.cache.get('debug:lines') as TimedLine[] | undefined;
  if (!lines) {
    const list: TimedLine[] = [];
    lines = list;
    engine.cache.set('debug:lines', list);
    engine.app.on('prerender', () => {
      const now = engine.time.unscaledTime;
      let kept = 0;
      for (const line of list) {
        if (line.until < now) continue;
        engine.app.drawLine(line.start, line.end, line.color, line.depthTest);
        list[kept++] = line;
      }
      list.length = kept;
    });
  }
  return lines;
}

/** One argument of a log call as text, for `Application.logMessageReceived`. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof EngineObject) return value.toString();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const own = (value as { toString?: () => string }).toString;
    if (typeof own === 'function' && own !== Object.prototype.toString) return own.call(value);
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/** Below the line that called `Debug`: where the message came from. */
function stackHere(skip: number): string {
  return (new Error().stack ?? '')
    .split('\n')
    .slice(skip + 1)
    .map((line) => line.trim())
    .join('\n');
}

/** @internal Tells `Application.logMessageReceived`. A listener that throws must not break the caller. */
export function announceLog(type: LogType, message: readonly unknown[], stackTrace = ''): void {
  if (Application.logMessageReceived.listenerCount === 0) return;
  try {
    Application.logMessageReceived.invoke(message.map(describe).join(' '), stackTrace, type);
  } catch (error) {
    console.error('Exception in an Application.logMessageReceived listener:', error);
  }
}

/**
 * Unity's `Debug`: logging plus one-frame debug lines drawn in the world.
 *
 * Unity's `context` argument works as a last argument: `Debug.log('Out of range', this.gameObject)`
 * names the object in the message, and the editor's Console selects it when the line is clicked.
 */
export class Debug {
  /**
   * True in a development build (`bun run dev`, tests) and false in a release build
   * (`bun run build`), which replaces it with a constant so that code behind
   * `if (Debug.isDebugBuild)` is left out of what ships.
   */
  static get isDebugBuild(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  static log(...message: unknown[]): void {
    console.log(...message);
    announceLog(LogType.Log, message);
  }

  static logWarning(...message: unknown[]): void {
    console.warn(...message);
    announceLog(LogType.Warning, message);
  }

  static logError(...message: unknown[]): void {
    console.error(...message);
    announceLog(LogType.Error, message, stackHere(2));
  }

  /** Logs an exception with its stack, as Unity's `Debug.LogException(exception, context)`. */
  static logException(exception: unknown, context?: EngineObject): void {
    const message = context ? [exception, context] : [exception];
    console.error(...message);
    const stack = exception instanceof Error ? (exception.stack ?? '').split('\n').slice(1).join('\n').trim() : '';
    announceLog(LogType.Exception, message, stack);
  }

  /** Logs an error (it does not throw) when `condition` is false. */
  static assert(condition: unknown, ...message: unknown[]): void {
    if (condition) return;
    console.error('Assertion failed:', ...message);
    announceLog(LogType.Assert, ['Assertion failed:', ...message], stackHere(2));
  }

  /**
   * Pauses the game at the end of this frame when the editor is open, so the Hierarchy and
   * Inspector show the moment something went wrong; press Play or Step to go on. Like
   * Unity's, it does nothing in a release build or with no editor attached.
   */
  static break(): void {
    currentEngineOrNull()?.editor?.pause();
  }

  /**
   * What is in the scene right now, as text: Unity's Hierarchy window with the
   * Inspector's values beside it. Every GameObject with its components, tag, position,
   * and the public fields of its scripts.
   *
   *   console.log(Debug.hierarchy());
   *
   *   Scene "Skirmish" (active)
   *     Camera Rig <CameraRig> at (0, 0, 0.8)
   *       | CameraRig: distance=15, camera=Main Camera (Transform)
   *       Main Camera <Camera> tag=MainCamera at (0, 12.3, -9.4) rot (55, 0, 0)
   *
   * Use it in a test to see why something is not where you expect, or from the browser
   * with `bun run screenshot --hierarchy`. Positions are world positions; they, rotation
   * and scale are left out when they are the defaults. `root` narrows it to one object.
   */
  static hierarchy(options: HierarchyOptions = {}): string {
    return describeHierarchy(options);
  }

  /**
   * Draws a line in the world, for this frame or for `duration` seconds (real time).
   * Same arguments as Unity's `Debug.DrawLine(start, end, color, duration, depthTest)`.
   * As in Unity it is a development aid: it draws in development builds only (not in
   * what `bun run build` ships) and does nothing in a headless engine. For lines that
   * show a script's thinking only while selected, prefer `Gizmos` in
   * `onDrawGizmosSelected()`.
   */
  static drawLine(start: Vector3, end: Vector3, color: Color = Color.white, duration = 0, depthTest = true): void {
    const engine = currentEngineOrNull();
    if (!engine || engine.isHeadless || !Debug.isDebugBuild) return;
    const line: TimedLine = {
      start: toPlayCanvasVec3(start),
      end: toPlayCanvasVec3(end),
      color: new pc.Color(color.r, color.g, color.b, color.a),
      depthTest,
      until: engine.time.unscaledTime + Math.max(0, duration),
    };
    if (duration > 0) timedLines(engine).push(line);
    else engine.app.drawLine(line.start, line.end, line.color, depthTest);
  }

  /**
   * Draws a line from `start` to `start + dir`. Same as Unity's
   * `Debug.DrawRay(start, dir, color, duration, depthTest)`; see `drawLine`.
   */
  static drawRay(start: Vector3, dir: Vector3, color: Color = Color.white, duration = 0, depthTest = true): void {
    Debug.drawLine(start, start.add(dir), color, duration, depthTest);
  }
}
