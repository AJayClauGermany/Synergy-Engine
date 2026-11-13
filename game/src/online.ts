import { BroadcastChannelTransport, CommandSession, makeRoomCode } from '@synergy/net';
import { GameController } from './behaviours/GameController';
import { convexUrl } from './env';
import { network } from './hud';
import { launch, localPlayerId, openPlayerWindow } from './localPlay';
import type { Command } from './rules/skirmish';

/**
 * Starting and joining online games. Two ways to play are wired up:
 *
 *  - Peer-to-peer (WebRTC via PeerJS): works with no backend at all. Fast, but the match
 *    lives only as long as the host keeps the page open.
 *  - Convex: the match is stored and ordered by the database, so it survives reloads and
 *    players can take turns hours apart. Needs `PUBLIC_CONVEX_URL` (see README).
 *
 * For testing, a peer-to-peer room can instead connect windows of this browser
 * (`local`, see `localPlay.ts`): the same session code, no internet.
 *
 * The integrations are imported on demand, so a single-player session never downloads them.
 */

/** Namespaces this game's room codes on PeerJS's shared signalling server. Change it for your game. */
const PEER_PREFIX = 'synergy-skirmish';

export { convexUrl };

function controller(): GameController {
  const instance = GameController.instance;
  if (!instance) throw new Error('The game scene is not loaded yet.');
  return instance;
}

async function connect(run: () => Promise<void>): Promise<void> {
  network.update((value) => ({ ...value, mode: 'connecting', error: null }));
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    network.value = { mode: 'local', roomCode: null, players: 1, isHost: true, error: message };
  }
}

export interface PeerGameOptions {
  /** Connect windows of this browser instead of going through PeerJS. Defaults to `?net=local`. */
  local?: boolean;
  /** Host with this code rather than a made-up one. */
  roomCode?: string;
}

export function hostPeerGame(options: PeerGameOptions = {}): Promise<void> {
  const local = options.local ?? launch.net === 'local';
  return connect(async () => {
    const transport = local
      ? await BroadcastChannelTransport.host({ prefix: PEER_PREFIX, roomCode: options.roomCode })
      : await (
          await import('@synergy/net/peerjs')
        ).PeerJsTransport.host({ prefix: PEER_PREFIX, roomCode: options.roomCode });
    const game = controller();
    const session = CommandSession.host<Command>(transport, { validate: game.validate, maxPlayers: 8 });
    game.useSession(session, local ? 'windows' : 'p2p', transport.roomCode);
  });
}

export function joinPeerGame(code: string, options: Pick<PeerGameOptions, 'local'> = {}): Promise<void> {
  const local = options.local ?? launch.net === 'local';
  return connect(async () => {
    const transport = local
      ? await BroadcastChannelTransport.join(code, { prefix: PEER_PREFIX, id: localPlayerId() ?? undefined })
      : await (await import('@synergy/net/peerjs')).PeerJsTransport.join(code, { prefix: PEER_PREFIX });
    const session = CommandSession.join<Command>(transport, transport.hostId);
    controller().useSession(session, local ? 'windows' : 'p2p', transport.roomCode);
  });
}

/**
 * Development: hosts a room between windows of this browser and opens a second player's
 * window joined to it. Call it from a click (browsers block windows opened otherwise).
 */
export function testInWindows(): Promise<void> {
  // Open the window now, while the click still counts; it waits for the room to exist.
  const roomCode = makeRoomCode();
  openPlayerWindow(roomCode, true);
  return hostPeerGame({ local: true, roomCode });
}

/** Development: one more player's window, joined to the room this window hosts. */
export function addPlayerWindow(): void {
  const { roomCode, mode } = network.value;
  if (roomCode && (mode === 'windows' || mode === 'p2p')) openPlayerWindow(roomCode, mode === 'windows');
}

let sharedLobby: Promise<import('@synergy/net/convex').ConvexLobby> | null = null;

/** One Convex connection for the whole page, created the first time it is needed. */
function lobby() {
  const url = convexUrl;
  if (!url) return Promise.reject(new Error('No Convex backend is configured (PUBLIC_CONVEX_URL is not set).'));
  // Test windows (`?player=N`) each get their own remembered player id.
  sharedLobby ??= import('@synergy/net/convex').then(
    ({ ConvexLobby, persistentPlayerId }) =>
      new ConvexLobby(url, { playerId: persistentPlayerId(launch.player ? String(launch.player) : undefined) }),
  );
  return sharedLobby;
}

export function hostConvexGame(): Promise<void> {
  return connect(async () => {
    const rooms = await lobby();
    const room = await rooms.createRoom({ name: 'Skirmish', maxPlayers: 8 });
    controller().useSession(rooms.openSession<Command>(room.code), 'convex', room.code);
  });
}

export function joinConvexGame(code: string): Promise<void> {
  return connect(async () => {
    const rooms = await lobby();
    const room = await rooms.joinRoom(code);
    controller().useSession(rooms.openSession<Command>(room.code), 'convex', room.code);
  });
}

/** Back to a local game. */
export function leaveOnlineGame(): void {
  controller().useSession(CommandSession.local<Command>(), 'local');
}
