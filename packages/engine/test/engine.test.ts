import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BoxCollider,
  Camera,
  Color,
  destroy,
  destroyImmediate,
  dontDestroyOnLoad,
  Engine,
  findObjectOfType,
  findObjectsOfType,
  GameObject,
  type IEnumerator,
  Input,
  instantiate,
  isAlive,
  KeyCode,
  LayerMask,
  Light,
  LightType,
  LoadSceneMode,
  Material,
  Mesh,
  MeshFilter,
  MeshRenderer,
  MonoBehaviour,
  Physics,
  Prefab,
  PrimitiveType,
  Quaternion,
  Ray,
  SceneManager,
  Space,
  Time,
  Vector3,
  WaitForEndOfFrame,
  WaitForFixedUpdate,
  WaitForSeconds,
  WaitUntil,
} from '../src';

let engine: Engine;
let log: string[] = [];

beforeEach(() => {
  engine = Engine.createHeadless();
  log = [];
});

afterEach(() => {
  engine.dispose();
});

/** Records every lifecycle message it receives. */
class Recorder extends MonoBehaviour {
  label = 'r';
  awake() {
    log.push(`${this.label}.awake`);
  }
  onEnable() {
    log.push(`${this.label}.onEnable`);
  }
  start() {
    log.push(`${this.label}.start`);
  }
  update() {
    log.push(`${this.label}.update`);
  }
  lateUpdate() {
    log.push(`${this.label}.lateUpdate`);
  }
  onDisable() {
    log.push(`${this.label}.onDisable`);
  }
  onDestroy() {
    log.push(`${this.label}.onDestroy`);
  }
}

