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
  Engine,
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
  Tilemap,
  type TilemapData,
  Time,
  Tween,
  Vector2Int,
  Vector3,
  Vector3Int,
  WaitForSeconds,
} from '@synergy/engine';

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
  test('Tween.kill takes the transform or the script as well as the GameObject', () => {
    const unit = new GameObject('Unit');
    Tween.move(unit.transform, new Vector3(10, 0, 0), 1);
    engine.stepFrames(5);
    expect(Tween.kill(unit.transform)).toBe(1);
    const stoppedAt = unit.transform.position.x;
    engine.stepFrames(5);
    expect(unit.transform.position.x).toBe(stoppedAt);
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
    expect(() => new Random(Math.random() + 0.5)).toThrow(/the seed must be a whole number/);
    expect(new Random(7).rangeInt(0, 100)).toBe(new Random(7).rangeInt(0, 100));
  });

  test('Mathf.smoothDamp takes maxSpeed before deltaTime, as in Unity', () => {
    // @ts-expect-error both are required, so a call in the old order (deltaTime fifth, nothing sixth) does not compile
    Mathf.smoothDamp(0, 100, 0, 0.3, 1 / 60);
    const [limited] = Mathf.smoothDamp(0, 100, 0, 0.3, 10, 1 / 60);
    const [free] = Mathf.smoothDamp(0, 100, 0, 0.3, Infinity, 1 / 60);
    expect(limited).toBeLessThan(free);
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
