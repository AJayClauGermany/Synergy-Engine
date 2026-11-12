import * as pc from 'playcanvas';
import type { Component } from './Component';
import type { Engine } from './Engine';
import { UnityEvent } from './events';
import { type GameObject, gameObjectOf, markSceneRoot } from './GameObject';
import { currentEngine } from './runtime';

export enum LoadSceneMode {
  /** Unload every other scene first (objects marked `dontDestroyOnLoad` survive). */
  Single = 'single',
  /** Keep what is loaded and add this scene on top. */
  Additive = 'additive',
}

/**
 * Builds a scene's contents. In Unity a scene is a file authored in the editor; here it
 * is a function, which is easy to read, diff and generate. Scripts in the scene only
 * wake up once the whole function has finished.
 *
 * It may be `async`, with one caveat for ADDITIVE loads: objects created after an `await`
 * go to the active scene, because by then the engine can no longer tell the builder apart
 * from other code. To load assets first, register a `SceneDefinition` (`preload` + `build`)
 * instead, which has no such caveat. Single loads are unaffected either way. The same
 * goes for tests that run several engines: code after an `await` runs against whichever
 * engine is current then, while a `SceneDefinition`'s `build` always runs in its own.
 */
export type SceneBuilder = (scene: Scene) => void | Promise<void>;

/**
 * A scene in two steps: load what it needs, then build it. Prefer this over an `async`
 * builder when assets are involved, because `build` runs in one go and everything it
 * creates is guaranteed to land in this scene (additive loads included).
 *
 *   SceneManager.register('Forest', {
 *     preload: () => Assets.loadModel(treeUrl),
 *     build: (scene, tree) => { tree.instantiate(); },
 *   });
 */
export interface SceneDefinition<Assets = unknown> {
  /** Loads assets. Do not create GameObjects here. */
  preload: () => Assets | Promise<Assets>;
  /** Creates the scene's objects from the loaded assets. Must be synchronous. */
  build: (scene: Scene, assets: Assets) => void;
}

/** A loaded group of GameObjects. */
export class Scene {
  /** @internal */
  readonly _root: pc.Entity;
  /** @internal While the scene is being built: the components waiting to wake up. */
  _pending: Component[] | null = null;
  /** @internal */
  _unloading = false;
  isLoaded = false;

  /** @internal */
  constructor(
    readonly name: string,
    engine: Engine,
  ) {
    this._root = new pc.Entity(`Scene:${name}`, engine.app);
    markSceneRoot(this._root, this);
    engine.app.root.addChild(this._root);
  }

  get rootCount(): number {
    return this._root.children.length;
  }

  getRootGameObjects(): GameObject[] {
    return this._root.children.map((child) => gameObjectOf(child as pc.Entity));
  }

  toString(): string {
    return `Scene "${this.name}"`;
  }
}

const registry = new Map<string, SceneBuilder | SceneDefinition>();

interface LoadJob {
  run: () => Scene | Promise<Scene>;
  resolve: (scene: Scene) => void;
  reject: (error: unknown) => void;
}

/** @internal Per-engine scene state behind the static `SceneManager` API. */
export class SceneState {
  readonly loaded: Scene[] = [];
  readonly persistent: Scene;
  activeScene: Scene;
  /** The scene whose builder is running right now (synchronously), if any. */
  private building: Scene | null = null;
  private jobs: LoadJob[] = [];
  /** Above zero while a load or unload is in progress; further loads wait their turn. */
  private busy = 0;

  constructor(private readonly engine: Engine) {
    this.persistent = new Scene('DontDestroyOnLoad', engine);
    this.persistent.isLoaded = true;
    this.activeScene = this.createScene('Untitled');
  }

  /** Where `new GameObject()` puts things. */
  get targetScene(): Scene {
    return this.building ?? this.activeScene;
  }

  allScenes(): Scene[] {
    return [...this.loaded, this.persistent];
  }

  createScene(name: string): Scene {
    const scene = new Scene(name, this.engine);
    scene.isLoaded = true;
    this.loaded.push(scene);
    return scene;
  }