describe('MonoBehaviour lifecycle', () => {
  test('awake and onEnable run on addComponent, start before the first update', () => {
    const go = new GameObject('A');
    go.addComponent(Recorder);
    expect(log).toEqual(['r.awake', 'r.onEnable']);
    engine.step();
    expect(log).toEqual(['r.awake', 'r.onEnable', 'r.start', 'r.update', 'r.lateUpdate']);
    engine.step();
    expect(log.slice(5)).toEqual(['r.update', 'r.lateUpdate']);
  });

  test('inactive objects do not wake until activated', () => {
    const go = new GameObject('A');
    go.setActive(false);
    go.addComponent(Recorder);
    engine.step();
    expect(log).toEqual([]);
    go.setActive(true);
    expect(log).toEqual(['r.awake', 'r.onEnable']);
    engine.step();
    expect(log).toContain('r.start');
  });

  test('enabled and setActive send onEnable/onDisable and gate update', () => {
    const go = new GameObject('A');
    const recorder = go.addComponent(Recorder);
    engine.step();
    log = [];
    recorder.enabled = false;
    engine.step();
    expect(log).toEqual(['r.onDisable']);
    recorder.enabled = true;
    go.setActive(false);
    engine.step();
    expect(log).toEqual(['r.onDisable', 'r.onEnable', 'r.onDisable']);
    expect(recorder.isActiveAndEnabled).toBe(false);
  });

  test('deactivating a parent disables scripts on children', () => {
    const parent = new GameObject('Parent');
    const child = new GameObject('Child');
    child.transform.parent = parent.transform;
    child.addComponent(Recorder);
    log = [];
    parent.setActive(false);
    expect(child.activeSelf).toBe(true);
    expect(child.activeInHierarchy).toBe(false);
    expect(log).toEqual(['r.onDisable']);
    parent.setActive(true);
    expect(log).toEqual(['r.onDisable', 'r.onEnable']);
  });

  test('re-parenting under an inactive object disables scripts', () => {
    const inactive = new GameObject('Inactive');
    inactive.setActive(false);
    const child = new GameObject('Child');
    child.addComponent(Recorder);
    log = [];
    child.transform.setParent(inactive.transform);
    expect(log).toEqual(['r.onDisable']);
    child.transform.setParent(null);
    expect(log).toEqual(['r.onDisable', 'r.onEnable']);
  });

  test('destroy is deferred to the end of the frame and sends onDisable then onDestroy', () => {
    const go = new GameObject('A');
    go.addComponent(Recorder);
    engine.step();
    log = [];
    destroy(go);
    expect(isAlive(go)).toBe(true);
    engine.step();
    expect(log).toEqual(['r.update', 'r.lateUpdate', 'r.onDisable', 'r.onDestroy']);
    expect(isAlive(go)).toBe(false);
    expect(GameObject.find('A')).toBeNull();
    engine.step();
    expect(log.length).toBe(4);
  });

  test('destroy with a delay, and destroying a single component', () => {
    const go = new GameObject('A');
    const recorder = go.addComponent(Recorder);
    destroy(recorder, 0.5);
    engine.stepSeconds(0.4);
    expect(isAlive(recorder)).toBe(true);
    engine.stepSeconds(0.2);
    expect(isAlive(recorder)).toBe(false);
    expect(isAlive(go)).toBe(true);
    expect(go.getComponent(Recorder)).toBeNull();
    expect(() => destroyImmediate(go.transform)).toThrow();
  });

  test('destroying a parent destroys children', () => {
    const parent = new GameObject('Parent');
    const child = new GameObject('Child');
    child.transform.parent = parent.transform;
    child.addComponent(Recorder);
    destroyImmediate(parent);
    expect(isAlive(child)).toBe(false);
    expect(log).toContain('r.onDestroy');
  });

  test('fixedUpdate runs on a fixed timestep with Time.deltaTime = fixedDeltaTime', () => {
    const deltas: number[] = [];
    class Fixed extends MonoBehaviour {
      fixedUpdate() {
        deltas.push(Time.deltaTime);
      }
    }
    new GameObject('A').addComponent(Fixed);
    engine.step(0.05); // 2 steps of 0.02, 0.01 left over
    expect(deltas).toEqual([0.02, 0.02]);
    engine.step(0.01); // carries over to exactly one more step
    expect(deltas.length).toBe(3);
  });

  test('Time advances and respects timeScale', () => {
    engine.step(0.1);
    expect(Time.deltaTime).toBeCloseTo(0.1);
    expect(Time.frameCount).toBe(1);
    Time.timeScale = 0.5;
    engine.step(0.1);
    expect(Time.deltaTime).toBeCloseTo(0.05);
    expect(Time.unscaledDeltaTime).toBeCloseTo(0.1);
    expect(Time.time).toBeCloseTo(0.15);
    expect(Time.unscaledTime).toBeCloseTo(0.2);
  });

  test('components cannot be constructed with new', () => {
    expect(() => new (Recorder as unknown as new () => Recorder)()).toThrow(/addComponent/);
  });

  test('script exceptions surface in headless mode with context', () => {
    class Broken extends MonoBehaviour {
      update() {
        throw new Error('boom');
      }
    }
    new GameObject('Bad').addComponent(Broken);
    expect(() => engine.step()).toThrow(/boom.*Broken\.update.*Bad/);
  });

  test('requireComponents and disallowMultiple', () => {
    class Body extends MonoBehaviour {
      static readonly disallowMultiple = true;
    }
    class Mover extends MonoBehaviour {
      static readonly requireComponents = [Body];
    }
    const go = new GameObject('A');
    go.addComponent(Mover);
    expect(go.getComponent(Body)).not.toBeNull();
    expect(() => go.addComponent(Body)).toThrow(/only one/);
  });
});

