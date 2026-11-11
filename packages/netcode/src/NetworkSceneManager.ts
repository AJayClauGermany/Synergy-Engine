import { Signal } from '@synergy/net';
import type { NetworkManager } from './NetworkManager';

/**
 * Loads a scene on the server and on every client, and reports when they have all
 * finished. Unity: `NetworkSceneManager`. This is how a match starts: everyone is in the
 * lobby scene, the host loads the match scene for all, and play begins when the last
 * machine reports in.
 *
 *   // on the host
 *   const scenes = manager.sceneManager;
 *   scenes.onLoadComplete.add((clientId, scene) => {
 *     if (clientId === 0 && scene === 'Match') spawnTheUnits();   // the host has the scene;
 *   });                                                           // spawn(true): they belong to it
 *   scenes.onLoadEventCompleted.add((scene) => {
 *     if (scene === 'Match') startPlay();          // everyone is in: the barrier has lifted
 *   });
 *   void scenes.loadScene('Match');
 *
 * What happens, in order: the server tells every client which scene to load, then loads
 * it itself. Each client loads the scene before it handles anything else the server
 * sends, so objects the server spawns into the new scene arrive after it exists. A
 * client that joins later is told the current scene with its admission and loads it
 * before it receives the objects.
 *
 * Spawned objects outlive the change (they are moved to DontDestroyOnLoad on every
 * machine) unless they were spawned with `spawn(true)`, in which case they are despawned
 * with the old scene. The NetworkManager's own GameObject is kept as well.
 *
 * The scene must be registered with `SceneManager.register` under the same name on
 * every machine. Scenes are loaded in Single mode; additive networked loads are not built.
 */
export class NetworkSceneManager {
  /**
   * A machine finished loading the scene. On the server it fires for each client and for
   * the server itself (client 0); on a client, for that client. Unity: `OnLoadComplete`.
   */
  readonly onLoadComplete = new Signal<[clientId: number, sceneName: string]>();
  /**
   * The load is over for everyone who was connected when it began: each client either
   * finished or ran out of time (`networkConfig.loadSceneTimeOut`). Fires on the server
   * and on every client. Start play from here. Unity: `OnLoadEventCompleted`.
   */
  readonly onLoadEventCompleted = new Signal<[sceneName: string, clientsCompleted: number[], clientsTimedOut: number[]]>();
  /**
   * Server only. A client that joined after the scene was loaded has caught up: it has
   * the scene and every object it may see. Unity: `OnSynchronizeComplete`.
   */
  readonly onSynchronizeComplete = new Signal<[clientId: number]>();

  constructor(private readonly manager: NetworkManager) {}

  /** The scene the server last loaded for everyone, or `null` if it has not loaded one. */
  get sceneName(): string | null {
    return this.manager._networkScene?.n ?? null;
  }

  /** This machine is loading a scene the server asked for. A client handles no other message until it is done. */
  get isLoading(): boolean {
    return this.manager._sceneLoading;
  }

  /** Server only. The clients (and client 0, the server) still loading the current scene. Empty once the load is over. */
  get clientsLoading(): number[] {
    return this.manager._clientsLoading();
  }

  /**
   * Server only. Loads `sceneName` here and on every client. The promise resolves when
   * this machine's copy is loaded and its scripts are awake, which is the moment to spawn
   * what belongs to the scene; `onLoadEventCompleted` tells you when the clients have
   * caught up. Unity: `LoadScene(sceneName, LoadSceneMode.Single)`.
   */
  loadScene(sceneName: string): Promise<void> {
    return this.manager._loadNetworkScene(sceneName);
  }
}
