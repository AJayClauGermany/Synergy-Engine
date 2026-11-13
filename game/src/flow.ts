import { isAlive, Observable, SceneManager } from '@synergy/engine';
import type { NetworkManager } from '@synergy/netcode';
import { frontierOnline } from './frontier/hud';
import { createFrontierManager, hostOnline, joinOnline, playOffline, stopPlaying } from './frontier/session';
import { network } from './hud';
import { reportNetwork } from './localPlay';
import { hostPeerGame, joinPeerGame } from './online';

/**
 * Which screen the game shows, and moving between them. Every screen is a scene plus the
 * HUD drawn over it; `App` (the one HUD root, mounted once at boot) reads `flow` and draws
 * the matching HUD, with a loading overlay while a scene loads.
 *
 *   Menu      the title screen: pick a game
 *   Skirmish  the turn-based sample (commands)
 *   Frontier  the real-time sample (netcode), loaded through the network manager
 *   Showcase  3D, sprites and canvas UI together
 *
 * Leaving a screen cleans up after it: leaving Frontier shuts the network manager down
 * first, which destroys every networked object here and tells the other players, then
 * the next scene replaces the old one. (Loading another scene alone would not be enough:
 * objects spawned without `spawn(true)` survive scene loads, as in Unity.)
 */
export type Screen = 'Menu' | 'Skirmish' | 'Frontier' | 'Showcase';

export interface FlowState {
  screen: Screen | null;
  /** The scene being loaded, while the overlay is up. */
  loading: Screen | null;
}

export const flow = new Observable<FlowState>({ screen: null, loading: null });

export const SCREENS: readonly Screen[] = ['Menu', 'Skirmish', 'Frontier', 'Showcase'];

export function isScreen(name: string): name is Screen {
  return (SCREENS as readonly string[]).includes(name);
}

/** What to do once a multiplayer screen is up (from `?host=` / `?join=`, see `localPlay.ts`). */
export interface OpenOptions {
  host?: string | null;
  join?: string | null;
}

let manager: NetworkManager | null = null;

/** Frontier's network manager: made the first time it is needed, then kept for the page's life. */
export function frontierManager(): NetworkManager {
  if (!manager || !isAlive(manager)) manager = createFrontierManager();
  return manager;
}

let opening = 0;

/** Shows `screen`: the overlay goes up, the previous screen is left, the scene loads. */
export async function openScreen(screen: Screen, options: OpenOptions = {}): Promise<void> {
  const mine = ++opening;
  flow.value = { screen: flow.value.screen, loading: screen };
  const previous = flow.value.screen;
  try {
    // Not a bare shutdown(): a joined match would take that for the host leaving and
    // start playing alone again, in the middle of this load.
    if (previous === 'Frontier' && screen !== 'Frontier' && manager) stopPlaying(manager);
    if (screen === 'Frontier') {
      // The network manager loads the scene, here and on every machine that joins.
      const frontier = frontierManager();
      if (options.host) await hostOnline(frontier, { roomCode: options.host });
      else if (options.join) await joinOnline(frontier, options.join);
      else await playOffline(frontier);
    } else {
      // Each screen's scene is registered under the screen's name (main.tsx).
      await SceneManager.loadScene(screen);
    }
  } catch (error) {
    // The scene did not load: keep the HUD of the screen that is still there.
    if (mine === opening) flow.value = { screen: previous, loading: null };
    throw error;
  }
  if (mine === opening) flow.value = { screen, loading: null };
  // The Skirmish HUD needs the scene's GameController, so connect after it is up.
  if (screen === 'Skirmish' && mine === opening) {
    if (options.host) await hostPeerGame({ roomCode: options.host });
    else if (options.join) await joinPeerGame(options.join);
  }
}

/** Back to the title screen, leaving any match cleanly. */
export function quitToMenu(): Promise<void> {
  return openScreen('Menu');
}

/**
 * Mirrors both samples' connection state onto the page (`data-net`), for tools that wait
 * for every test player to be connected (`bun run screenshot --players`).
 */
export function watchNetworkStatus(): void {
  network.subscribe((state) => {
    if (flow.value.screen !== 'Skirmish') return;
    if (state.error) reportNetwork('error');
    else if (state.mode === 'connecting') reportNetwork('connecting');
    else if (state.mode === 'local') reportNetwork('offline');
    else reportNetwork(state.isHost ? 'hosting' : 'joined');
  });
  frontierOnline.subscribe((state) => {
    if (state.error) reportNetwork('error');
    else if (state.mode === 'offline') reportNetwork('offline');
    else reportNetwork(state.mode);
  });
  reportNetwork('offline');
}