describe('Coroutines', () => {
  class Routines extends MonoBehaviour {
    *sequence(): IEnumerator {
      log.push('begin');
      yield null;
      log.push('next frame');
      yield new WaitForSeconds(0.1);
      log.push('after wait');
      yield* this.nested();
      yield this.nested();
      log.push('end');
    }
    *nested(): IEnumerator {
      log.push('nested');
      yield null;
    }
  }

  test('yield null, WaitForSeconds and nested generators', () => {
    const routines = new GameObject('A').addComponent(Routines);
    const handle = routines.startCoroutine(routines.sequence());
    expect(log).toEqual(['begin']);
    engine.step(0.05);
    expect(log).toEqual(['begin', 'next frame']);
    engine.step(0.05);
    expect(log).toEqual(['begin', 'next frame']);
    engine.step(0.05);
    expect(log).toEqual(['begin', 'next frame', 'after wait', 'nested']);
    engine.step(0.05);
    expect(log.slice(4)).toEqual(['nested']);
    engine.step(0.05);
    expect(log.at(-1)).toBe('end');
    expect(handle.isDone).toBe(true);
  });

  test('WaitUntil, WaitForEndOfFrame, WaitForFixedUpdate and waiting on another coroutine', () => {
    let flag = false;
    class More extends MonoBehaviour {
      *main(): IEnumerator {
        yield new WaitUntil(() => flag);
        log.push('flag');
        yield new WaitForEndOfFrame();
        log.push('end of frame');
        yield new WaitForFixedUpdate();
        log.push('fixed');
        yield this.startCoroutine(this.child());
        log.push('child done');
      }
      *child(): IEnumerator {
        yield new WaitForSeconds(0.05);
      }
    }
    const more = new GameObject('A').addComponent(More);
    more.startCoroutine(more.main());
    engine.step(0.02);
    expect(log).toEqual([]);
    flag = true;
    engine.step(0.02);
    expect(log).toEqual(['flag', 'end of frame']);
    engine.step(0.02);
    expect(log).toEqual(['flag', 'end of frame', 'fixed']);
    engine.stepSeconds(0.1);
    expect(log.at(-1)).toBe('child done');
  });

  test('a coroutine can wait on a promise', async () => {
    class Async extends MonoBehaviour {
      *main(): IEnumerator {
        yield Promise.resolve();
        log.push('resolved');
      }
    }
    const behaviour = new GameObject('A').addComponent(Async);
    behaviour.startCoroutine(behaviour.main());
    engine.step();
    await Promise.resolve();
    engine.step();
    expect(log).toEqual(['resolved']);
  });

  test('coroutines stop when the object is deactivated or stopCoroutine is called', () => {
    const routines = new GameObject('A').addComponent(Routines);
    routines.startCoroutine(routines.sequence());
    routines.gameObject.setActive(false);
    routines.gameObject.setActive(true);
    engine.stepSeconds(1);
    expect(log).toEqual(['begin']);
    const handle = routines.startCoroutine(routines.sequence());
    routines.stopCoroutine(handle);
    engine.stepSeconds(1);
    expect(log).toEqual(['begin', 'begin']);
    routines.gameObject.setActive(false);
    expect(() => routines.startCoroutine(routines.sequence())).toThrow(/inactive/);
  });

  test('invoke, invokeRepeating and cancelInvoke', () => {
    class Timer extends MonoBehaviour {
      count = 0;
      tick() {
        this.count++;
      }
    }
    const timer = new GameObject('A').addComponent(Timer);
    timer.invoke(timer.tick, 0.1);
    engine.stepSeconds(0.05);
    expect(timer.count).toBe(0);
    engine.stepSeconds(0.1);
    expect(timer.count).toBe(1);
    expect(timer.isInvoking()).toBe(false);
    timer.invokeRepeating(timer.tick, 0, 0.1);
    engine.stepSeconds(0.35);
    expect(timer.count).toBeGreaterThanOrEqual(4);
    timer.cancelInvoke();
    const before = timer.count;
    engine.stepSeconds(0.5);
    expect(timer.count).toBe(before);
  });
});

