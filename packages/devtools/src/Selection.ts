import { type GameObject, isAlive, type Transform, UnityEvent } from '@synergy/engine';

let active: GameObject | null = null;

/**
 * Unity's `Selection`: what is selected in the Hierarchy and shown in the Inspector.
 * Setting it from code selects in the editor too, which is handy from the browser console:
 *
 *   Selection.activeGameObject = GameObject.find('Board');
 */
export class Selection {
  /** Fires after the selection changes. */
  static readonly selectionChanged = new UnityEvent<[]>();

  /** The selected GameObject, or `null`. A destroyed object reads as `null`. */
  static get activeGameObject(): GameObject | null {
    if (active && !isAlive(active)) active = null;
    return active;
  }

  static set activeGameObject(value: GameObject | null) {
    const next = value && isAlive(value) ? value : null;
    if (next === Selection.activeGameObject) return;
    active = next;
    Selection.selectionChanged.invoke();
  }

  /** The selected GameObject's Transform, or `null`. */
  static get activeTransform(): Transform | null {
    return Selection.activeGameObject?.transform ?? null;
  }
}