  load(name: string, mode: LoadSceneMode): Promise<Scene> {
    const definition = registry.get(name);
    if (!definition) {
      const known = [...registry.keys()].map((key) => `"${key}"`).join(', ') || '(none)';
      return Promise.reject(new Error(`Scene "${name}" is not registered. Registered scenes: ${known}.`));
    }
    return new Promise<Scene>((resolve, reject) => {
      this.jobs.push({ run: () => this.build(name, definition, mode), resolve, reject });
      this.pump();
    });
  }

  /**
   * Starts the next queued load if nothing else is going on. Loads run strictly one at a
   * time, and never in the middle of a frame's updates or of another load or unload, so
   * a `loadScene` called from `awake`, `onDestroy` or a double-clicked button is safe.
   */
  pump(): void {
    // A load that finishes after an `await` resumes here from a promise, when some other
    // engine may be the current one (tests run several). The next job's builder creates
    // objects through the static API, so this engine must be current while it runs.
    this.engine.run(() => this.pumpJobs());
  }

  private pumpJobs(): void {
    while (this.busy === 0 && !this.engine.inFrame && !this.engine.isDisposed) {
      const job = this.jobs.shift();
      if (!job) return;
      this.busy++;
      let result: Scene | Promise<Scene>;
      try {
        result = job.run();
      } catch (error) {
        this.busy--;
        job.reject(error);
        continue;
      }
      if (result instanceof Promise) {
        result.then(
          (scene) => {
            this.busy--;
            job.resolve(scene);
            this.pump();
          },
          (error: unknown) => {
            this.busy--;
            job.reject(error);
            this.pump();
          },
        );
        return;
      }
      this.busy--;
      job.resolve(result);
    }
  }

  private build(name: string, definition: SceneBuilder | SceneDefinition, mode: LoadSceneMode): Scene | Promise<Scene> {
    const scene = new Scene(name, this.engine);
    this.loaded.push(scene);
    if (mode === LoadSceneMode.Single) {
      // Make the new scene active first so unloading never has to invent a placeholder.
      this.activeScene = scene;
      for (const other of [...this.loaded]) {
        if (other !== scene) this.unload(other);
      }
    }

    // Scripts created in this scene wait in `_pending` until the builder has finished,
    // so every `awake` sees the complete scene. Only this scene is affected: anything
    // created elsewhere in the meantime (while an async builder awaits) wakes normally.
    scene._pending = [];
    const finish = (): Scene => {
      const waiting = scene._pending ?? [];
      scene._pending = null;
      // It may have been unloaded (or the engine disposed) while it was still loading.
      if (!this.loaded.includes(scene) || this.engine.isDisposed) return scene;
      // After an `await` another engine may be current; the scripts waking up here, and
      // the `sceneLoaded` listeners, must see this one.
      return this.engine.run(() => {
        this.engine.lifecycle.wake(waiting);
        scene.isLoaded = true;
        SceneManager.sceneLoaded.invoke(scene, mode);
        return scene;
      });
    };
    const fail = (error: unknown): never => {
      scene._pending = null;
      throw error;
    };

    // Runs builder code with `new GameObject()` targeting this scene. Only synchronous
    // code can be scoped like this: after an `await` inside a builder, new objects go to
    // the active scene (which, for a Single load, is this one anyway).
    const inScene = <T>(run: () => T): T => {
      const previous = this.building;
      this.building = scene;
      try {
        return run();
      } finally {
        this.building = previous;
      }
    };

    try {
      if (typeof definition === 'function') {
        const result = inScene(() => definition(scene));
        if (result && typeof result.then === 'function') return result.then(finish, fail);
        return finish();
      }
      const assets = definition.preload();
      const construct = (loaded: unknown): Scene => {
        // The scene may have been unloaded, or the engine disposed, while its assets were
        // loading. Otherwise build it in this engine, whichever one is current by now.
        if (this.loaded.includes(scene) && !this.engine.isDisposed) {
          this.engine.run(() => inScene(() => definition.build(scene, loaded)));
        }
        return finish();
      };
      if (assets instanceof Promise) return assets.then(construct).catch(fail);
      return construct(assets);
    } catch (error) {
      return fail(error);
    }
  }