describe('Transform', () => {
  test('position, rotation and directions', () => {
    const t = new GameObject('A').transform;
    t.position = new Vector3(1, 2, 3);
    expect(t.position.equals(new Vector3(1, 2, 3))).toBe(true);
    expect(t.forward.equals(Vector3.forward)).toBe(true);
    t.eulerAngles = new Vector3(0, 90, 0);
    expect(t.forward.equals(Vector3.left, 1e-4)).toBe(true);
    t.translate(Vector3.forward.mul(2));
    expect(t.position.equals(new Vector3(-1, 2, 3), 1e-4)).toBe(true);
    t.translate(Vector3.up, Space.World);
    expect(t.position.y).toBeCloseTo(3);
  });

  test('rotate overloads: eulers vs axis-angle', () => {
    const t = new GameObject('A').transform;
    t.rotate(Vector3.up, 1);
    expect(t.rotation.equals(Quaternion.angleAxis(1, Vector3.up))).toBe(true);
    t.rotation = Quaternion.identity;
    t.rotate(new Vector3(0, 90, 0));
    expect(t.eulerAngles.y).toBeCloseTo(90, 3);
    t.rotate(new Vector3(0, 90, 0), Space.World);
    expect(t.forward.equals(Vector3.back, 1e-4)).toBe(true);
  });

  test('parenting keeps world position by default', () => {
    const parent = new GameObject('Parent').transform;
    parent.position = new Vector3(10, 0, 0);
    parent.localScale = new Vector3(2, 2, 2);
    const child = new GameObject('Child').transform;
    child.position = new Vector3(12, 0, 0);
    child.parent = parent;
    expect(child.position.equals(new Vector3(12, 0, 0), 1e-4)).toBe(true);
    expect(child.localPosition.equals(new Vector3(1, 0, 0), 1e-4)).toBe(true);
    expect(child.lossyScale.equals(Vector3.one, 1e-4)).toBe(true);
    child.setParent(null, false);
    expect(child.position.equals(new Vector3(1, 0, 0), 1e-4)).toBe(true);
    expect(child.parent).toBeNull();
  });

  test('hierarchy queries', () => {
    const root = new GameObject('Root').transform;
    const a = new GameObject('A').transform;
    const b = new GameObject('B').transform;
    a.parent = root;
    b.parent = a;
    expect(root.childCount).toBe(1);
    expect(root.getChild(0)).toBe(a);
    expect(root.find('A/B')).toBe(b);
    expect(root.find('Missing')).toBeNull();
    expect(b.root).toBe(root);
    expect(b.isChildOf(root)).toBe(true);
    expect([...root].map((child) => child.name)).toEqual(['A']);
    expect(() => root.setParent(b)).toThrow();
    expect(GameObject.find('Root/A/B')).toBe(b.gameObject);
  });

  test('lookAt, rotateAround and space conversion', () => {
    const t = new GameObject('A').transform;
    t.lookAt(new Vector3(5, 0, 0));
    expect(t.forward.equals(Vector3.right, 1e-4)).toBe(true);
    t.rotation = Quaternion.identity;
    t.position = new Vector3(1, 0, 0);
    t.rotateAround(Vector3.zero, Vector3.up, 90);
    expect(t.position.equals(new Vector3(0, 0, -1), 1e-4)).toBe(true);
    t.localScale = new Vector3(2, 2, 2);
    const world = t.transformPoint(new Vector3(1, 0, 0));
    expect(t.inverseTransformPoint(world).equals(new Vector3(1, 0, 0), 1e-4)).toBe(true);
    expect(t.inverseTransformDirection(t.transformDirection(Vector3.up)).equals(Vector3.up, 1e-4)).toBe(true);
  });
});

describe('GameObject queries', () => {
  class Marker extends MonoBehaviour {}

  test('getComponent family', () => {
    const root = new GameObject('Root');
    const child = new GameObject('Child');
    child.transform.parent = root.transform;
    const marker = child.addComponent(Marker);
    expect(root.getComponent(Marker)).toBeNull();
    expect(root.getComponentInChildren(Marker)).toBe(marker);
    expect(child.getComponentInParent(Marker)).toBe(marker);
    child.setActive(false);
    expect(root.getComponentInChildren(Marker)).toBeNull();
    expect(root.getComponentInChildren(Marker, true)).toBe(marker);
    // Base-class lookups work, as in Unity.
    expect(child.getComponent(MonoBehaviour)).toBe(marker);
  });

  test('find by name, tag and type', () => {
    const a = new GameObject('Alpha');
    a.tag = 'Enemy';
    const b = new GameObject('Beta', Marker);
    b.tag = 'Enemy';
    expect(GameObject.find('Alpha')).toBe(a);
    expect(GameObject.findGameObjectsWithTag('Enemy')).toEqual([a, b]);
    expect(findObjectOfType(Marker)).toBe(b.getComponent(Marker));
    b.setActive(false);
    expect(GameObject.findWithTag('Enemy')).toBe(a);
    expect(GameObject.find('Beta')).toBeNull();
    expect(findObjectsOfType(Marker)).toEqual([]);
  });
});

