import type { ConvexLobby, RoomInfo } from '@synergy/net/convex';
import type { PeerJsOptions } from '@synergy/net/peerjs';
import type { NetworkManager } from './NetworkManager';

// Convex finds the game; PeerJS carries it. The lobby (room list, join codes, player
// names) lives in Convex, so it survives reloads and can be browsed. The match itself runs
// host-and-clients over WebRTC, so it needs no game server and costs no Convex bandwidth.
//
//   1. the host opens a PeerJS room and starts hosting;
//   2. the host publishes it to the Convex lobby, with the PeerJS code in `peerCode`;
//   3. players browse or enter the lobby code, read `peerCode` and connect to the host.
//
// These helpers import PeerJS and Convex on demand, so a game that never goes online does
// not download them. They are not covered by automated tests (they need live services).

/** Rooms with no heartbeat for two minutes are closed by a Convex cron job, so keep beating. Returns the stop function. */
function keepAlive(lobby: ConvexLobby, code: string): () => void {
  const timer = setInterval(() => void lobby.heartbeat(code).catch(() => {}), 25_000);
  return () => clearInterval(timer);
}

export interface HostGameOptions extends PeerJsOptions {
  /**
   * Publish the game to this Convex lobby so others can browse or join it by lobby code.
   * Leave out to share the PeerJS code directly.
   */
  lobby?: { client: ConvexLobby; name: string; maxPlayers?: number };
}

export interface HostedGame {
  /** What to show players: the lobby code when there is a lobby, else the PeerJS code. */
  code: string;
  /** The PeerJS room code (the direct way in). */
  peerCode: string;
  /** The lobby entry, when published. */
  room: RoomInfo | null;
  /** Update the lobby entry: 'playing' hides it from the open list, 'closed' removes it. */
  setStatus(status: RoomInfo['status']): Promise<void>;
}

export interface JoinGameOptions extends PeerJsOptions {
  /** Look the game up in this Convex lobby. `code` is then the lobby code, not the PeerJS code. */
  lobby?: ConvexLobby;
}

/**
 * Starts hosting on a new PeerJS room and, if asked, publishes it to a Convex lobby. The
 * lobby entry is removed when the manager shuts down.
 */
export async function hostGame(manager: NetworkManager, options: HostGameOptions = {}): Promise<HostedGame> {
  const { PeerJsTransport } = await import('@synergy/net/peerjs');
  const { lobby, ...peerOptions } = options;
  const transport = await PeerJsTransport.host(peerOptions);
  manager.startHost(transport);

  let room: RoomInfo | null = null;
  if (lobby) {
    try {
      room = await lobby.client.createRoom({
        name: lobby.name,
        peerCode: transport.roomCode,
        maxPlayers: lobby.maxPlayers,
      });
    } catch (error) {
      manager.shutdown();
      throw error;
    }
    const published = room;
    const beat = keepAlive(lobby.client, published.code);
    const off = manager.onServerStopped.add(() => {
      off();
      beat();
      void lobby.client.leaveRoom(published.code).catch(() => {});
    });
  }

  const code = room?.code ?? transport.roomCode;
  return {
    code,
    peerCode: transport.roomCode,
    room,
    setStatus: async (status) => {
      if (lobby && room) await lobby.client.setStatus(room.code, status);
    },
  };
}

/**
 * Connects to a hosted game. With `options.lobby`, `code` is a Convex lobby code and the
 * host's PeerJS code is read from the room; without it, `code` is the PeerJS code.
 * Resolves once the connection is open; the server's approval arrives a moment later
 * (`manager.onClientConnectedCallback`).
 */
export async function joinGame(manager: NetworkManager, code: string, options: JoinGameOptions = {}): Promise<void> {
  const { PeerJsTransport } = await import('@synergy/net/peerjs');
  const { lobby, ...peerOptions } = options;

  let peerCode = code;
  let lobbyCode: string | null = null;
  if (lobby) {
    const room = await lobby.joinRoom(code);
    if (!room.peerCode) {
      await lobby.leaveRoom(room.code).catch(() => {});
      throw new Error(`Game ${room.code} has no host connection. Is the host still online?`);
    }
    peerCode = room.peerCode;
    lobbyCode = room.code;
  }

  try {
    const transport = await PeerJsTransport.join(peerCode, peerOptions);
    manager.startClient(transport, transport.hostId);
  } catch (error) {
    if (lobby && lobbyCode) await lobby.leaveRoom(lobbyCode).catch(() => {});
    throw error;
  }
  if (lobby && lobbyCode) {
    const joined = lobbyCode;
    const beat = keepAlive(lobby, joined);
    const off = manager.onClientStopped.add(() => {
      off();
      beat();
      void lobby.leaveRoom(joined).catch(() => {});
    });
  }
}
