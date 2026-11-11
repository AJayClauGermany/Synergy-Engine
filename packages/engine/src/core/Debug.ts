import * as pc from 'playcanvas';
import { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { currentEngineOrNull } from './runtime';

const start = new pc.Vec3();
const end = new pc.Vec3();
const pcColor = new pc.Color();

/** Unity's `Debug`: logging plus one-frame debug lines drawn in the world. */
export class Debug {
  static log(...message: unknown[]): void {
    console.log(...message);
  }

  static logWarning(...message: unknown[]): void {
    console.warn(...message);
  }

  static logError(...message: unknown[]): void {
    console.error(...message);
  }

  /** Logs an error (it does not throw) when `condition` is false. */
  static assert(condition: unknown, ...message: unknown[]): void {
    if (!condition) console.error('Assertion failed:', ...message);
  }

  /** Draws a line for the current frame. Call it every frame to keep it visible. */
  static drawLine(from: Vector3, to: Vector3, color: Color = Color.white, depthTest = true): void {
    const engine = currentEngineOrNull();
    if (!engine || engine.isHeadless) return;
    start.set(from.x, from.y, from.z);
    end.set(to.x, to.y, to.z);
    pcColor.set(color.r, color.g, color.b, color.a);
    engine.app.drawLine(start, end, pcColor, depthTest);
  }

  /** Draws a line from `origin` to `origin + direction` for the current frame. */
  static drawRay(origin: Vector3, direction: Vector3, color: Color = Color.white, depthTest = true): void {
    Debug.drawLine(origin, origin.add(direction), color, depthTest);
  }
}