describe('instantiate and prefabs', () => {
  class Stats extends MonoBehaviour {
    health = 10;
    target: GameObject | null = null;
    tags: string[] = [];
    _scratch = 0;
    seenInAwake = -1;
    awake() {
      this.seenInAwake = this.health;
    }
  }

  test('cloning copies fields, children and remaps internal references', () => {
    const original = new GameObject('Unit');
    const child = new GameObject('Weapon');
    child.transform.parent = original.transform;
    const stats = original.addComponent(Stats);
    stats.health = 42;
    stats.target = child;
    stats.tags.push('melee');
    stats._scratch = 7;
    original.tag = 'Player';
    original.layer = 3;

    const copy = instantiate(original, new Vector3(5, 0, 0));
    const copyStats = copy.getComponent(Stats) as Stats;
    expect(copy.name).toBe('Unit(Clone)');
    expect(copy.tag).toBe('Player');
    expect(copy.layer).toBe(3);
    expect(copy.transform.position.equals(new Vector3(5, 0, 0))).toBe(true);
    expect(copyStats).not.toBe(stats);
    expect(copyStats.health).toBe(42);
    // Values are in place before awake runs, like serialized fields.
    expect(copyStats.seenInAwake).toBe(42);
    expect(copyStats.tags).toEqual(['melee']);
    expect(copyStats.tags).not.toBe(stats.tags);
    // Underscore fields are not copied.
    expect(copyStats._scratch).toBe(0);
    // The reference to the child now points at the clone's child.
    expect(copyStats.target).toBe(copy.transform.getChild(0).gameObject);
    expect(copyStats.target).not.toBe(child);
  });

  test('instantiating a component returns the matching component', () => {
    const stats = new GameObject('Unit').addComponent(Stats);
    const copy = instantiate(stats);
    expect(copy).toBeInstanceOf(Stats);
    expect(copy.gameObject).not.toBe(stats.gameObject);
  });

  test('primitives clone with their renderer and collider', () => {
    const cube = GameObject.createPrimitive(PrimitiveType.Cube);
    const red = new Material();
    red.color = Color.red;
    (cube.getComponent(MeshRenderer) as MeshRenderer).sharedMaterial = red;
    const copy = instantiate(cube);
    const renderer = copy.getComponent(MeshRenderer) as MeshRenderer;
    expect(copy.getComponents(MeshRenderer).length).toBe(1);
    expect(copy.getComponent(MeshFilter)?.mesh).toBe(Mesh.primitive(PrimitiveType.Cube));
    expect(copy.getComponent(BoxCollider)).not.toBeNull();
    expect(renderer.sharedMaterial).toBe(red);
    // Asking for `.material` gives the clone its own copy.
    renderer.material.color = Color.blue;
    expect(red.color.equals(Color.red)).toBe(true);
    expect(renderer.sharedMaterial).not.toBe(red);
  });

  test('prefabs build a fresh object and wake scripts after the build', () => {
    const order: string[] = [];
    class Late extends MonoBehaviour {
      awake() {
        order.push(`awake sees ${this.gameObject.getComponents(MonoBehaviour).length} scripts`);
      }
    }
    const prefab = new Prefab('Soldier', (go) => {
      go.addComponent(Late);
      go.addComponent(Stats).health = 3;
      order.push('built');
    });
    const parent = new GameObject('Squad');
    const soldier = instantiate(prefab, new Vector3(1, 0, 0), Quaternion.identity, parent.transform);
    expect(order).toEqual(['built', 'awake sees 2 scripts']);
    expect(soldier.name).toBe('Soldier');
    expect(soldier.transform.parent).toBe(parent.transform);
    expect((soldier.getComponent(Stats) as Stats).seenInAwake).toBe(3);
  });
});

describe('Scenes', () => {
  test('loadScene builds the scene, then wakes scripts; single mode replaces the previous scene', async () => {
    class Boot extends MonoBehaviour {
      awake() {
        log.push(`awake with ${this.gameObject.scene.rootCount} roots`);
      }
    }
    SceneManager.register('Menu', () => {
      new GameObject('MenuRoot').addComponent(Boot);
      new GameObject('Other');
    });
    SceneManager.register('Game', async () => {
      await Promise.resolve();
      new GameObject('GameRoot');
    });
    const keep = new GameObject('Music');
    dontDestroyOnLoad(keep);
    const stale = new GameObject('Stale');

    const menu = await SceneManager.loadScene('Menu');
    expect(log).toEqual(['awake with 2 roots']);
    expect(SceneManager.getActiveScene()).toBe(menu);
    expect(isAlive(stale)).toBe(false);
    expect(isAlive(keep)).toBe(true);
    expect(GameObject.find('MenuRoot')?.scene).toBe(menu);

    const game = await SceneManager.loadScene('Game');
    expect(GameObject.find('MenuRoot')).toBeNull();
    expect(GameObject.find('GameRoot')?.scene).toBe(game);
    expect(GameObject.find('Music')).toBe(keep);
    expect(SceneManager.sceneCount).toBe(1);

    await SceneManager.loadScene('Menu', LoadSceneMode.Additive);
    expect(SceneManager.sceneCount).toBe(2);
    expect(SceneManager.getActiveScene()).toBe(game);
    SceneManager.unloadScene('Menu');
    expect(GameObject.find('MenuRoot')).toBeNull();
  });

  test('a synchronous scene is ready as soon as loadScene returns', () => {
    SceneManager.register('Sync', () => {
      new GameObject('Ready').addComponent(Recorder);
    });
    void SceneManager.loadScene('Sync');
    expect(log).toEqual(['r.awake', 'r.onEnable']);
  });

  test('loading during a frame is deferred to the end of that frame', async () => {
    SceneManager.register('Next', () => {
      new GameObject('NextRoot');
    });
    class Switcher extends MonoBehaviour {
      update() {
        void SceneManager.loadScene('Next');
        log.push(`still here: ${GameObject.find('Switcher') !== null}`);
      }
    }
    new GameObject('Switcher').addComponent(Switcher);
    engine.step();
    expect(log).toEqual(['still here: true']);
    expect(GameObject.find('Switcher')).toBeNull();
    expect(GameObject.find('NextRoot')).not.toBeNull();
  });

  test('unknown scenes reject with the list of registered names', async () => {
    expect(SceneManager.loadScene('Nope')).rejects.toThrow(/not registered/);
  });
});

