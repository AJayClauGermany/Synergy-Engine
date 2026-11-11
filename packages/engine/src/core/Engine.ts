import * as pc from 'playcanvas';
import type { Camera } from '../components/Camera';
import type { Collider } from '../physics/Collider';
import { dispatchMouseMessages } from '../physics/Physics';
import { CoroutineScheduler } from './Coroutine';
import { InputState } from './Input';
import { Lifecycle } from './Lifecycle';
import { currentEngineOrNull, setCurrentEngine } from './runtime';
import { SceneState } from './SceneManager';
import { TimeState } from './Time';
import { TweenRunner } from './Tween';

export interface EngineOptions {
  /** The canvas to render into. Omit (or set `headless`) to run without graphics. */
  canvas?: HTMLCanvasElement;
  /**
   * Run with no GPU, no DOM and no automatic frame loop: you call `engine.step()` yourself.
   * This is what tests and tools use. Defaults to true when no canvas is given.
   */
  headless?: boolean;
  /** Size reported for the game view in headless mode. Default 1280 x 720. */
  width?: number;
  height?: number;
  /** Graphics backends to try, in order. Default `['webgl2']`. Use `['webgpu', 'webgl2']` to prefer WebGPU. */
  deviceTypes?: string[];
  antialias?: boolean;
  /**
   * Throw exceptions raised by scripts instead of logging them. Defaults to true in
   * headless mode (so tests fail loudly) and false in the browser (so one broken script
   * does not freeze the game, as in Unity).
   */
  throwOnError?: boolean;
  /** Extra PlayCanvas component systems (e.g. `pc.SoundComponentSystem`). Render, camera and light are always on. */
  componentSystems?: (typeof pc.ComponentSystem)[];
  /** Extra PlayCanvas resource handlers. Texture and container (glTF) are always on. */
  resourceHandlers?: (typeof pc.ResourceHandler)[];
  /** Last-chance hook to adjust the PlayCanvas `AppOptions` before the app is created. */
  configure?: (options: pc.AppOptions) => void;
}

/** Upper bound on fixed steps per frame, so a slow frame cannot snowball. */
const MAX_FIXED_STEPS = 8;

function createHeadlessCanvas(width: number, height: number): HTMLCanvasElement {
  // PlayCanvas only needs a few canvas members when paired with the null graphics device.
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height }),
    getContext: () => null,
    focus() {},
    blur() {},
    setPointerCapture() {},
  };
  return canvas as unknown as HTMLCanvasElement;
}

/**
 * Owns the PlayCanvas application and runs the frame loop. Unity does this for you
 * behind the editor's Play button; here you create it once at startup:
 *
 *   const engine = await Engine.create({ canvas });
 *   await SceneManager.loadScene('Main');
 *   engine.start();
 *
 * In tests: `const engine = Engine.createHeadless(); ... engine.step(); engine.dispose();`
 */
export class Engine {
  /** The running engine, or `null`. The static APIs (Time, Input, ...) use this one. */
  static get current(): Engine | null {
    return currentEngineOrNull();
  }

