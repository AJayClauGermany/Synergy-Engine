/**
 * Testing multiplayer on one machine, as Unity's Multiplayer Play Mode does: several
 * windows of the game, each a player, connected without the internet through a
 * `BroadcastChannelTransport`. The page reads these from its address:
 *
 *   ?net=local       rooms connect windows of this browser instead of going through PeerJS
 *   ?host=CODE       host a room with this code as soon as the game is up
 *   ?join=CODE       join that room as soon as the game is up
 *   ?player=N        which test player this window is (2, 3, ...): its id in the session
 *                    and its own Convex player id, so windows do not share a seat
 *
 * In a development build the HUD has a "Test in windows" button that hosts a local room
 * and opens a second player's window; "+ Window" opens more. `bun run screenshot
 * --players 2` does the same headlessly and saves one screenshot per player.
 */

export interface LaunchOptions {
  /** 'local': rooms are BroadcastChannel rooms between windows of this browser. */
  net: 'local' | 'online';
  host: string | null;
  join: string | null;
  /** The test player number from `?player=N`, or null for an ordinary window. */
  player: number | null;
}

export function parseLaunchOptions(search: string): LaunchOptions {
  const params = new URLSearchParams(search);
  const code = (name: string) => {
    const value = params.get(name)?.trim().toUpperCase();
    return value ? value : null;
  };
  const player = Number(params.get('player'));
  return {
    net: params.get('net') === 'local' ? 'local' : 'online',
    host: code('host'),
    join: code('join'),
    player: Number.isInteger(player) && player > 0 ? player : null,
  };
}

/** How this window was opened. */
export const launch: LaunchOptions = parseLaunchOptions(globalThis.location?.search ?? '');

/** This window's id in a local room: `player-2` for `?player=2`; null lets the transport make one up. */
export function localPlayerId(): string | null {
  return launch.player === null ? null : `player-${launch.player}`;
}

let nextPlayer = (launch.player ?? 1) + 1;

/**
 * Opens another player's window, joined to `code`. It must run from a click: browsers
 * block windows opened any other way. The window gets the same scene and network kind
 * as this one (`local` makes it a BroadcastChannel room).
 */
export function openPlayerWindow(code: string, local: boolean): void {
  const player = nextPlayer++;
  const url = new URL(location.href);
  for (const name of ['host', 'join', 'player', 'net']) url.searchParams.delete(name);
  if (local) url.searchParams.set('net', 'local');
  url.searchParams.set('join', code);
  url.searchParams.set('player', String(player));
  // A separate window, not a tab: browsers pause the game loop of a hidden tab.
  const width = Math.round(window.outerWidth / 2);
  const height = Math.round(window.outerHeight / 2);
  const left = (player - 1) % 2 === 0 ? 0 : width;
  const top = player > 2 ? height : 0;
  window.open(url.href, `player-${player}`, `popup,width=${width},height=${height},left=${left},top=${top}`);
}

/**
 * Where this window's connection stands, on the page's root element as `data-net`, so
 * tools can wait for it (`bun run screenshot --players`): 'offline', 'connecting',
 * 'hosting', 'joined' or 'error'.
 */
export function reportNetwork(state: 'offline' | 'connecting' | 'hosting' | 'joined' | 'error'): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.net = state;
}