describe('Input', () => {
  test('down/up edges last exactly one frame', () => {
    const seen: string[] = [];
    class Listener extends MonoBehaviour {
      update() {
        if (Input.getKeyDown(KeyCode.Space)) seen.push('down');
        if (Input.getKey(KeyCode.Space)) seen.push('held');
        if (Input.getKeyUp(KeyCode.Space)) seen.push('up');
      }
    }
    new GameObject('A').addComponent(Listener);
    engine.input.pressKey(KeyCode.Space);
    engine.step();
    engine.step();
    engine.input.releaseKey(KeyCode.Space);
    engine.step();
    engine.step();
    expect(seen).toEqual(['down', 'held', 'held', 'up']);
  });

  test('axes, buttons and mouse', () => {
    engine.input.pressKey(KeyCode.D);
    engine.step(0.1);
    expect(Input.getAxisRaw('Horizontal')).toBe(1);
    expect(Input.getAxis('Horizontal')).toBeCloseTo(0.3);
    engine.input.pressKey(KeyCode.A);
    engine.step(0.1);
    expect(Input.getAxisRaw('Horizontal')).toBe(0);
    Input.defineButton('Select', [KeyCode.E], [0]);
    const edges: boolean[] = [];
    class Probe extends MonoBehaviour {
      update() {
        edges.push(Input.getButtonDown('Select'), Input.getMouseButtonDown(0));
      }
    }
    new GameObject('Probe').addComponent(Probe);
    engine.input.moveMouse(100, 50);
    engine.input.moveMouse(110, 70);
    engine.input.pressMouseButton(0);
    engine.input.scroll(0, 1);
    engine.step();
    // Edges are only visible during the frame; afterwards they are gone.
    expect(edges).toEqual([true, true]);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.mousePosition.equals(new Vector3(110, 70, 0))).toBe(true);
    expect(Input.mousePositionDelta.x).toBe(10);
    expect(Input.mouseScrollDelta.y).toBe(1);
    expect(Input.getAxis('Mouse ScrollWheel')).toBe(1);
    expect(() => Input.getAxis('Nope')).toThrow(/defineAxis/);
  });
});

