import { afterEach, describe, expect, test } from 'bun:test';
import { Engine, GameObject, instantiate, LoadSceneMode, MonoBehaviour, Prefab, SceneManager, Time } from '../src';

class Clock extends MonoBehaviour {
  elapsed = 0;
  frames = 0;
  update() {
    this.elapsed += Time.deltaTime;
    this.frames = Time.frameCount;
  }
}

const ClockPrefab = new Prefab('Clock', (go) => {
  go.addComponent(Clock);
});

const engines: Engine[] = [];
function create(): Engine {
  const engine = Engine.createHeadless();
  engines.push(engine);
  return engine;
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

// A game has one engine. Tests that simulate several machines (a host and a client) in
// one process need each engine's scripts to see that engine's own clock and scene.
describe('several engines in one process', () => {
  test('stepping an engine makes it the current one, so its scripts read its own Time', () => {
    const a = create();
    const clockA = a.run(() => new GameObject('A').addComponent(Clock));
    const b = create();
    const clockB = b.run(() => new GameObject('B').addComponent(Clock));

    a.step(0.1);
    a.step(0.1);
    b.step(0.5);

    expect(clockA.elapsed).toBeCloseTo(0.2, 6);
    expect(clockA.frames).toBe(2);
    expect(clockB.elapsed).toBeCloseTo(0.5, 6);
    expect(clockB.frames).toBe(1);
  });

  test('run() creates objects in the given engine and puts the previous one back', () => {
    const a = create();
    const b = create(); // b is the most recently created, hence current
    const made = a.run(() => instantiate(ClockPrefab));
    const other = instantiate(ClockPrefab);

    expect(Engine.current).toBe(b);
    a.step(0.25);
    b.step(0.75);
    expect(made.getComponent(Clock)?.elapsed).toBeCloseTo(0.25, 6);
    expect(other.getComponent(Clock)?.elapsed).toBeCloseTo(0.75, 6);
  });

  test('run() returns the action result, restores on a throw, and nests', () => {
    const a = create();
    const b = create();
    expect(a.run(() => Engine.current === a)).toBe(true);
    expect(() =>
      a.run(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(Engine.current).toBe(b);
    expect(a.run(() => b.run(() => Engine.current === b) && Engine.current === a)).toBe(true);
  });

  test("disposing an engine runs its scripts' onDestroy against that engine, not the newest one", () => {
    const seen: (Engine | null)[] = [];
    class Remember extends MonoBehaviour {
      onDestroy() {
        seen.push(Engine.current);
      }
    }
    const a = create();
    a.run(() => new GameObject('A').addComponent(Remember));
    const b = create();
    a.dispose();
    expect(seen).toEqual([a]);
    expect(Engine.current).toBe(b); // b was current before, and is again
  });

  test('a scene that finishes loading after an await is built in the engine that asked for it', async () => {
    const woke: (Engine | null)[] = [];
    class Marker extends MonoBehaviour {
      awake() {
        woke.push(Engine.current);
      }
    }
    let assetsReady: (value: string) => void = () => {};
    SceneManager.register('LoadedLater', {
      preload: () => new Promise<string>((resolve) => (assetsReady = resolve)),
      build: (_scene, name) => {
        new GameObject(name).addComponent(Marker);
      },
    });
    let queuedBuilt: Engine | null = null;
    SceneManager.register('QueuedBehind', () => {
      queuedBuilt = Engine.current;
      new GameObject('Second');
    });

    const a = create();
    const loading = a.run(() => SceneManager.loadScene('LoadedLater'));
    const queued = a.run(() => SceneManager.loadScene('QueuedBehind', LoadSceneMode.Additive));
    const b = create(); // by the time the assets arrive, another engine is the current one
    assetsReady('Late');
    const scene = await loading;

    expect(scene.getRootGameObjects().map((go) => go.name)).toEqual(['Late']);
    expect(woke).toEqual([a]);
    expect(b.run(() => GameObject.find('Late'))).toBeNull();
    // The load that was waiting behind it starts from the same promise, also in A.
    await queued;
    expect(queuedBuilt === a).toBe(true);
    expect(a.run(() => GameObject.find('Second'))).not.toBeNull();
    expect(b.run(() => GameObject.find('Second'))).toBeNull();
    expect(Engine.current).toBe(b);
  });

  test('a scene whose engine was disposed while it loaded is dropped quietly', async () => {
    let built = false;
    let assetsReady: () => void = () => {};
    SceneManager.register('NeverBuilt', {
      preload: () => new Promise<void>((resolve) => (assetsReady = resolve)),
      build: () => {
        built = true;
      },
    });
    const a = create();
    const loading = a.run(() => SceneManager.loadScene('NeverBuilt'));
    const b = create();
    a.dispose();
    assetsReady();
    await loading;
    expect(built).toBe(false);
    expect(Engine.current).toBe(b);
  });

  test('a disposed engine is not left behind as the current one', () => {
    const a = create();
    a.run(() => a.dispose());
    expect(Engine.current).toBeNull();
    const b = create();
    expect(b.run(() => Engine.current)).toBe(b);
  });
});
