import { dontDestroyOnLoad, GameObject, instantiate, SceneManager } from '@synergy/engine';
import { LoopbackHub } from '@synergy/net';
import { NetworkManager, NetworkObject } from '@synergy/netcode';
import { buildId } from '../env';
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
    const offLoaded = scenes.onLoadComplete.add((clientId, scene) => {
      // Wait for the host's own copy of the scene (client 0 is the host).
      if (clientId !== NetworkManager.serverClientId || scene !== FRONTIER_SCENE) return;
      offLoaded();

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
    scenes.loadScene(FRONTIER_SCENE).catch((error: unknown) => {
      offLoaded();
      reject(error);
    });
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

/** Stops listening for the end of a joined match, when leaving it on purpose. */
let stopWatching: () => void = () => {};

/** A match on this machine alone. It is still a host, with no clients, so there is one code path. */
export async function playOffline(manager: NetworkManager): Promise<void> {
  stopWatching();
  manager.shutdown();
  manager.startHost(new LoopbackHub().connect('host'));
  frontierOnline.value = { mode: 'offline', code: null, isHost: true, error: null };
  await startMatch(manager);
}

/** Hosts a match others can join with the code this resolves to. */
export async function hostOnline(manager: NetworkManager): Promise<void> {
  frontierOnline.value = { mode: 'connecting', code: null, isHost: true, error: null };
  try {
    const { hostGame } = await import('@synergy/netcode/lobby');
    stopWatching();
    manager.shutdown();
    const game = await hostGame(manager, { prefix: PEER_PREFIX });
    frontierOnline.value = { mode: 'hosting', code: game.code, isHost: true, error: null };
    await startMatch(manager);
  } catch (error) {
    await fallBack(manager, error);
  }
}

/** Joins a hosted match. The host sends the scene and every object this player may see. */
export async function joinOnline(manager: NetworkManager, code: string): Promise<void> {
  frontierOnline.value = { mode: 'connecting', code, isHost: false, error: null };
  try {
    const { joinGame } = await import('@synergy/netcode/lobby');
    stopWatching();
    manager.shutdown();
    await joinGame(manager, code.trim(), { prefix: PEER_PREFIX });
    frontierOnline.value = { mode: 'joined', code, isHost: false, error: null };
    // If the host leaves or refuses us (manager.disconnectReason says which), play alone again.
    const off = manager.onClientStopped.add(() => {
      off();
      void fallBack(manager, new Error(manager.disconnectReason || 'The match ended.'));
    });
    stopWatching = off;
  } catch (error) {
    await fallBack(manager, error);
  }
}

async function fallBack(manager: NetworkManager, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await playOffline(manager);
  frontierOnline.update((state) => ({ ...state, error: message }));
}