describe('Camera', () => {
  function makeCamera(): Camera {
    const go = new GameObject('Main Camera', Camera);
    go.tag = 'MainCamera';
    go.transform.position = new Vector3(0, 0, 10);
    return go.getComponent(Camera) as Camera;
  }

  test('Camera.main and defaults', () => {
    expect(Camera.main).toBeNull();
    const camera = makeCamera();
    expect(Camera.main).toBe(camera);
    expect(camera.fieldOfView).toBe(60);
    camera.enabled = false;
    expect(Camera.main).toBeNull();
  });

  test('screen <-> world conversions agree (top-left origin)', () => {
    const camera = makeCamera();
    const center = camera.worldToScreenPoint(Vector3.zero);
    expect(center.x).toBeCloseTo(640);
    expect(center.y).toBeCloseTo(360);
    expect(center.z).toBeCloseTo(10);
    // A point up and to the right appears right of and ABOVE centre (smaller y).
    const upRight = camera.worldToScreenPoint(new Vector3(2, 1, 0));
    expect(upRight.x).toBeGreaterThan(640);
    expect(upRight.y).toBeLessThan(360);
    expect(camera.screenToWorldPoint(upRight).equals(new Vector3(2, 1, 0), 1e-3)).toBe(true);
    // Points behind the camera report negative depth.
    expect(camera.worldToScreenPoint(new Vector3(0, 0, 20)).z).toBeLessThan(0);
  });

  test('screenPointToRay goes through the matching world point', () => {
    const camera = makeCamera();
    const target = new Vector3(3, -2, -4);
    const ray = camera.screenPointToRay(camera.worldToScreenPoint(target));
    const along = target.sub(ray.origin);
    expect(along.normalized.equals(ray.direction, 1e-3)).toBe(true);
    camera.orthographic = true;
    camera.orthographicSize = 5;
    const orthoRay = camera.screenPointToRay({ x: 640, y: 0 });
    expect(orthoRay.direction.equals(Vector3.forward, 1e-4)).toBe(true);
    expect(orthoRay.origin.y).toBeCloseTo(5, 2);
  });

  test('aspect follows a non-16:9 headless view', () => {
    engine.dispose();
    engine = Engine.createHeadless({ width: 500, height: 1000 });
    const camera = makeCamera();
    expect(camera.aspect).toBe(0.5);
    const p = camera.worldToScreenPoint(new Vector3(1, 1, 0));
    expect(camera.screenToWorldPoint(p).equals(new Vector3(1, 1, 0), 1e-3)).toBe(true);
    const ray = camera.screenPointToRay(p);
    expect(new Vector3(1, 1, 0).sub(ray.origin).normalized.equals(ray.direction, 1e-3)).toBe(true);
  });
});

describe('Physics queries', () => {
  test('raycast returns the nearest hit with point and normal', () => {
    const near = GameObject.createPrimitive(PrimitiveType.Cube);
    near.name = 'Near';
    near.transform.position = new Vector3(0, 0, -5);
    const far = GameObject.createPrimitive(PrimitiveType.Sphere);
    far.transform.position = new Vector3(0, 0, -10);

    const hit = Physics.raycast(Vector3.zero, Vector3.forward);
    expect(hit?.gameObject).toBe(near);
    expect(hit?.distance).toBeCloseTo(4.5);
    expect(hit?.point.equals(new Vector3(0, 0, -4.5), 1e-4)).toBe(true);
    expect(hit?.normal.equals(Vector3.back, 1e-4)).toBe(true);

    const all = Physics.raycastAll(new Ray(Vector3.zero, Vector3.forward));
    expect(all.map((h) => h.gameObject)).toEqual([near, far]);
    expect(all[1]?.distance).toBeCloseTo(9.5);
    expect(Physics.raycast(Vector3.zero, Vector3.forward, 3)).toBeNull();
    expect(Physics.raycast(Vector3.zero, Vector3.back)).toBeNull();
  });

  test('rotated and scaled boxes, capsules, layers and disabled colliders', () => {
    const wall = GameObject.createPrimitive(PrimitiveType.Cube);
    wall.transform.position = new Vector3(5, 0, 0);
    wall.transform.localScale = new Vector3(2, 4, 4);
    wall.transform.eulerAngles = new Vector3(0, 0, 90);
    // After a 90 degree roll the 4-unit Y extent lies along world X.
    const hit = Physics.raycast(Vector3.zero, Vector3.right);
    expect(hit?.distance).toBeCloseTo(3);
    expect(hit?.normal.equals(Vector3.left, 1e-4)).toBe(true);

    const capsule = GameObject.createPrimitive(PrimitiveType.Capsule);
    capsule.transform.position = new Vector3(0, 0, 5);
    expect(Physics.raycast(Vector3.zero, Vector3.back)?.distance).toBeCloseTo(4.5);
    expect(Physics.raycast(new Vector3(0, 5, 5), Vector3.down)?.distance).toBeCloseTo(4);
    expect(Physics.raycast(new Vector3(0, 1.2, 0), Vector3.back)).toBeNull();

    LayerMask.define(8, 'Units');
    capsule.layer = LayerMask.nameToLayer('Units');
    expect(Physics.raycast(Vector3.zero, Vector3.back, 100, LayerMask.getMask('Default'))).toBeNull();
    expect(Physics.raycast(Vector3.zero, Vector3.back, 100, LayerMask.getMask('Units'))?.gameObject).toBe(capsule);
    capsule.layer = 2; // Ignore Raycast
    expect(Physics.raycast(Vector3.zero, Vector3.back)).toBeNull();
    capsule.layer = 0;
    capsule.setActive(false);
    expect(Physics.raycast(Vector3.zero, Vector3.back)).toBeNull();
  });

  test('a plane primitive is clickable and overlapSphere finds neighbours', () => {
    const ground = GameObject.createPrimitive(PrimitiveType.Plane);
    const hit = Physics.raycast(new Vector3(4, 10, -4), Vector3.down);
    expect(hit?.gameObject).toBe(ground);
    expect(hit?.point.equals(new Vector3(4, 0, -4), 1e-4)).toBe(true);
    expect(Physics.raycast(new Vector3(6, 10, 0), Vector3.down)).toBeNull();
    const unit = GameObject.createPrimitive(PrimitiveType.Sphere);
    unit.transform.position = new Vector3(3, 0.5, 0);
    const found = Physics.overlapSphere(new Vector3(2, 0.5, 0), 0.6).map((c) => c.gameObject);
    expect(found).toContain(unit);
    expect(Physics.checkSphere(new Vector3(0, 50, 0), 1)).toBe(false);
  });

  test('onMouse messages follow the pointer', () => {
    const events: string[] = [];
    class Clickable extends MonoBehaviour {
      onMouseEnter() {
        events.push('enter');
      }
      onMouseExit() {
        events.push('exit');
      }
      onMouseDown() {
        events.push('down');
      }
      onMouseUp() {
        events.push('up');
      }
    }
    const camera = new GameObject('Main Camera', Camera);
    camera.tag = 'MainCamera';
    camera.transform.position = new Vector3(0, 0, 10);
    const cube = GameObject.createPrimitive(PrimitiveType.Cube);
    cube.addComponent(Clickable);

    engine.input.moveMouse(10, 10);
    engine.step();
    expect(events).toEqual([]);
    engine.input.moveMouse(640, 360);
    engine.input.pressMouseButton(0);
    engine.step();
    engine.input.releaseMouseButton(0);
    engine.input.moveMouse(10, 10);
    engine.step();
    expect(events).toEqual(['enter', 'down', 'exit', 'up']);
  });
});

