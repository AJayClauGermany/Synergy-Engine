import { Camera, type GameObject, isAlive, Screen, Vector3 } from '@synergy/engine';
import type { ComponentChildren, CSSProperties } from 'preact';
import { useRef } from 'preact/hooks';
import { useFrame } from './hooks';

export interface WorldAnchorProps {
  /** What to follow: a GameObject, or a fixed world position. */
  target: GameObject | Vector3;
  /** World-space offset from the target, e.g. `new Vector3(0, 2, 0)` to sit above a unit's head. */
  offset?: Vector3;
  /** Defaults to `Camera.main`. */
  camera?: Camera;
  className?: string;
  style?: CSSProperties;
  children?: ComponentChildren;
}

/**
 * Pins HTML to a point in the 3D world: health bars, name tags, damage numbers.
 * (Unity: a World Space canvas, or `Camera.WorldToScreenPoint` + a UI element.)
 *
 *   <WorldAnchor target={unit.gameObject} offset={new Vector3(0, 2, 0)}>
 *     <HealthBar value={hp} />
 *   </WorldAnchor>
 *
 * The content is centred horizontally on the point and sits just above it. It is hidden
 * while the point is behind the camera or the target is destroyed or inactive.
 */
export function WorldAnchor({ target, offset, camera, className, style, children }: WorldAnchorProps) {
  const element = useRef<HTMLDivElement>(null);

  useFrame(() => {
    const node = element.current;
    if (!node) return;
    const view = camera ?? Camera.main;
    let world: Vector3 | null = null;
    if (target instanceof Vector3) world = target;
    else if (isAlive(target) && target.activeInHierarchy) world = target.transform.position;

    if (!view || !world) {
      node.style.visibility = 'hidden';
      return;
    }
    const screen = view.worldToScreenPoint(offset ? world.add(offset) : world);
    if (screen.z <= 0) {
      node.style.visibility = 'hidden';
      return;
    }
    node.style.visibility = 'visible';
    // Screen space has its origin at the bottom-left (as in Unity); CSS measures from the top.
    const top = Screen.height - screen.y;
    node.style.transform = `translate(${screen.x.toFixed(1)}px, ${top.toFixed(1)}px) translate(-50%, -100%)`;
  });

  return (
    <div
      ref={element}
      className={className}
      style={Object.assign(
        { position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' },
        style,
      )}
    >
      {children}
    </div>
  );
}
