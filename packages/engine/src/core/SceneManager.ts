import * as pc from 'playcanvas';
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
 * is a function, which is easy to read, diff and generate. It may be `async` to load
 * assets first. Scripts in the scene only wake up once the whole function has finished.
 */
export type SceneBuilder = (scene: Scene) => void | Promise<void>;

/** A loaded group of GameObjects. */
export class Scene {
  /** @internal */
  readonly _root: pc.Entity;
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

const registry = new Map<string, SceneBuilder>();

/** @internal Per-engine scene state behind the static `SceneManager` API. */
export class SceneState {
  readonly loaded: Scene[] = [];
  readonly persistent: Scene;
  activeScene: Scene;
  /** The scene whose builder is currently running, if any. */
  private building: Scene | null = null;
  private pending: (() => void)[] = [];

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
    const builder = registry.get(name);
    if (!builder) {
      const known = [...registry.keys()].map((key) => `"${key}"`).join(', ') || '(none)';
      return Promise.reject(
        new Error(`Scene "${name}" is not registered. Registered scenes: ${known}.`),
      );
    }
    return new Promise<Scene>((resolve, reject) => {
      const run = () => {
        this.loadNow(name, builder, mode).then(resolve, reject);
      };
      // Never tear a scene down in the middle of a frame's updates.
      if (this.engine.inFrame) this.pending.push(run);
      else run();
    });
  }

  private async loadNow(name: string, builder: SceneBuilder, mode: LoadSceneMode): Promise<Scene> {
    const scene = new Scene(name, this.engine);
    this.loaded.push(scene);
    if (mode === LoadSceneMode.Single) {
      // Make the new scene active first so unloading never has to invent a placeholder.
      this.activeScene = scene;
      for (const other of [...this.loaded]) {
        if (other !== scene) this.unload(other);
      }
    }

    const lifecycle = this.engine.lifecycle;
    const previous = this.building;
    this.building = scene;
    lifecycle.suspend();
    try {
      const result = builder(scene);
      // Only yield for genuinely async builders, so a synchronous scene is fully loaded
      // (scripts awake) by the time `loadScene` returns.
      if (result && typeof result.then === 'function') await result;
    } finally {
      this.building = previous;
      lifecycle.resume();
    }
    scene.isLoaded = true;
    SceneManager.sceneLoaded.invoke(scene, mode);
    return scene;
  }

  unload(scene: Scene): void {
    if (scene === this.persistent) throw new Error('The DontDestroyOnLoad scene cannot be unloaded.');
    const index = this.loaded.indexOf(scene);
    if (index < 0) return;
    for (const child of [...scene._root.children]) {
      this.engine.lifecycle.destroyNow(gameObjectOf(child as pc.Entity));
    }
    scene._root.destroy();
    scene.isLoaded = false;
    this.loaded.splice(index, 1);
    if (this.activeScene === scene) {
      this.activeScene = this.loaded[0] ?? this.createScene('Untitled');
    }
    SceneManager.sceneUnloaded.invoke(scene);
  }

  /** Runs scene loads that were requested during the frame. */
  processPending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const run of batch) run();
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
  static register(name: string, builder: SceneBuilder): void {
    registry.set(name, builder);
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
    if (target) scenes.unload(target);
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
