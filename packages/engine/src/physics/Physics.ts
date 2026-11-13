import { Camera } from '../components/Camera';
import type { Engine } from '../core/Engine';
import { isAlive } from '../core/EngineObject';
import type { GameObject } from '../core/GameObject';
import { MonoBehaviour, type MessageName } from '../core/MonoBehaviour';
import { currentEngine } from '../core/runtime';
import { Ray } from '../math/geometry';
import { Vector3 } from '../math/Vector3';
import type { Collider, RaycastHit } from './Collider';

const layerNames: (string | undefined)[] = [];
layerNames[0] = 'Default';
layerNames[1] = 'TransparentFX';
layerNames[2] = 'Ignore Raycast';
layerNames[4] = 'Water';
layerNames[5] = 'UI';

/**
 * Names for the 32 layers and helpers to build bit masks from them. Unity keeps the
 * names in project settings; here you declare them once at startup:
 *
 *   LayerMask.define(8, 'Units');
 *   unit.layer = LayerMask.nameToLayer('Units');
 *   Physics.raycast(ray, 100, LayerMask.getMask('Units'));
 */
export class LayerMask {
  /** Names layer `index` (0-31). Layers 0, 1, 2, 4 and 5 have Unity's built-in names. */
  static define(index: number, name: string): void {
    if (!Number.isInteger(index) || index < 0 || index > 31) {
      throw new RangeError(`Layer index must be an integer from 0 to 31, got ${index}.`);
    }
    layerNames[index] = name;
  }

  /** The index of a named layer, or -1 if no layer has that name. */
  static nameToLayer(name: string): number {
    return layerNames.indexOf(name);
  }

  static layerToName(index: number): string {
    return layerNames[index] ?? '';
  }

  /** A bit mask containing every named layer given. */
  static getMask(...names: string[]): number {
    let mask = 0;
    for (const name of names) {
      const index = LayerMask.nameToLayer(name);
      if (index < 0) throw new Error(`Layer "${name}" is not defined. Use LayerMask.define(index, "${name}").`);
      mask |= 1 << index;
    }
    return mask;
  }
}

function toRay(
  rayOrOrigin: Ray | Vector3,
  second: Vector3 | number | undefined,
  third: number | undefined,
  fourth: number | undefined,
): { ray: Ray; maxDistance: number; layerMask: number } {
  if (rayOrOrigin instanceof Ray) {
    return {
      ray: rayOrOrigin,
      maxDistance: (second as number | undefined) ?? Number.POSITIVE_INFINITY,
      layerMask: third ?? Physics.defaultRaycastLayers,
    };
  }
  return {
    ray: new Ray(rayOrOrigin, second as Vector3),
    maxDistance: third ?? Number.POSITIVE_INFINITY,
    layerMask: fourth ?? Physics.defaultRaycastLayers,
  };
}

function matches(collider: Collider, layerMask: number): boolean {
  return (layerMask & (1 << collider.gameObject.layer)) !== 0;
}

/**
 * Spatial queries against Colliders. This is the picking half of Unity's `Physics`
 * (there is no rigidbody simulation).
 *
 * Where C# returns a bool and fills an `out RaycastHit`, these return the hit or `null`:
 *
 *   const hit = Physics.raycast(Camera.main.screenPointToRay(Input.mousePosition));
 *   if (hit) select(hit.gameObject);
 */
export class Physics {
  /** Every layer. */
  static readonly allLayers = ~0;
  /** Every layer except "Ignore Raycast" (layer 2). The default for queries. */
  static readonly defaultRaycastLayers = ~(1 << 2);

