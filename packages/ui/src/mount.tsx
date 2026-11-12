import type { Engine } from '@synergy/engine';
import { type ComponentChildren, createContext, render } from 'preact';

export const EngineContext = createContext<Engine | null>(null);

export interface MountOptions {
  /** The engine whose canvas the UI is drawn over. */
  engine: Engine;
  /** Where to put the overlay. Defaults to the canvas's parent element. */
  container?: HTMLElement;
}

export interface MountedUI {
  /** The overlay element. */
  readonly root: HTMLElement;
  unmount(): void;
}

const STYLE_ID = 'synergy-ui-style';
/** The overlay on each container, so a second `mountUI` replaces the first instead of stacking on it. */
const mounted = new WeakMap<HTMLElement, MountedUI>();

// The overlay itself ignores the pointer so the game underneath stays clickable.
// Controls opt back in; add `data-interactive` to any panel that should block clicks.
const STYLE = `
.synergy-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.synergy-ui :is(button, a, input, select, textarea, label, summary, [data-interactive]) { pointer-events: auto; }
`;

/**
 * Renders a Preact tree on top of the game canvas. There is one overlay per container:
 * mounting again replaces what was there.
 *
 *   mountUI(<Hud />, { engine });
 *
 * Because clicks on controls never reach the canvas, `Input.getMouseButtonDown` stays
 * false while the player is using the HUD. That replaces Unity's
 * `EventSystem.current.IsPointerOverGameObject()` check.
 */
export function mountUI(element: ComponentChildren, options: MountOptions): MountedUI {
  const { engine } = options;
  const container = options.container ?? engine.canvas.parentElement;
  if (!container) throw new Error('mountUI: the canvas has no parent element to hold the UI overlay.');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.append(style);
  }

  // A scene that mounts its own HUD is loaded more than once (a restart, a rematch). Without
  // this each load would add another copy on top of the last, every one of them live.
  mounted.get(container)?.unmount();

  const root = document.createElement('div');
  root.className = 'synergy-ui';
  container.append(root);

  render(<EngineContext.Provider value={engine}>{element}</EngineContext.Provider>, root);

  const ui: MountedUI = {
    root,
    unmount() {
      render(null, root);
      root.remove();
      if (mounted.get(container) === ui) mounted.delete(container);
    },
  };
  mounted.set(container, ui);
  return ui;
}