  /** Creates an engine. Resolves once the graphics device is ready. */
  static async create(options: EngineOptions = {}): Promise<Engine> {
    const headless = options.headless ?? !options.canvas;
    if (headless) return new Engine(options, null);
    const canvas = options.canvas as HTMLCanvasElement;
    const device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: options.deviceTypes ?? [pc.DEVICETYPE_WEBGL2],
      antialias: options.antialias ?? true,
    });
    return new Engine(options, device);
  }

  /** Creates a headless engine synchronously. Handy in `beforeEach`. */
  static createHeadless(options: Omit<EngineOptions, 'canvas' | 'headless'> = {}): Engine {
    return new Engine({ ...options, headless: true }, null);
  }

  /** The PlayCanvas application. An escape hatch for features this API does not wrap yet. */
  readonly app: pc.AppBase;
  readonly isHeadless: boolean;
  readonly canvas: HTMLCanvasElement;

  /** @internal */ readonly time = new TimeState();
  /** @internal */ readonly input = new InputState();
  /** @internal */ readonly lifecycle = new Lifecycle(this.time);
  /** @internal */ readonly coroutines: CoroutineScheduler;
  /** @internal */ readonly tweens = new TweenRunner((error, context) => this.reportError(error, context));
  /** @internal */ readonly scenes: SceneState;
  /** @internal Enabled colliders, for `Physics` queries. */
  readonly colliders = new Set<Collider>();
  /** @internal Enabled cameras, for `Camera.main` / `Camera.allCameras`. */
  readonly cameras: Camera[] = [];
  /** @internal Per-engine caches (primitive meshes, default material, ...). */
  readonly cache = new Map<string, unknown>();

  /** @internal True while a frame's updates are running. */
  inFrame = false;
  private running = false;
  private disposed = false;
  private pendingRawDelta: number | null = null;
  private stepping = false;
  private readonly throwOnError: boolean;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(options: EngineOptions, device: pc.GraphicsDevice | null) {
    this.isHeadless = device === null;
    this.throwOnError = options.throwOnError ?? this.isHeadless;
    this.canvas =
      options.canvas ?? createHeadlessCanvas(options.width ?? 1280, options.height ?? 720);

    const appOptions = new pc.AppOptions();
    appOptions.graphicsDevice = device ?? new pc.NullGraphicsDevice(this.canvas);
    appOptions.componentSystems = [
      pc.RenderComponentSystem,
      pc.CameraComponentSystem,
      pc.LightComponentSystem,
      ...(options.componentSystems ?? []),
    ];
    appOptions.resourceHandlers = [
      pc.TextureHandler,
      pc.ContainerHandler,
      ...(options.resourceHandlers ?? []),
    ];
    options.configure?.(appOptions);

    this.app = new pc.AppBase(this.canvas);
    this.app.init(appOptions);
    this.app.autoRender = !this.isHeadless;

    this.coroutines = new CoroutineScheduler(this.time, (error, context) =>
      this.reportError(error, context),
    );
    // The static APIs must resolve to this engine before any scene object is created.
    setCurrentEngine(this);
    this.scenes = new SceneState(this);

    this.app.on('frameupdate', (milliseconds: number) => {
      this.pendingRawDelta = milliseconds / 1000;
    });
    this.app.systems.on('update', this.onUpdate, this);
    this.app.systems.on('postUpdate', this.onLateUpdate, this);
    this.app.on('update', this.onEndOfFrame, this);

    if (!this.isHeadless) this.attachToPage();

    // PlayCanvas's own start-up (component system initialisation). The frame loop it
    // schedules only exists in a browser; headless engines advance through `step()`.
    this.app.start();
    if (!this.isHeadless) this.running = true;
  }

  /** The size of the game view in CSS pixels. */
  get canvasSize(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  /** Whether the automatic frame loop is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Resumes the automatic frame loop after `stop()`. A browser engine starts running as
   * soon as it is created, so calling this at startup is optional but harmless.
   */
  start(): void {
    if (this.isHeadless) {
      throw new Error('A headless engine has no automatic frame loop. Call engine.step() instead.');
    }
    if (this.running || this.disposed) return;
    this.running = true;
    this.app.autoRender = true;
    this.app.requestAnimationFrame();
  }

  /** Pauses the automatic frame loop entirely (no updates, no rendering). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.app.autoRender = false;
    if (this.app.frameRequestId != null) {
      cancelAnimationFrame(this.app.frameRequestId);
      this.app.frameRequestId = null;
    }
  }

  /**
   * Advances the game by exactly one frame of `deltaTime` seconds. This is how headless
   * engines run, and it also works on a stopped browser engine for deterministic stepping.
   * The delta is used as given (`Time.maximumDeltaTime` only limits real frames), though
   * at most 8 fixed updates run per frame, so keep steps small when testing `fixedUpdate`.
   */
  step(deltaTime = 1 / 60): void {
    if (this.disposed) throw new Error('This engine has been disposed.');
    if (this.running) {
      throw new Error('engine.step() cannot be used while the automatic loop is running. Call engine.stop() first.');
    }
    this.pendingRawDelta = deltaTime;
    this.stepping = true;
    try {
      this.app.update(deltaTime * this.time.timeScale);
    } finally {
      this.stepping = false;
      if (this.inFrame) {
        // A script threw part-way through the frame. Leave the engine in a usable state.
        this.inFrame = false;
        this.time.inFixedTimeStep = false;
        this.input.endFrame();
      }
    }
    if (!this.isHeadless) this.app.render();
  }

  /** Runs `frames` frames of `deltaTime` seconds each. */
  stepFrames(frames: number, deltaTime = 1 / 60): void {
    for (let i = 0; i < frames; i++) this.step(deltaTime);
  }

  /** Steps frames until `seconds` of game time have passed. */
  stepSeconds(seconds: number, deltaTime = 1 / 60): void {
    const end = this.time.time + seconds;
    // Guard against a zero time scale, which would never reach `end`.
    for (let i = 0; this.time.time < end - 1e-9 && i < 1_000_000; i++) this.step(deltaTime);
  }

  /** Destroys everything and releases the canvas. The engine cannot be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    for (const scene of [...this.scenes.loaded, this.scenes.persistent]) {
      for (const root of scene.getRootGameObjects()) this.lifecycle.destroyNow(root);
    }
    this.tweens.clear();
    this.input.detachListeners();
    this.resizeObserver?.disconnect();
    this.app.destroy();
    if (currentEngineOrNull() === this) setCurrentEngine(null);
  }

  /** @internal Routes an exception from game code according to `throwOnError`. */
  reportError(error: unknown, context: string): void {
    if (this.throwOnError) {
      if (error instanceof Error && !error.message.includes(' [in ')) {
        error.message = `${error.message} [in ${context}]`;
      }
      throw error;
    }
    console.error(`Exception in ${context}:`, error);
  }

  // ---- Frame phases -------------------------------------------------------------------

  private onUpdate(scaledDelta: number): void {
    const time = this.time;
    const raw = this.pendingRawDelta ?? (time.timeScale > 0 ? scaledDelta / time.timeScale : 0);
    this.pendingRawDelta = null;
    this.inFrame = true;
    time.beginFrame(raw, !this.stepping);
    this.input.beginFrame(time.unscaledDeltaTime);
    this.lifecycle.runStarts();

    let steps = 0;
    while (time.accumulator >= time.fixedDeltaTime && steps < MAX_FIXED_STEPS) {
      time.accumulator -= time.fixedDeltaTime;
      time.fixedTime += time.fixedDeltaTime;
      time.inFixedTimeStep = true;
      try {
        this.lifecycle.runFixedUpdates();
        this.coroutines.tick('fixed');
      } finally {
        time.inFixedTimeStep = false;
      }
      steps++;
    }
    // Drop any backlog rather than trying to catch up forever.
    if (steps === MAX_FIXED_STEPS) time.accumulator %= time.fixedDeltaTime;

    dispatchMouseMessages(this);
    this.lifecycle.runUpdates();
    this.tweens.tick(time.deltaTime, time.unscaledDeltaTime);
    this.coroutines.tick('update');
  }

  private onLateUpdate(): void {
    this.lifecycle.runLateUpdates();
  }

  private onEndOfFrame(): void {
    try {
      this.coroutines.tick('endOfFrame');
      this.lifecycle.processDestroyQueue();
    } finally {
      this.input.endFrame();
      this.inFrame = false;
      this.app.timeScale = this.time.timeScale;
      this.app.maxDeltaTime = this.time.maximumDeltaTime;
    }
    this.scenes.pump();
  }

  // ---- Browser wiring -----------------------------------------------------------------

  private attachToPage(): void {
    const { app, canvas } = this;
    app.graphicsDevice.maxPixelRatio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    // The canvas is sized by CSS; the drawing buffer follows it.
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width > 0 && height > 0) app.resizeCanvas(width, height);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(canvas);
    }
    resize();
    this.input.attach(canvas);
  }
}
