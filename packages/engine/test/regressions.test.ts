import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BoxCollider,
  Camera,
  destroy,
  destroyImmediate,
  Engine,
  GameObject,
  type IEnumerator,
  instantiate,
  isAlive,
  LoadSceneMode,
  MonoBehaviour,
  Physics,
  PrimitiveType,
  Quaternion,
  SceneManager,
  Space,
  Vector3,
  WaitUntil,
} from '../src';

/**
 * Bugs found by review, each pinned by a test so it cannot come back.
 */
let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('scene loading', () => {
  test('gameplay continues normally while an async scene is still loading', async () => {
    let finish = () => {};
    SceneManager.register('Chunk', async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const log: string[] = [];
    class Bullet extends MonoBehaviour {
      awake() {
        log.push('awake');
      }
      update() {
        log.push('update');
      }
    }
    class Gun extends MonoBehaviour {
      fired = false;
      update() {
        if (this.fired) return;
        this.fired = true;
        new GameObject('Bullet').addComponent(Bullet);
      }
    }
    new GameObject('Gun').addComponent(Gun);
    const main = SceneManager.getActiveScene();
    const loading = SceneManager.loadScene('Chunk', LoadSceneMode.Additive);
    engine.stepFrames(5);
    expect(log).toContain('awake');
    expect(log).toContain('update');
    expect(GameObject.find('Bullet')?.scene).toBe(main);
    finish();
    await loading;
  });

  test('loads run one at a time, so a double-clicked Play button builds one scene', async () => {
    const gates: (() => void)[] = [];
    SceneManager.register('Game', async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      new GameObject('Player');
    });
    void SceneManager.loadScene('Game');
    void SceneManager.loadScene('Game');
    await nextTask();
    expect(gates.length).toBe(1); // the second load has not started yet
    gates[0]?.();
    await nextTask();
    gates[1]?.();
    await nextTask();
    const players = SceneManager.getActiveScene()
      .getRootGameObjects()
      .filter((go) => go.name === 'Player');
    expect(players.length).toBe(1);
    expect(SceneManager.sceneCount).toBe(1);
    new GameObject('SpawnedLater');
    expect(GameObject.find('SpawnedLater')?.scene).toBe(SceneManager.getActiveScene());
  });

  test('preload + build places everything in its own scene, even for additive loads', async () => {
    let release = (_value: string) => {};
    SceneManager.register('Forest', {
      preload: () => new Promise<string>((resolve) => (release = resolve)),
      build: (_scene, asset) => {
        new GameObject(`Tree from ${asset}`);
      },
    });
    const main = SceneManager.getActiveScene();
    const loading = SceneManager.loadScene('Forest', LoadSceneMode.Additive);
    new GameObject('MadeWhileLoading');
    release('tree.glb');
    const forest = await loading;
    expect(GameObject.find('Tree from tree.glb')?.scene).toBe(forest);
    expect(GameObject.find('MadeWhileLoading')?.scene).toBe(main);
    expect(forest.isLoaded).toBe(true);
  });

  test('loadScene called from awake or onDestroy waits its turn', async () => {
    const log: string[] = [];
    class Boot extends MonoBehaviour {
      awake() {
        void SceneManager.loadScene('Menu');
      }
    }
    class Chain extends MonoBehaviour {
      onDestroy() {
        void SceneManager.loadScene('Credits');
      }
    }
    SceneManager.register('Boot', () => {
      new GameObject('Boot').addComponent(Boot);
    });
    SceneManager.register('Menu', () => {
      new GameObject('Menu').addComponent(Chain);
    });
    SceneManager.register('Credits', () => {
      new GameObject('Credits');
    });
    SceneManager.register('Last', () => {});
    const off = SceneManager.sceneLoaded.addListener((scene) => log.push(scene.name));

    const boot = await SceneManager.loadScene('Boot');
    // Boot finished loading, then Menu replaced it.
    expect(log).toEqual(['Boot', 'Menu']);
    expect(boot.isLoaded).toBe(false);
    expect(() => SceneManager.setActiveScene(boot)).toThrow();

    // Leaving Menu destroys Chain, which asks for Credits in the middle of the switch.
    await SceneManager.loadScene('Last');
    off();
    const names = Array.from({ length: SceneManager.sceneCount }, (_, i) => SceneManager.getSceneAt(i).name);
    expect(names).toEqual(['Credits']);
    expect(SceneManager.getActiveScene().name).toBe('Credits');
    expect(GameObject.find('Credits')).not.toBeNull();
  });

  test('a builder that throws rejects the load and leaves the engine usable', async () => {
    SceneManager.register('Broken', () => {
      throw new Error('bad scene');
    });
    SceneManager.register('Fine', () => {
      new GameObject('Ok');
    });
    expect(SceneManager.loadScene('Broken', LoadSceneMode.Additive)).rejects.toThrow(/bad scene/);
    await SceneManager.loadScene('Fine', LoadSceneMode.Additive);
    expect(GameObject.find('Ok')).not.toBeNull();
  });
});