  unload(scene: Scene): void {
    if (scene === this.persistent) throw new Error('The DontDestroyOnLoad scene cannot be unloaded.');
    if (!this.loaded.includes(scene) || scene._unloading) return;
    scene._unloading = true;
    this.busy++;
    try {
      for (const child of [...scene._root.children]) {
        this.engine.lifecycle.destroyNow(gameObjectOf(child as pc.Entity));
      }
    } finally {
      this.busy--;
      scene._pending = null;
      scene._root.destroy();
      scene.isLoaded = false;
      // Look the index up now: callbacks above may have changed the list.
      const index = this.loaded.indexOf(scene);
      if (index >= 0) this.loaded.splice(index, 1);
      if (this.activeScene === scene) {
        this.activeScene = this.loaded[0] ?? this.createScene('Untitled');
      }
    }
    SceneManager.sceneUnloaded.invoke(scene);
  }
}

/** Unity's `SceneManager`. Scenes are registered functions rather than asset files. */
export class SceneManager {
  /** Raised after a scene has finished loading. */
  static readonly sceneLoaded = new UnityEvent<[scene: Scene, mode: LoadSceneMode]>();
  /** Raised after a scene has been unloaded. */
  static readonly sceneUnloaded = new UnityEvent<[scene: Scene]>();

  /**
   * Makes a scene loadable by name. Call once at startup for each scene. This replaces
   * Unity's "Scenes in Build" list.
   */
  static register<Assets>(name: string, scene: SceneBuilder | SceneDefinition<Assets>): void {
    registry.set(name, scene as SceneBuilder | SceneDefinition);
  }

  static isRegistered(name: string): boolean {
    return registry.has(name);
  }

  /**
   * Loads a registered scene. Called during a frame, the switch happens at the end of
   * that frame. The promise resolves once the scene is built and its scripts are awake.
   */
  static loadScene(name: string, mode: LoadSceneMode = LoadSceneMode.Single): Promise<Scene> {
    return currentEngine().scenes.load(name, mode);
  }

  /** Alias of `loadScene`, which is already asynchronous. */
  static loadSceneAsync(name: string, mode: LoadSceneMode = LoadSceneMode.Single): Promise<Scene> {
    return SceneManager.loadScene(name, mode);
  }

  /** Destroys every object in a scene and removes it. */
  static unloadScene(scene: Scene | string): void {
    const scenes = currentEngine().scenes;
    const target = typeof scene === 'string' ? scenes.loaded.find((s) => s.name === scene) : scene;
    if (!target) {
      const loaded = scenes.loaded.map((s) => `"${s.name}"`).join(', ');
      throw new Error(`unloadScene: no scene named "${String(scene)}" is loaded. Loaded: ${loaded || 'none'}.`);
    }
    scenes.unload(target);
    scenes.pump();
  }

  /** Creates a new empty scene alongside the loaded ones. */
  static createScene(name: string): Scene {
    return currentEngine().scenes.createScene(name);
  }

  static getActiveScene(): Scene {
    return currentEngine().scenes.activeScene;
  }

  /** New GameObjects are created in the active scene. */
  static setActiveScene(scene: Scene): void {
    if (!scene.isLoaded) throw new Error(`${scene} is not loaded.`);
    currentEngine().scenes.activeScene = scene;
  }

  static get sceneCount(): number {
    return currentEngine().scenes.loaded.length;
  }

  static getSceneAt(index: number): Scene {
    const scene = currentEngine().scenes.loaded[index];
    if (!scene) throw new RangeError(`No loaded scene at index ${index}.`);
    return scene;
  }

  static getSceneByName(name: string): Scene | null {
    return currentEngine().scenes.loaded.find((scene) => scene.name === name) ?? null;
  }

  /** Moves a root GameObject into another loaded scene. */
  static moveGameObjectToScene(gameObject: GameObject, scene: Scene): void {
    if (gameObject.transform.parent) {
      throw new Error(`"${gameObject.name}" is not a root object; only roots can change scene.`);
    }
    gameObject.entity.reparent(scene._root);
  }
}