describe('Rendering components', () => {
  test('lights and materials expose Unity-style properties', () => {
    const light = new GameObject('Sun').addComponent(Light);
    light.type = LightType.Directional;
    light.color = Color.yellow;
    light.intensity = 2;
    light.spotAngle = 60;
    expect(light.type).toBe(LightType.Directional);
    expect(light.color.equals(Color.yellow)).toBe(true);
    expect(light.spotAngle).toBe(60);

    const material = new Material();
    material.color = new Color(1, 0, 0, 0.5);
    material.metallic = 0.8;
    material.smoothness = 0.2;
    expect(material.color.equals(new Color(1, 0, 0, 0.5))).toBe(true);
    expect(material.metallic).toBeCloseTo(0.8);
  });

  test('a mesh only renders when a MeshRenderer is present and enabled', () => {
    const go = new GameObject('Thing');
    go.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Sphere);
    expect(go.entity.render?.enabled).toBe(false);
    const renderer = go.addComponent(MeshRenderer);
    expect(go.entity.render?.enabled).toBe(true);
    expect(go.entity.render?.meshInstances.length).toBe(1);
    renderer.enabled = false;
    expect(go.entity.render?.enabled).toBe(false);
    renderer.enabled = true;
    const size = renderer.bounds.size;
    expect(size.x).toBeCloseTo(1, 1);
  });

  test('procedural meshes', () => {
    const mesh = new Mesh();
    mesh.vertices = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];
    mesh.triangles = [0, 1, 2];
    mesh.recalculateNormals();
    const go = new GameObject('Tri', MeshFilter, MeshRenderer);
    (go.getComponent(MeshFilter) as MeshFilter).mesh = mesh;
    expect(go.entity.render?.meshInstances.length).toBe(1);
    expect(mesh.bounds.size.equals(new Vector3(1, 1, 0), 1e-4)).toBe(true);
  });

  test('raw PlayCanvas entities can be adopted as GameObjects', () => {
    const cube = GameObject.createPrimitive(PrimitiveType.Cube);
    const raw = cube.entity.clone();
    raw.name = 'Raw';
    cube.entity.parent?.addChild(raw);
    const found = GameObject.find('Raw');
    expect(found).not.toBeNull();
    expect(found?.getComponent(MeshRenderer)).not.toBeNull();
    expect(found?.getComponent(MeshFilter)?.mesh).not.toBeNull();
  });
});