describe('coroutines', () => {
  test('a coroutine can end itself: deactivate, destroy, stopAll, cancelInvoke', () => {
    const log: string[] = [];
    class Fader extends MonoBehaviour {
      *fadeOut(): IEnumerator {
        try {
          yield null;
          this.gameObject.setActive(false);
          log.push('not reached after the next yield');
          yield null;
          log.push('never');
        } finally {
          log.push('cleaned up');
        }
      }
      *selfDestruct(): IEnumerator {
        yield null;
        destroyImmediate(this.gameObject);
        yield null;
        log.push('never');
      }
      *stopper(): IEnumerator {
        yield null;
        this.stopAllCoroutines();
        yield null;
        log.push('never');
      }
    }
    for (const routine of ['fadeOut', 'selfDestruct', 'stopper'] as const) {
      const fader = new GameObject(routine).addComponent(Fader);
      fader.startCoroutine(fader[routine]());
    }
    engine.stepFrames(4);
    expect(log).toEqual(['not reached after the next yield', 'cleaned up']);

    class Ticker extends MonoBehaviour {
      count = 0;
      tick() {
        if (++this.count === 3) this.cancelInvoke();
      }
    }
    const ticker = new GameObject('Ticker').addComponent(Ticker);
    ticker.invokeRepeating(ticker.tick, 0, 0.01);
    engine.stepFrames(10);
    expect(ticker.count).toBe(3);
  });

  test('a throwing wait condition ends that coroutine without stopping the frame', () => {
    engine.dispose();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      engine = Engine.createHeadless({ throwOnError: false });
      const log: string[] = [];
      class Waiter extends MonoBehaviour {
        target: { ready: boolean } | null = { ready: false };
        *run(): IEnumerator {
          yield new WaitUntil(() => (this.target as { ready: boolean }).ready);
        }
      }
      class Other extends MonoBehaviour {
        lateUpdate() {
          log.push('late');
        }
      }
      const waiter = new GameObject('Waiter').addComponent(Waiter);
      new GameObject('Other').addComponent(Other);
      const handle = waiter.startCoroutine(waiter.run());
      engine.step();
      waiter.target = null;
      const doomed = new GameObject('Doomed');
      destroy(doomed);
      engine.stepFrames(3);
      expect(handle.isDone).toBe(true);
      expect(log.length).toBe(4);
      expect(isAlive(doomed)).toBe(false);
      expect(errors.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  test('a coroutine cannot be started on a destroyed object', () => {
    let error: unknown = null;
    class Ghost extends MonoBehaviour {
      *haunt(): IEnumerator {
        yield null;
      }
      onDestroy() {
        try {
          this.startCoroutine(this.haunt());
        } catch (caught) {
          error = caught;
        }
      }
    }
    const ghost = new GameObject('Ghost').addComponent(Ghost);
    destroyImmediate(ghost.gameObject);
    expect(String(error)).toMatch(/destroyed/);
  });
});

describe('error handling in the frame', () => {
  test('destroying a Transform is refused immediately and does not affect other destroys', () => {
    const a = new GameObject('a');
    const b = new GameObject('b');
    expect(() => destroy(a.transform)).toThrow(/Destroy the GameObject instead/);
    destroy(b);
    engine.step();
    expect(isAlive(a)).toBe(true);
    expect(isAlive(b)).toBe(false);
  });

  test('one throwing start does not orphan the other scripts', async () => {
    const log: string[] = [];
    class Bad extends MonoBehaviour {
      start() {
        throw new Error('boom');
      }
    }
    class Good extends MonoBehaviour {
      start() {
        log.push('start');
      }
      update() {
        log.push('update');
      }
    }
    new GameObject('Bad').addComponent(Bad);
    new GameObject('Good').addComponent(Good);
    expect(() => engine.step()).toThrow(/boom/);
    // The failed frame is closed properly, so scene loads are not stuck behind it.
    SceneManager.register('Next', () => {});
    let resolved = false;
    void SceneManager.loadScene('Next', LoadSceneMode.Additive).then(() => {
      resolved = true;
    });
    await nextTask();
    expect(resolved).toBe(true);
    engine.stepFrames(2);
    expect(log).toContain('start');
    expect(log).toContain('update');
  });
});

describe('camera', () => {
  test('conversions follow the camera immediately after it moves', () => {
    const go = new GameObject('Main Camera');
    go.tag = 'MainCamera';
    const camera = go.addComponent(Camera);
    camera.orthographic = true;
    camera.orthographicSize = 5;
    camera.transform.position = new Vector3(0, 0, 10);
    const cube = GameObject.createPrimitive(PrimitiveType.Cube);
    cube.transform.position = new Vector3(7, 0, 0);
    const clicks: string[] = [];
    class Clickable extends MonoBehaviour {
      onMouseDown() {
        clicks.push(this.name);
      }
    }
    cube.addComponent(Clickable);
    engine.input.moveMouse(640, 360);
    engine.step();
    expect(camera.worldToScreenPoint(cube.transform.position).x).toBeGreaterThan(1000);

    camera.transform.position = new Vector3(7, 0, 10); // pan: the cube is now dead centre
    expect(camera.worldToScreenPoint(cube.transform.position).x).toBeCloseTo(640);
    expect(camera.screenPointToRay({ x: 640, y: 360 }).origin.x).toBeCloseTo(7);
    engine.input.pressMouseButton(0);
    engine.step();
    expect(clicks).toEqual(['Cube']);

    // Perspective too, and rotated.
    camera.orthographic = false;
    camera.transform.position = new Vector3(0, 5, 0);
    camera.transform.lookAt(Vector3.zero, Vector3.forward);
    const screen = camera.worldToScreenPoint(new Vector3(1, 0, -1));
    expect(camera.screenToWorldPoint(screen).equals(new Vector3(1, 0, -1), 1e-4)).toBe(true);
    const ray = camera.screenPointToRay(screen);
    expect(new Vector3(1, 0, -1).sub(ray.origin).normalized.equals(ray.direction, 1e-4)).toBe(true);
  });
});

describe('transform', () => {
  test('a mirrored (negative) scale is not mistaken for a rotation', () => {
    const parent = new GameObject('Parent');
    const flipped = new GameObject('Flipped');
    flipped.transform.localScale = new Vector3(1, -1, 1);
    expect(flipped.transform.rotation.equals(Quaternion.identity)).toBe(true);
    expect(flipped.transform.lossyScale.equals(new Vector3(1, -1, 1))).toBe(true);
    expect(flipped.transform.up.equals(Vector3.up)).toBe(true);

    const before = flipped.transform.transformPoint(new Vector3(1, 2, 3));
    flipped.transform.setParent(parent.transform);
    expect(flipped.transform.transformPoint(new Vector3(1, 2, 3)).equals(before)).toBe(true);
    expect(flipped.transform.localScale.equals(new Vector3(1, -1, 1))).toBe(true);

    // Rotating under a mirrored parent keeps world rotation consistent.
    const mirror = new GameObject('Mirror');
    mirror.transform.localScale = new Vector3(-1, 1, 1);
    const child = new GameObject('Child');
    child.transform.setParent(mirror.transform, false);
    child.transform.rotation = Quaternion.euler(0, 30, 0);
    expect(child.transform.rotation.equals(Quaternion.euler(0, 30, 0))).toBe(true);
    child.transform.rotate(Vector3.up, 0, Space.World);
    expect(child.transform.rotation.equals(Quaternion.euler(0, 30, 0))).toBe(true);
  });

  test('a mirrored box collider reports the face that was actually hit', () => {
    const box = new GameObject('Box');
    box.transform.localScale = new Vector3(-1, 1, 1);
    box.addComponent(BoxCollider);
    expect(Physics.raycast(new Vector3(5, 0, 0), Vector3.left)?.normal.equals(Vector3.right)).toBe(true);
    expect(Physics.raycast(new Vector3(-5, 0, 0), Vector3.right)?.normal.equals(Vector3.left)).toBe(true);
  });

  test("translate moves in world units along the object's own axes, whatever the parent scale", () => {
    const board = new GameObject('Board');
    board.transform.localScale = new Vector3(2, 2, 2);
    const unit = new GameObject('Unit');
    unit.transform.setParent(board.transform, false);
    unit.transform.eulerAngles = new Vector3(0, 90, 0);
    unit.transform.translate(Vector3.forward);
    expect(unit.transform.position.equals(Vector3.left, 1e-4)).toBe(true);
    unit.transform.translate(Vector3.up.mul(3), Space.World);
    expect(unit.transform.position.equals(new Vector3(-1, 3, 0), 1e-4)).toBe(true);
  });
});

describe('instantiate', () => {
  test('nested plain data is copied, not shared', () => {
    class Unit extends MonoBehaviour {
      stats = { hp: 10, resist: { fire: 1 } };
      path = [{ x: 1 }, { x: 2 }];
      home = new Vector3(1, 2, 3);
    }
    const original = new GameObject('Unit').addComponent(Unit);
    const copy = instantiate(original);
    copy.stats.resist.fire = 99;
    (copy.path[0] as { x: number }).x = 99;
    expect(original.stats.resist.fire).toBe(1);
    expect(original.path[0]?.x).toBe(1);
    // Immutable values are safely shared.
    expect(copy.home).toBe(original.home);
  });
});
