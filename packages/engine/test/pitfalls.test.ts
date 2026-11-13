// Each test here is a mistake that used to compile, pass lint and then quietly do the
// wrong thing. The engine now says so: a type error, a thrown error with the fix in it, or
// a warning. If one of these starts passing silently again, the pit is open again.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  BoundsInt,
  BoxCollider,
  Camera,
  cellKey,
  CellLayout,
  Color,
  destroy,
  Ease,
  Engine,
  findAnyObjectByType,
  findFirstObjectByType,
  findObjectsByType,
  FindObjectsInactive,
  FindObjectsSortMode,
  GameObject,
  Grid,
  type IEnumerator,
  Input,
  instantiate,
  KeyCode,
  LayerMask,
  layerNamed,
  Mathf,
  Mesh,
  MeshFilter,
  MeshRenderer,
  MonoBehaviour,
  Observable,
  Prefab,
  Random,
  SceneManager,
  Tile,
  TileFlags,
  Tilemap,
  type TilemapData,
  Time,
  Tween,
  UnityEvent,
  Vector2Int,
  Vector3,
  Vector3Int,
  WaitForSeconds,
} from '@synergy/engine';
import { ENGINE_EPSILON } from '../src/math/Mathf';

let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

/** Runs `action` and returns what it logged with `console.warn`. */
function warnings(action: () => void): string[] {
  const spy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    action();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

describe('messages written as coroutines', () => {
  test("Unity's `IEnumerator Start()`: *start() runs as a coroutine", () => {
    class Intro extends MonoBehaviour {
      log: string[] = [];
      *start(): IEnumerator {
        this.log.push('began');
        yield new WaitForSeconds(1);
        this.log.push('finished');
      }
    }
    const intro = new GameObject('Intro').addComponent(Intro);
    engine.step();
    expect(intro.log).toEqual(['began']);
    engine.stepSeconds(1.1);
    expect(intro.log).toEqual(['began', 'finished']);
  });

  test('*update() would run none of its code, so adding the script fails and says what to write', () => {
    class Ticker extends MonoBehaviour {
      ticks = 0;
      // @ts-expect-error a message returns nothing; only start() and the mouse messages may be coroutines
      *update(): IEnumerator {
        this.ticks++;
        yield null;
      }
    }
    expect(() => new GameObject('Ticker').addComponent(Ticker)).toThrow(
      /Ticker\.update\(\) is a generator.*this\.startCoroutine\(this\.routine\(\)\)/s,
    );
  });

  test('an async message that fails reports the error instead of losing it', async () => {
    class Loader extends MonoBehaviour {
      // @ts-expect-error a message cannot be async: the compiler says so, and this is what happens to code it never saw
      async start() {
        await Promise.resolve();
        throw new Error('the level file is missing');
      }
    }
    const errors: unknown[] = [];
    const quiet = Engine.createHeadless({ throwOnError: false });
    const logged = spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args));
    try {
      new GameObject('Loader').addComponent(Loader);
      quiet.step();
      await Promise.resolve();
      await Promise.resolve();
      expect(JSON.stringify(errors.map(String))).toContain('Loader.start');
    } finally {
      logged.mockRestore();
      quiet.dispose();
    }
  });
});

describe('coroutines', () => {
  test('a yielded promise hands its value back', async () => {
    class Fetcher extends MonoBehaviour {
      got: unknown = 'nothing yet';
      start() {
        this.startCoroutine(this.run());
      }
      *run(): IEnumerator {
        this.got = yield Promise.resolve(42);
      }
    }
    const fetcher = new GameObject('Fetcher').addComponent(Fetcher);
    engine.step();
    await Promise.resolve();
    engine.stepFrames(2);
    expect(fetcher.got).toBe(42);
  });

  test('yielding something that cannot be waited on names the owner and what to yield', () => {
    class Confused extends MonoBehaviour {
      start() {
        // @ts-expect-error `yield WaitForSeconds` (the class, no `new`) is no longer a Yieldable
        this.startCoroutine(this.run());
      }
      *run() {
        yield WaitForSeconds;
      }
    }
    new GameObject('Confused').addComponent(Confused);
    expect(() => engine.step()).toThrow(/the function WaitForSeconds.*new WaitForSeconds\(1\)/s);
  });

  test('the same sentence comes out for a yielded GameObject, which has no JSON form', () => {
    class Lost extends MonoBehaviour {
      start() {
        // @ts-expect-error a GameObject is not something to wait on
        this.startCoroutine(this.run());
      }
      *run() {
        yield this.gameObject;
      }
    }
    new GameObject('Lost').addComponent(Lost);
    expect(() => engine.step()).toThrow(/which is not something to wait on/);
  });
});

