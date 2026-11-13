import * as pc from 'playcanvas';
import { Color } from '../math/Color';
import { Vector3 } from '../math/Vector3';
import type { GameObject } from './GameObject';
import { MonoBehaviour } from './MonoBehaviour';
import { currentEngine } from './runtime';

const SPHERE_SEGMENTS = 24;
const points: pc.Vec3[] = [];
const colors: pc.Color[] = [];

function point(v: Vector3): pc.Vec3 {
  return new pc.Vec3(v.x, v.y, v.z);
}

/**
 * Unity's `Gizmos`: lines drawn over the game for one frame, from a script's
 * `onDrawGizmos()` or `onDrawGizmosSelected()`, to see what a script is thinking (a
 * range, a path, a target). They are drawn on top of everything, and only while the
 * editor (`@synergy/devtools`) is open with Gizmos on, so release builds never show them.
 *
 *   protected onDrawGizmosSelected() {
 *     Gizmos.color = Color.yellow;
 *     Gizmos.drawWireSphere(this.transform.position, this.range);
 *   }
 *
 * Solid shapes are not drawn: `drawCube` and `drawSphere` draw the wire outline.
 */
export class Gizmos {
  /** The colour of what is drawn next. Reset to white before each script's message. */
  static color: Color = Color.white;

  static drawLine(from: Vector3, to: Vector3): void {
    points.push(point(from), point(to));
    const { r, g, b, a } = Gizmos.color;
    const color = new pc.Color(r, g, b, a);
    colors.push(color, color);
  }

  static drawRay(from: Vector3, direction: Vector3): void {
    Gizmos.drawLine(from, from.add(direction));
  }

  /** The edges of an axis-aligned box. */
  static drawWireCube(center: Vector3, size: Vector3): void {
    const h = size.mul(0.5);
    const corner = (x: number, y: number, z: number) => center.add(new Vector3(x * h.x, y * h.y, z * h.z));
    for (const [a, b] of [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ] as const) {
      Gizmos.drawLine(corner(a, -1, b), corner(a, 1, b)); // up
      Gizmos.drawLine(corner(-1, a, b), corner(1, a, b)); // across
      Gizmos.drawLine(corner(a, b, -1), corner(a, b, 1)); // along
    }
  }

  /** Drawn as `drawWireCube`: there are no solid gizmos. */
  static drawCube(center: Vector3, size: Vector3): void {
    Gizmos.drawWireCube(center, size);
  }

  /** Three circles, one around each axis. */
  static drawWireSphere(center: Vector3, radius: number): void {
    for (let i = 0; i < SPHERE_SEGMENTS; i++) {
      const a = (i / SPHERE_SEGMENTS) * Math.PI * 2;
      const b = ((i + 1) / SPHERE_SEGMENTS) * Math.PI * 2;
      const [ca, sa, cb, sb] = [Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(b) * radius, Math.sin(b) * radius];
      Gizmos.drawLine(center.add(new Vector3(ca, sa, 0)), center.add(new Vector3(cb, sb, 0)));
      Gizmos.drawLine(center.add(new Vector3(ca, 0, sa)), center.add(new Vector3(cb, 0, sb)));
      Gizmos.drawLine(center.add(new Vector3(0, ca, sa)), center.add(new Vector3(0, cb, sb)));
    }
  }

  /** Drawn as `drawWireSphere`: there are no solid gizmos. */
  static drawSphere(center: Vector3, radius: number): void {
    Gizmos.drawWireSphere(center, radius);
  }

  /**
   * @internal Sends `onDrawGizmos` to every active script that has it, and
   * `onDrawGizmosSelected` to those on `selected` and below it, then draws what they
   * asked for. The editor calls this once a frame; nothing else does. Returns how many
   * lines were drawn.
   */
  static _drawAll(selected: GameObject | null): number {
    const engine = currentEngine();
    for (const scene of engine.scenes.allScenes()) {
      for (const root of scene.getRootGameObjects()) visit(root, false);
    }
    function visit(gameObject: GameObject, underSelection: boolean): void {
      if (!gameObject.activeInHierarchy) return;
      const isSelected = underSelection || gameObject === selected;
      for (const component of gameObject.getComponents(MonoBehaviour)) {
        if (!component.enabled) continue;
        for (const message of ['onDrawGizmos', 'onDrawGizmosSelected'] as const) {
          if (message === 'onDrawGizmosSelected' && !isSelected) continue;
          if (!component._has(message)) continue;
          Gizmos.color = Color.white;
          component._send(message);
        }
      }
      const { transform } = gameObject;
      for (let i = 0; i < transform.childCount; i++) visit(transform.getChild(i).gameObject, isSelected);
    }
    Gizmos.color = Color.white;
    const lines = points.length / 2;
    // Always on top, so a range on the ground is not hidden by the tiles it covers.
    if (!engine.isHeadless && lines > 0) engine.app.drawLines(points, colors, false);
    points.length = 0;
    colors.length = 0;
    return lines;
  }
}
