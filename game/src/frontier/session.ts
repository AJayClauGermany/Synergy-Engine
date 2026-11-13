import { dontDestroyOnLoad, GameObject, instantiate, SceneManager } from '@synergy/engine';
import { LoopbackHub } from '@synergy/net';
import { NetworkManager, NetworkObject } from '@synergy/netcode';
import { buildId } from '../env';
import { launch, localPlayerId, openPlayerWindow } from '../localPlay';
import { makeRoomCode } from '@synergy/net';
import { frontierOnline } from './hud';
import { Match, MatchPrefab } from './Match';
import { ARMY, START_CELLS, unitTypes } from './rules';
import { FRONTIER_SCENE, frontierScene } from './scene';
import { Soldier, SoldierPrefab } from './Soldier';

/** Namespaces this game's room codes on PeerJS's shared signalling server. Change it for your game. */
const PEER_PREFIX = 'synergy-frontier';

/**
 * What every machine must do the same way before it hosts or joins: register the match
 * scene and the prefabs, and say which build it is. Tests call this for each simulated
 * machine; the game calls it once through `createFrontierManager`.
 */
export function setupFrontier(manager: NetworkManager): void {
  if (!SceneManager.isRegistered(FRONTIER_SCENE)) SceneManager.register(FRONTIER_SCENE, frontierScene);
  manager.networkPrefabs.add(MatchPrefab).add(SoldierPrefab);
  // Two different builds of the game must not play together: see docs/netcode.md, "Spawning".
  manager.networkConfig.protocolVersion = buildId;
}

/** Makes the NetworkManager. Do this once at boot, before anything that uses the network. */
export function createFrontierManager(): NetworkManager {
  const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
  dontDestroyOnLoad(manager.gameObject); // it outlives scene changes
  setupFrontier(manager);
  return manager;
}

/**
 * Host only. Starts a match (or a rematch) for everyone connected:
 *
 *   1. load the match scene on every machine;
 *   2. when the host's own copy is loaded, spawn the Match and both armies into it;
 *   3. when every machine has reported in, let play begin.
 *
 * Until step 3 the phase is 'waiting' and the host refuses every order, so nobody acts
 * on a map another player has not finished loading. The objects are spawned with
 * `spawn(true)`: they belong to this scene, and are removed when the next one loads.
 *
 * Steps 2 and 3 hang off the scene manager's events rather than following an `await`.
 * Both work in the game, but the events also work in tests that run several simulated
 * machines, where the code after an `await` can find another machine's engine current.
 */
export function startMatch(manager: NetworkManager): Promise<Match> {
  const scenes = manager.sceneManager;
  return new Promise<Match>((resolve, reject) => {
    // Start the load first. If it is refused (another scene is still loading: a
    // double-clicked "Play again"), it throws here and nothing has been set up to undo.
    let loading: Promise<void>;
    try {
      loading = scenes.loadScene(FRONTIER_SCENE);
    } catch (error) {
      reject(error);
      return;
    }

    let spawned = false;
    const offLoaded = scenes.onLoadComplete.add((clientId, scene) => {
      // Wait for the host's own copy of the scene (client 0 is the host).
      if (clientId !== NetworkManager.serverClientId || scene !== FRONTIER_SCENE) return;
      offLoaded();
      spawned = true;

      const match = instantiate(MatchPrefab).getComponent(Match) as Match;
      match.networkObject.spawn(true);
      START_CELLS.forEach((cells, team) => {
        ARMY.forEach((type, index) => {
          const cell = cells[index];
          if (cell) spawnSoldier(match, type, team, cell);
        });
      });

      // Fires once every client has the scene too (straight away when there are none).
      const offEveryone = scenes.onLoadEventCompleted.add(() => {
        offEveryone();
        if (match.isSpawned) match.begin();
      });
      resolve(match);
    });

    // The load can end without the event: the network was shut down while it ran. Then
    // this start is over, and its listener must not be left to fire for the next one.
    const abandon = (error: unknown) => {
      if (spawned) return;
      offLoaded();
      reject(error);
    };
    loading.then(() => abandon(new Error('The match was stopped before its scene had loaded.')), abandon);
  });
}

/** Host only. Puts a unit on the map. */
export function spawnSoldier(match: Match, type: string, team: number, cell: { x: number; y: number }): Soldier {
  const soldier = instantiate(SoldierPrefab).getComponent(Soldier) as Soldier;
  // Set the state before spawning, so the first thing any machine sees is already right.
  soldier.type.value = type;
  soldier.team.value = team;
  soldier.cell.value = cell;
  soldier.hp.value = unitTypes.get(type).maxHp;
  // Decides which clients are sent this unit at all: the fog of war, enforced by the host.
  const object = soldier.getComponent(NetworkObject) as NetworkObject;
  object.checkObjectVisibility = (clientId) => match.canClientSee(clientId, soldier);
  object.spawn(true);
  return soldier;
}