describe('components', () => {
  test('looking up a sibling in a field initialiser fails and points at awake()', () => {
    class Shooter extends MonoBehaviour {
      // The answer would depend on whether the collider was added before or after.
      readonly box = this.getComponent(BoxCollider);
    }
    expect(() => new GameObject('Shooter').addComponent(Shooter)).toThrow(
      /Shooter: getComponent\(BoxCollider\) was called in a field initialiser.*awake\(\)/s,
    );
  });

  test('a prefab written as a factory says so instead of making empty instances', () => {
    const Enemy = new Prefab('Enemy', () => {
      const enemy = new GameObject('Enemy');
      enemy.addComponent(BoxCollider);
      return enemy;
    });
    expect(() => instantiate(Enemy)).toThrow(/build\(\) made and returned a GameObject of its own.*\(go\) =>/s);
  });

  test('a build function may return what it added to the instance', () => {
    const Child = new Prefab('Child', (go) => {
      go.addComponent(BoxCollider);
    });
    const Squad = new Prefab('Squad', (go) => instantiate(Child, go.transform));
    expect(instantiate(Squad).transform.childCount).toBe(1);
  });

  test('a component the class requires may be looked up in a field: it is always there first', () => {
    class Armoured extends MonoBehaviour {
      static readonly requireComponents = [BoxCollider];
      readonly box = this.getComponent(BoxCollider);
    }
    expect(new GameObject('Tank').addComponent(Armoured).box).not.toBeNull();
  });

  test('a prefab that adds nothing is warned about once; one that only tags is not', () => {
    const Nothing = new Prefab('Nothing', () => {});
    const Marker = new Prefab('Marker', (go) => {
      go.tag = 'Marker';
    });
    const said = warnings(() => {
      instantiate(Nothing);
      instantiate(Nothing);
      instantiate(Marker);
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Prefab "Nothing": build() added nothing');
  });

  test('a layer that was never defined is refused instead of matching no mask', () => {
    const unit = new GameObject('Unit');
    expect(() => {
      unit.layer = LayerMask.nameToLayer('A layer nobody defined');
    }).toThrow(/layer must be a whole number from 0 to 31, not -1.*LayerMask\.define/s);
    expect(unit.layer).toBe(0);
  });
});

describe('cameras and input', () => {
  test('a camera without the MainCamera tag: Camera.main says why it is null, once', () => {
    const camera = new GameObject('Camera');
    camera.tag = 'mainCamera';
    camera.addComponent(Camera);
    const said = warnings(() => {
      expect(Camera.main).toBeNull();
      expect(Camera.main).toBeNull();
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('none has the tag "MainCamera" (their tags: "mainCamera")');
  });

  test('no camera at all is not a mistake in a test, and is not warned about', () => {
    expect(warnings(() => expect(Camera.main).toBeNull())).toEqual([]);
  });

  test('Input.mousePresent is false until the pointer has been over the game', () => {
    class Probe extends MonoBehaviour {
      seen: boolean[] = [];
      update() {
        this.seen.push(Input.mousePresent);
      }
    }
    const probe = new GameObject('Probe').addComponent(Probe);
    engine.step();
    engine.input.moveMouse(10, 10);
    engine.step();
    expect(probe.seen).toEqual([false, true]);
  });

  test('test input takes a KeyCode, not a letter', () => {
    // @ts-expect-error 'w' is not a key code; the key is KeyCode.W ('KeyW')
    engine.input.pressKey('w');
    engine.input.pressKey(KeyCode.W);
    expect(engine.input.getKey(KeyCode.W)).toBe(true);
  });
});

describe('time and scenes', () => {
  test('stepSeconds while paused fails at once instead of spinning a million frames', () => {
    Time.timeScale = 0;
    expect(() => engine.stepSeconds(1)).toThrow(/Time\.timeScale is 0.*engine\.stepFrames\(n\)/s);
    engine.stepFrames(3);
    expect(Time.frameCount).toBe(3);
  });

  test('unloading a scene that is not loaded names the ones that are', () => {
    expect(() => SceneManager.unloadScene('Levle1')).toThrow(/no scene named "Levle1" is loaded\. Loaded: /);
  });

  test('a missing canvas element is an error, not a silent headless engine', async () => {
    const missing = null as unknown as HTMLCanvasElement; // what getElementById returns for a wrong id
    expect(Engine.create({ canvas: missing })).rejects.toThrow(/canvas element was not found/);
    const headless = await Engine.create();
    expect(headless.isHeadless).toBe(true);
    headless.dispose();
  });
});

describe('tweens', () => {
  test('Tween.kill takes the transform as well as the GameObject', () => {
    const unit = new GameObject('Unit');
    Tween.move(unit.transform, new Vector3(10, 0, 0), 1);
    engine.stepFrames(5);
    expect(Tween.kill(unit.transform)).toBe(1);
    const stoppedAt = unit.transform.position.x;
    engine.stepFrames(5);
    expect(unit.transform.position.x).toBe(stoppedAt);
  });

  test("a script's own tween is its own: killing it leaves the object's move alone, and it ends with the script", () => {
    class Glow extends MonoBehaviour {
      calls = 0;
      flash() {
        Tween.kill(this);
        Tween.to(1, 0, 0.5, () => this.calls++).setTarget(this);
      }
    }
    const unit = new GameObject('Unit');
    const glow = unit.addComponent(Glow);
    Tween.move(unit.transform, new Vector3(10, 0, 0), 1).setEase(Ease.Linear);
    glow.flash();
    engine.stepSeconds(0.25);
    glow.flash(); // cancels the first flash, not the move
    engine.stepSeconds(1);
    expect(unit.transform.position.x).toBeCloseTo(10);

    glow.flash();
    engine.stepFrames(2);
    destroy(glow); // the script only: the GameObject lives on
    engine.step(); // destroy() takes effect at the end of the frame
    const before = glow.calls;
    engine.stepFrames(10);
    expect(glow.calls).toBe(before);
  });
});

describe('tilemaps', () => {
  function makeTilemap(): Tilemap {
    const grid = new GameObject('Board').addComponent(Grid);
    grid.cellLayout = CellLayout.Rectangle;
    const layer = new GameObject('Terrain');
    layer.transform.setParent(grid.transform, false);
    return layer.addComponent(Tilemap);
  }

  test('a world position is not a cell: reading or painting with one fails and names worldToCell', () => {
    const tilemap = makeTilemap();
    const grass = new Tile({ name: 'grass' });
    tilemap.setTile({ x: 2, y: 3 }, grass);
    const worldPosition = new Vector3(2.5, 3.5, 0);
    expect(() => tilemap.getTile(worldPosition)).toThrow(/\(2\.5, 3\.5, 0\) is not a cell.*grid\.worldToCell/s);
    expect(() => tilemap.setTile(worldPosition, grass)).toThrow(/is not a cell/);
    expect(() => tilemap.hasTile(worldPosition)).toThrow(/is not a cell/);
    expect(tilemap.getTile(tilemap.layoutGrid.worldToCell(worldPosition))).toBe(grass);
  });

  test("setColor on a Tile's cell is ignored, as in Unity (LockColor by default), and says how to unlock it", () => {
    const tilemap = makeTilemap();
    const grass = new Tile({ name: 'grass', color: Color.green });
    const cell = { x: 1, y: 1 };
    tilemap.setTile(cell, grass);
    expect(tilemap.getTileFlags(cell)).toBe(TileFlags.LockColor);
    const said = warnings(() => {
      tilemap.setColor(cell, Color.red);
      tilemap.setColor(cell, Color.blue); // warned once, not every call
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(
      /TileFlags\.LockColor.*Unity ignores the call too.*removeTileFlags\(cell, TileFlags\.LockColor\)/s,
    );
    expect(tilemap.getColor(cell)).toEqual(Color.green);

    tilemap.removeTileFlags(cell, TileFlags.LockColor);
    tilemap.setColor(cell, Color.red);
    // Replaced, not multiplied with the tile's green (which would give black).
    expect(tilemap.getColor(cell)).toEqual(Color.red);
    // Painting the cell again brings back the tile's colour and flags.
    tilemap.setTile(cell, null);
    tilemap.setTile(cell, grass);
    expect(tilemap.getColor(cell)).toEqual(Color.green);
    expect(tilemap.getTileFlags(cell)).toBe(TileFlags.LockColor);
  });

  test('getTile<T> alone is a cast; getTile(cell, T) checks, like C# GetTile<T>', () => {
    class DoorTile extends Tile {
      open = false;
    }
    const tilemap = makeTilemap();
    tilemap.setTile({ x: 0, y: 0 }, new Tile({ name: 'grass' }));
    const door = new DoorTile({ name: 'door' });
    tilemap.setTile({ x: 1, y: 0 }, door);
    expect(tilemap.getTile({ x: 0, y: 0 }, DoorTile)).toBeNull();
    expect(tilemap.getTile({ x: 1, y: 0 }, DoorTile)).toBe(door);
    // The type parameter alone checks nothing: the grass tile comes back typed as a door.
    expect(tilemap.getTile<DoorTile>({ x: 0, y: 0 })?.open).toBeUndefined();
  });
});

describe('meshes', () => {
  const triangle = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];

  test("Unity's order works: assign the mesh to the filter, then fill it", () => {
    const shape = new GameObject('Shape');
    shape.addComponent(MeshRenderer);
    const mesh = new Mesh();
    shape.addComponent(MeshFilter).mesh = mesh;
    expect(shape.entity.render?.meshInstances).toHaveLength(0);
    mesh.vertices = triangle;
    mesh.triangles = [0, 1, 2];
    mesh.recalculateNormals();
    expect(shape.entity.render?.meshInstances).toHaveLength(1);
  });

  test('assigning new vertices redraws every object that shows the mesh', () => {
    const mesh = new Mesh();
    mesh.vertices = triangle;
    mesh.triangles = [0, 1, 2];
    const shape = new GameObject('Shape');
    const renderer = shape.addComponent(MeshRenderer);
    shape.addComponent(MeshFilter).mesh = mesh;
    const copy = instantiate(shape);

    mesh.vertices = triangle.map((corner) => corner.add(new Vector3(10, 0, 0)));
    expect(renderer.bounds.min.x).toBeCloseTo(10);
    expect(copy.getComponent(MeshRenderer)?.bounds.min.x).toBeCloseTo(10);
  });
});

describe('Observable', () => {
  test('the same object handed back is warned about: it was changed in place and nobody was told', () => {
    const items = new Observable<string[]>([]);
    let told = 0;
    items.subscribe(() => told++);
    const said = warnings(() => {
      const list = items.value as string[]; // the cast is what the read-only type is there to stop
      list.push('sword');
      items.value = list;
    });
    expect(told).toBe(0);
    expect(said.join()).toContain('given the object it already holds');
    items.value = [...items.value, 'shield'];
    expect(told).toBe(1);
  });

  test('a shared constant set again is not a change in place, and is not warned about', () => {
    const NONE: readonly string[] = Object.freeze([]);
    const selection = new Observable<readonly string[]>(NONE);
    expect(
      warnings(() => {
        selection.value = NONE;
      }),
    ).toEqual([]);
  });

  test('what comes out is still usable as what went in: tuples, and objects with methods', () => {
    class Session {
      private log: string[] = [];
      submit(line: string) {
        this.log.push(line);
      }
    }
    const size = new Observable<[number, number]>([4, 3]);
    const [width, height] = size.value;
    expect(width * height).toBe(12);
    const current = new Observable<Session | null>(new Session());
    const session: Session | null = current.value;
    session?.submit('ready');
    expect(session).not.toBeNull();
  });

  test('changing the value in place does not compile', () => {
    const hud = new Observable({ gold: 0, items: ['sword'] });
    const scores = new Observable(new Map<string, number>());
    const selected = new Observable<GameObject | null>(null);
    const neverRun = () => {
      // @ts-expect-error the value is read-only: assign a new object
      hud.value.gold += 5;
      // @ts-expect-error a ReadonlyMap has no set
      scores.value.set('ada', 3);
      hud.update((state) => {
        // @ts-expect-error update() is given the value to read; return a new one
        state.gold += 5;
        return state;
      });
    };
    expect(neverRun).toBeFunction();
    // What is meant to be written still is, and an engine object comes out as itself.
    hud.update((state) => ({ ...state, gold: state.gold + 5 }));
    expect(hud.value.gold).toBe(5);
    const picked: GameObject | null = selected.value;
    expect(picked).toBeNull();
  });
});

describe('whole numbers and shared values', () => {
  test("C#'s integer division: a fractional cell is refused where it is made", () => {
    expect(() => new Vector3Int(7 / 2, 0, 0)).toThrow(/an integer vector holds whole numbers.*Math\.trunc/s);
    expect(() => new Vector2Int(0, 0.5)).toThrow(/an integer vector holds whole numbers/);
    expect(new Vector3Int(Math.trunc(7 / 2), 0, 0).x).toBe(3);
  });

  test('a world position is not a key for a Map of cells', () => {
    expect(() => cellKey({ x: 2.5, y: 0 })).toThrow(/is not a cell.*worldToCell/s);
    expect(cellKey({ x: 2, y: 3 })).toBe('2,3,0');
  });

  test('2D bounds contain their cells', () => {
    const bounds = BoundsInt.fromMinMax({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(bounds.contains({ x: 1, y: 1 })).toBe(true);
    expect([...bounds.allPositionsWithin()]).toHaveLength(9);
  });

  test('the shared constants cannot be changed through a looser type', () => {
    const cell: { x: number; y: number } = Vector3Int.zero; // compiles: the shapes match
    expect(() => {
      cell.x += 3;
    }).toThrow(TypeError);
    const up: { x: number; y: number; z: number } = Vector3.up;
    expect(() => {
      up.y = 5;
    }).toThrow(TypeError);
    expect(Vector3Int.zero.x).toBe(0);
    expect(Vector3.up.y).toBe(1);
  });

  test('a generator needs a whole-number seed, so two games are not secretly the same', () => {
    // @ts-expect-error the seed is required
    expect(() => new Random()).toThrow(RangeError);
    expect(() => new Random(0.37)).toThrow(/the seed must be a whole number/); // what Math.random() gives
    expect(() => new Random(Number.NaN)).toThrow(RangeError);
    expect(new Random(7).rangeInt(0, 100)).toBe(new Random(7).rangeInt(0, 100));
    // A clock reading has a fraction and was always a usable seed.
    expect(new Random(1731450000123.75).rangeInt(0, 100)).toBe(new Random(1731450000123).rangeInt(0, 100));
  });

  test('Mathf.smoothDamp takes maxSpeed before deltaTime, as in Unity', () => {
    // @ts-expect-error both are required, so a call in the old order (deltaTime fifth, nothing sixth) does not compile
    expect(() => Mathf.smoothDamp(0, 100, 0, 0.3, 1 / 60)).toThrow(RangeError);
    const [limited] = Mathf.smoothDamp(0, 100, 0, 0.3, 10, 1 / 60);
    const [free] = Mathf.smoothDamp(0, 100, 0, 0.3, Infinity, 1 / 60);
    expect(limited).toBeLessThan(free);
    // Six arguments in the old order still compile; the infinite "deltaTime" gives it away.
    expect(() => Mathf.smoothDamp(0, 100, 0, 0.3, 1 / 60, Infinity)).toThrow(
      /\(maxSpeed, deltaTime\), in Unity's order/,
    );
  });

  test('a layer that is not in the map is named, with the ones that are', () => {
    const map: TilemapData = {
      grid: { cellLayout: 'rectangle', cellSwizzle: 'xyz', cellSize: [1, 1, 0], cellGap: [0, 0, 0] },
      layers: [{ name: 'Terrain', origin: [0, 0], width: 1, height: 1, tiles: ['grass'], cells: [0] }],
    };
    expect(layerNamed(map, 'Terrain').name).toBe('Terrain');
    expect(() => layerNamed(map, 'Ground')).toThrow('The map has no layer named "Ground". Its layers: "Terrain".');
  });
});

describe("Unity's documented behaviour", () => {
  test('Color.mul scales alpha too, like Color * float; a Color multiplies channel by channel', () => {
    const halfSeen = new Color(1, 0.5, 0, 0.8);
    expect(halfSeen.mul(0.5).equals(new Color(0.5, 0.25, 0, 0.4))).toBe(true);
    expect(halfSeen.mul(0.5).withAlpha(halfSeen.a).a).toBe(0.8);
    expect(halfSeen.mul(new Color(0.5, 1, 1, 0.5)).equals(new Color(0.5, 0.5, 0, 0.4))).toBe(true);
  });

  test("Mathf.epsilon is Unity's tiny value, and approximately uses Unity's relative formula", () => {
    expect(Mathf.epsilon).toBe(1.401298e-45);
    expect(Mathf.approximately(0.1 + 0.2, 0.3)).toBe(true);
    expect(Mathf.approximately(1_000_000, 1_000_000.5)).toBe(true); // within one part in a million
    expect(Mathf.approximately(1, 1.00001)).toBe(false);
    expect(Mathf.approximately(0, 1e-9)).toBe(false); // near zero it is almost exact, as in Unity
    // The engine's own tolerance is separate, so thresholds inside the engine did not move.
    expect(ENGINE_EPSILON).toBe(1e-6);
  });

  test('UnityEvent.removeListener removes every registration of the function', () => {
    const event = new UnityEvent();
    let calls = 0;
    const listener = () => calls++;
    event.addListener(listener);
    const removeSecond = event.addListener(listener);
    event.invoke();
    expect(calls).toBe(2); // added twice, called twice, as in Unity
    removeSecond();
    event.invoke();
    expect(calls).toBe(3);
    event.addListener(listener);
    event.removeListener(listener);
    event.invoke();
    expect(calls).toBe(3);
    expect(event.listenerCount).toBe(0);
  });

  test('getComponentInParent skips inactive parents unless asked, but always searches the object itself', () => {
    class Marker extends MonoBehaviour {}
    const root = new GameObject('Root');
    root.addComponent(Marker);
    const parent = new GameObject('Parent');
    parent.transform.setParent(root.transform, false);
    const parentMarker = parent.addComponent(Marker);
    const child = new GameObject('Child');
    child.transform.setParent(parent.transform, false);
    const probe = child.addComponent(Marker);

    expect(child.getComponentsInParent(Marker)).toHaveLength(3);
    parent.setActive(false); // the child and the parent are now inactive in the hierarchy
    expect(child.getComponentInParent(Marker)).toBe(probe); // itself, though inactive
    expect(probe.getComponentsInParent(Marker)).toEqual([probe, root.getComponent(Marker) as Marker]);
    expect(probe.getComponentsInParent(Marker, true)).toContain(parentMarker);
    const parentless = new GameObject('Alone').addComponent(Marker);
    parentless.gameObject.setActive(false);
    expect(parentless.getComponentInParent(Marker)).toBe(parentless);
  });

  test('getComponentInChildren always searches the object itself; find("/A/B") starts at a root', () => {
    class Marker extends MonoBehaviour {}
    const army = new GameObject('Army');
    const own = army.addComponent(Marker);
    army.setActive(false);
    expect(army.getComponentInChildren(Marker)).toBe(own);
    expect(army.getComponentsInChildren(Marker)).toEqual([own]);
    army.setActive(true);

    const camp = new GameObject('Camp');
    const nested = new GameObject('Army');
    nested.transform.setParent(camp.transform, false);
    const footman = new GameObject('Footman');
    footman.transform.setParent(nested.transform, false);
    expect(GameObject.find('Army/Footman')).toBe(footman); // a relative path matches below Camp
    expect(GameObject.find('/Army/Footman')).toBeNull(); // the root Army has no Footman
    expect(GameObject.find('/Camp/Army/Footman')).toBe(footman);
  });

  test('findObjectsByType leaves inactive objects out unless FindObjectsInactive.Include', () => {
    class Marker extends MonoBehaviour {}
    const a = new GameObject('A').addComponent(Marker);
    const b = new GameObject('B').addComponent(Marker);
    b.gameObject.setActive(false);
    expect(findObjectsByType(Marker)).toEqual([a]);
    expect(findObjectsByType(Marker, FindObjectsInactive.Include)).toEqual([a, b]);
    // The deprecated sort-mode forms still mean "exclude inactive", as in Unity.
    expect(findObjectsByType(Marker, FindObjectsSortMode.InstanceID)).toEqual([a]);
    expect(findAnyObjectByType(Marker)).toBe(a);
    expect(findFirstObjectByType(Marker)).toBe(a);
    a.gameObject.setActive(false);
    expect(findAnyObjectByType(Marker)).toBeNull();
    expect(findAnyObjectByType(Marker, FindObjectsInactive.Include)).toBe(a);
  });

  test('stopAllCoroutines leaves invokes alone, and invokes outlive deactivation, as in Unity', () => {
    class Launcher extends MonoBehaviour {
      fired = 0;
      launch() {
        this.fired++;
      }
    }
    const launcher = new GameObject('Launcher').addComponent(Launcher);
    launcher.invokeRepeating(launcher.launch, 0.1, 0.1);
    launcher.stopAllCoroutines();
    expect(launcher.isInvoking(launcher.launch)).toBe(true);
    launcher.gameObject.setActive(false);
    launcher.enabled = false;
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(launcher.fired).toBeGreaterThan(2);
    // Scheduling one on an inactive object works too (a coroutine would throw).
    launcher.invoke(launcher.launch, 0);
    expect(launcher.isInvoking()).toBe(true);
    launcher.cancelInvoke();
    expect(launcher.isInvoking()).toBe(false);
    const before = launcher.fired;
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(launcher.fired).toBe(before);
    // Passing the method's name, as in Unity, is refused with the fix.
    // @ts-expect-error a string where the method goes: the mistake this test is about
    expect(() => launcher.invoke('launch', 1)).toThrow(/Pass the method itself, not its name/);
  });

  test('stopCoroutine takes the generator that was started, like StopCoroutine(IEnumerator)', () => {
    class Walker extends MonoBehaviour {
      steps = 0;
      *walk(): IEnumerator {
        while (true) {
          this.steps++;
          yield null;
        }
      }
    }
    const walker = new GameObject('Walker').addComponent(Walker);
    const routine = walker.walk();
    walker.startCoroutine(routine);
    engine.step(1 / 60);
    const steps = walker.steps;
    walker.stopCoroutine(walker.walk()); // a new generator: not the one running
    engine.step(1 / 60);
    expect(walker.steps).toBe(steps + 1);
    walker.stopCoroutine(routine);
    engine.step(1 / 60);
    expect(walker.steps).toBe(steps + 1);
    // @ts-expect-error by name, as Unity allows: not supported, and said so
    expect(() => walker.stopCoroutine('walk')).toThrow(/by name.*not supported/);
  });

  test("stopCoroutine with another behaviour's coroutine stops it, but warns that Unity would not", () => {
    class Idle extends MonoBehaviour {
      *wait(): IEnumerator {
        yield new WaitForSeconds(10);
      }
    }
    const owner = new GameObject('Owner').addComponent(Idle);
    const other = owner.gameObject.addComponent(Idle);
    const coroutine = owner.startCoroutine(owner.wait());
    const said = warnings(() => other.stopCoroutine(coroutine));
    expect(said[0]).toMatch(/Unity would leave it running.*on the behaviour that started it/s);
    expect(coroutine.isDone).toBe(true);
  });
});
