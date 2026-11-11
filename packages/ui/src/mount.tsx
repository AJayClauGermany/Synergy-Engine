import type { Engine } from '@synergy/engine';
import { createContext, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

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

// The overlay itself ignores the pointer so the game underneath stays clickable.
// Controls opt back in; add `data-interactive` to any panel that should block clicks.
const STYLE = `
.synergy-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.synergy-ui :is(button, a, input, select, textarea, label, summary, [data-interactive]) { pointer-events: auto; }
`;

/**
 * Renders a React tree on top of the game canvas.
 *
 *   mountUI(<Hud />, { engine });
 *
 * Because clicks on controls never reach the canvas, `Input.getMouseButtonDown` stays
 * false while the player is using the HUD. That replaces Unity's
 * `EventSystem.current.IsPointerOverGameObject()` check.
 */
export function mountUI(element: ReactNode, options: MountOptions): MountedUI {
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

  const root = document.createElement('div');
  root.className = 'synergy-ui';
  container.append(root);

  const reactRoot = createRoot(root);
  reactRoot.render(<EngineContext.Provider value={engine}>{element}</EngineContext.Provider>);

  return {
    root,
    unmount() {
      reactRoot.unmount();
      root.remove();
    },
  };
}