// ---- Ways to play --------------------------------------------------------------------------
// Each of these replaces whatever was going on before. They can overlap (a click while
// another is still connecting), so each takes a number and gives up quietly if a later
// request has started by the time it would act.

let request = 0;
/** Stops listening for the end of a joined match, when leaving it on purpose. */
let stopWatching: () => void = () => {};

function begin(manager: NetworkManager): () => boolean {
  const mine = ++request;
  stopWatching();
  stopWatching = () => {};
  manager.shutdown(); // ends the previous match here; a start it had in flight is abandoned
  return () => mine === request;
}

/** Starts a match unless a later request has taken over. A start that was overtaken is not an error. */
async function start(manager: NetworkManager, current: () => boolean): Promise<void> {
  try {
    await startMatch(manager);
  } catch (error) {
    if (current()) throw error;
  }
}

/** A match on this machine alone. It is still a host, with no clients, so there is one code path. */
export async function playOffline(manager: NetworkManager): Promise<void> {
  const current = begin(manager);
  manager.startHost(new LoopbackHub().connect('host'));
  frontierOnline.value = { mode: 'offline', code: null, local: false, isHost: true, error: null };
  await start(manager, current);
}

/** Host only: a new match for the players already here. Does nothing while one is still starting. */
export async function rematch(manager: NetworkManager): Promise<void> {
  if (!manager.isServer || manager.sceneManager.isLoading || manager.sceneManager.clientsLoading.length > 0) return;
  const mine = request;
  await start(manager, () => mine === request);
}

export interface RoomOptions {
  /** A room between windows of this browser instead of PeerJS (testing). Defaults to `?net=local`. */
  local?: boolean;
  /** Host with this code rather than a made-up one. */
  roomCode?: string;
}

/** Hosts a match others can join with the code shown in the HUD. */
export async function hostOnline(manager: NetworkManager, options: RoomOptions = {}): Promise<void> {
  const local = options.local ?? launch.net === 'local';
  const current = begin(manager);
  frontierOnline.value = { mode: 'connecting', code: null, local, isHost: true, error: null };
  try {
    const { hostGame } = await import('@synergy/netcode/lobby');
    if (!current()) return;
    const game = await hostGame(manager, { prefix: PEER_PREFIX, local, roomCode: options.roomCode });
    if (!current()) return;
    frontierOnline.value = { mode: 'hosting', code: game.code, local, isHost: true, error: null };
    await start(manager, current);
  } catch (error) {
    if (current()) await fallBack(manager, error);
  }
}

/** Joins a hosted match. The host sends the scene and every object this player may see. */
export async function joinOnline(manager: NetworkManager, code: string, options: RoomOptions = {}): Promise<void> {
  const local = options.local ?? launch.net === 'local';
  const current = begin(manager);
  frontierOnline.value = { mode: 'connecting', code, local, isHost: false, error: null };
  try {
    const { joinGame } = await import('@synergy/netcode/lobby');
    if (!current()) return;
    await joinGame(manager, code.trim(), { prefix: PEER_PREFIX, local, id: localPlayerId() ?? undefined });
    if (!current()) return;
    frontierOnline.value = { mode: 'joined', code, local, isHost: false, error: null };
    // If the host leaves or refuses us (manager.disconnectReason says which), play alone again.
    const off = manager.onClientStopped.add(() => {
      off();
      if (current()) void fallBack(manager, new Error(manager.disconnectReason || 'The match ended.'));
    });
    stopWatching = off;
  } catch (error) {
    if (current()) await fallBack(manager, error);
  }
}

/**
 * Development: hosts a match between windows of this browser and opens a second
 * player's window joined to it. Call it from a click (browsers block windows otherwise).
 */
export function testFrontierInWindows(manager: NetworkManager): Promise<void> {
  // Open the window while the click still counts; it keeps looking until the room exists.
  const roomCode = makeRoomCode();
  openPlayerWindow(roomCode, true);
  return hostOnline(manager, { local: true, roomCode });
}

/** Development: one more player's window, joined to the match this window hosts. */
export function addFrontierPlayerWindow(): void {
  const { mode, code, local } = frontierOnline.value;
  if (mode === 'hosting' && code) openPlayerWindow(code, local);
}

async function fallBack(manager: NetworkManager, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await playOffline(manager);
  frontierOnline.update((state) => ({ ...state, error: message }));
}
