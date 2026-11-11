import { CommandSession } from '@synergy/net';
import { GameController } from './behaviours/GameController';
import { convexUrl } from './env';
import { network } from './hud';
import type { Command } from './rules/skirmish';

/**
 * Starting and joining online games. Two ways to play are wired up:
 *
 *  - Peer-to-peer (WebRTC via PeerJS): works with no backend at all. Fast, but the match
 *    lives only as long as the host keeps the page open.
 *  - Convex: the match is stored and ordered by the database, so it survives reloads and
 *    players can take turns hours apart. Needs `PUBLIC_CONVEX_URL` (see README).
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

export function hostPeerGame(): Promise<void> {
  return connect(async () => {
    const { PeerJsTransport } = await import('@synergy/net/peerjs');
    const transport = await PeerJsTransport.host({ prefix: PEER_PREFIX });
    const game = controller();
    const session = CommandSession.host<Command>(transport, { validate: game.validate, maxPlayers: 8 });
    game.useSession(session, 'p2p', transport.roomCode);
  });
}

export function joinPeerGame(code: string): Promise<void> {
  return connect(async () => {
    const { PeerJsTransport } = await import('@synergy/net/peerjs');
    const transport = await PeerJsTransport.join(code, { prefix: PEER_PREFIX });
    controller().useSession(CommandSession.join<Command>(transport, transport.hostId), 'p2p', transport.roomCode);
  });
}

let sharedLobby: Promise<import('@synergy/net/convex').ConvexLobby> | null = null;

/** One Convex connection for the whole page, created the first time it is needed. */
function lobby() {
  const url = convexUrl;
  if (!url) return Promise.reject(new Error('No Convex backend is configured (PUBLIC_CONVEX_URL is not set).'));
  sharedLobby ??= import('@synergy/net/convex').then(({ ConvexLobby }) => new ConvexLobby(url));
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