  /**
   * The closest collider hit by the ray, or `null` (Unity returns a bool and fills an
   * `out` hit). Same arguments and defaults as Unity: `maxDistance` Infinity, `layerMask`
   * every layer except "Ignore Raycast". As in Unity, colliders that contain the ray's
   * origin are not hit, and trigger colliders are (there is no QueryTriggerInteraction).
   */
  static raycast(ray: Ray, maxDistance?: number, layerMask?: number): RaycastHit | null;
  static raycast(origin: Vector3, direction: Vector3, maxDistance?: number, layerMask?: number): RaycastHit | null;
  static raycast(a: Ray | Vector3, b?: Vector3 | number, c?: number, d?: number): RaycastHit | null {
    const { ray, maxDistance, layerMask } = toRay(a, b, c, d);
    let closest: RaycastHit | null = null;
    for (const collider of currentEngine().colliders) {
      if (!matches(collider, layerMask)) continue;
      const hit = collider.raycast(ray, closest ? closest.distance : maxDistance);
      if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    return closest;
  }

  /** Every collider hit by the ray, nearest first (Unity's order is unspecified). Colliders containing the origin are skipped. */
  static raycastAll(ray: Ray, maxDistance?: number, layerMask?: number): RaycastHit[];
  static raycastAll(origin: Vector3, direction: Vector3, maxDistance?: number, layerMask?: number): RaycastHit[];
  static raycastAll(a: Ray | Vector3, b?: Vector3 | number, c?: number, d?: number): RaycastHit[] {
    const { ray, maxDistance, layerMask } = toRay(a, b, c, d);
    const hits: RaycastHit[] = [];
    for (const collider of currentEngine().colliders) {
      if (!matches(collider, layerMask)) continue;
      const hit = collider.raycast(ray, maxDistance);
      if (hit) hits.push(hit);
    }
    return hits.sort((x, y) => x.distance - y.distance);
  }

  /**
   * Colliders that touch or are inside a sphere: "everything within range". Tests each
   * collider's real shape (via `closestPoint`), as Unity does. Default mask: every layer,
   * as in Unity.
   */
  static overlapSphere(position: Vector3, radius: number, layerMask = Physics.allLayers): Collider[] {
    const found: Collider[] = [];
    for (const collider of currentEngine().colliders) {
      if (!matches(collider, layerMask)) continue;
      const closest = collider.closestPoint(position);
      if (Vector3.distance(closest, position) <= radius) found.push(collider);
    }
    return found;
  }

  /** True if any collider touches the sphere. Default mask: every layer except "Ignore Raycast", as in Unity. */
  static checkSphere(position: Vector3, radius: number, layerMask = Physics.defaultRaycastLayers): boolean {
    return Physics.overlapSphere(position, radius, layerMask).length > 0;
  }
}

// ---- onMouse* messages --------------------------------------------------------------------

interface MouseState {
  hovered: GameObject | null;
  pressed: GameObject | null;
}

function sendTo(gameObject: GameObject | null, message: MessageName): void {
  if (!isAlive(gameObject)) return;
  for (const behaviour of gameObject.getComponents(MonoBehaviour)) {
    if (behaviour._live) behaviour._send(message);
  }
}

/**
 * @internal Sends Unity's onMouseEnter/Over/Exit/Down/Up messages to scripts on the
 * GameObject under the pointer. Runs once per frame, before `update`.
 */
export function dispatchMouseMessages(engine: Engine): void {
  const input = engine.input;
  let state = engine.cache.get('mouse') as MouseState | undefined;
  if (!state) {
    state = { hovered: null, pressed: null };
    engine.cache.set('mouse', state);
  }
  const camera = input.mousePresent ? Camera.main : null;
  let hovered: GameObject | null = null;
  if (camera) {
    const hit = Physics.raycast(camera.screenPointToRay(input.mousePosition));
    // Objects without mouse handlers still block the ones behind them, as in Unity.
    if (hit) hovered = hit.gameObject;
  }
  if (hovered !== state.hovered) {
    sendTo(state.hovered, 'onMouseExit');
    state.hovered = hovered;
    sendTo(hovered, 'onMouseEnter');
  }
  sendTo(hovered, 'onMouseOver');
  if (input.getMouseButtonDown(0) && hovered) {
    state.pressed = hovered;
    sendTo(hovered, 'onMouseDown');
  }
  if (input.getMouseButtonUp(0) && state.pressed) {
    sendTo(state.pressed, 'onMouseUp');
    state.pressed = null;
  }
}
