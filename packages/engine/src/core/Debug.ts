import * as pc from 'playcanvas';
import { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { describeHierarchy, type HierarchyOptions } from './hierarchy';
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
   *       Main Camera <Camera> tag=MainCamera at (0, 10.6, 11.4) rot (-45, 0, 0)
   *
   * Use it in a test to see why something is not where you expect, or from the browser
   * with `bun run screenshot --hierarchy`. Positions are world positions; they, rotation
   * and scale are left out when they are the defaults. `root` narrows it to one object.
   */
  static hierarchy(options: HierarchyOptions = {}): string {
    return describeHierarchy(options);
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
