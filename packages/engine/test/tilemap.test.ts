import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  Camera,
  CellLayout,
  CellSwizzle,
  Color,
  Ease,
  Engine,
  GameObject,
  Grid,
  hexCellSize,
  type IEnumerator,
  instantiate,
  isAlive,
  LoopType,
  MonoBehaviour,
  Prefab,
  Ray,
  Sprite,
  Tile,
  TileBase,
  type TileData,
  Tilemap,
  TilemapRenderer,
  Time,
  Tween,
  Vector3,
  Vector3Int,
} from '../src';

let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

function makeGrid(configure?: (grid: Grid) => void): { grid: Grid; terrain: Tilemap; renderer: TilemapRenderer } {
  const grid = new GameObject('Grid').addComponent(Grid);
  configure?.(grid);
  // Created before it is parented, on purpose: the layer must pick up the Grid afterwards.
  const layer = new GameObject('Terrain', Tilemap, TilemapRenderer);
  layer.transform.setParent(grid.transform, false);
  return {
    grid,
    terrain: layer.getComponent(Tilemap) as Tilemap,
    renderer: layer.getComponent(TilemapRenderer) as TilemapRenderer,
  };
}

const grass = new Tile({ name: 'Grass', color: Color.green });
const water = new Tile({ name: 'Water', color: Color.blue });

describe('Grid', () => {
  test('converts between cells and world positions through its transform', () => {
    const { grid } = makeGrid((g) => {
      g.cellSwizzle = CellSwizzle.XZY;
      g.cellSize = new Vector3(2, 2, 1);
    });
    grid.transform.position = new Vector3(10, 0, 0);
    expect(grid.cellToWorld({ x: 1, y: 1 }).equals(new Vector3(12, 0, -2))).toBe(true);
    expect(grid.getCellCenterWorld({ x: 0, y: 0 }).equals(new Vector3(11, 0, -1))).toBe(true);
    expect(grid.worldToCell(new Vector3(13.5, 0, -0.5)).equals({ x: 1, y: 0 })).toBe(true);
    expect(grid.normal.equals(Vector3.up)).toBe(true);
    expect(grid.getCellCornersWorld({ x: 0, y: 0 }).length).toBe(4);
  });

  test('raycast turns a ray into a cell without any colliders', () => {
    const { grid } = makeGrid((g) => {
      g.cellLayout = CellLayout.Hexagon;
      g.cellSwizzle = CellSwizzle.XZY;
      g.cellSize = hexCellSize(1);
    });
    const target = new Vector3Int(3, 2, 0);
    const centre = grid.getCellCenterWorld(target);
    const hit = grid.raycast(new Ray(centre.add(new Vector3(0.2, 10, 0.1)), Vector3.down));
    expect(hit?.cell.equals(target)).toBe(true);
    expect(hit?.distance).toBeCloseTo(10);
    expect(hit?.point.y).toBeCloseTo(0);
    // Pointing away from the plane finds nothing.
    expect(grid.raycast(new Ray(new Vector3(0, 10, 0), Vector3.up))).toBeNull();
  });

  test('the mouse can pick hex cells through the camera', () => {
    const { grid } = makeGrid((g) => {
      g.cellLayout = CellLayout.Hexagon;
      g.cellSwizzle = CellSwizzle.XZY;
      g.cellSize = hexCellSize(1);
    });
    const camera = new GameObject('Main Camera').addComponent(Camera);
    camera.transform.position = new Vector3(2, 12, 6);
    camera.transform.lookAt(new Vector3(2, 0, -2));
    for (const cell of [new Vector3Int(0, 0), new Vector3Int(4, 3), new Vector3Int(2, 5)]) {
      const screen = camera.worldToScreenPoint(grid.getCellCenterWorld(cell));
      expect(grid.raycast(camera.screenPointToRay(screen))?.cell.equals(cell)).toBe(true);
    }
  });
});

describe('Tilemap', () => {
  test('set, get, clear and bounds', () => {
    const { terrain } = makeGrid();
    expect(terrain.getTile({ x: 0, y: 0 })).toBeNull();
    terrain.setTile({ x: 0, y: 0 }, grass);
    terrain.setTile(new Vector3Int(3, 2, 0), water);
    expect(terrain.getTile({ x: 0, y: 0 })).toBe(grass);
    expect(terrain.hasTile({ x: 3, y: 2 })).toBe(true);
    expect(terrain.getUsedTilesCount()).toBe(2);
    expect(terrain.containsTile(water)).toBe(true);
    const bounds = terrain.cellBounds;
    expect(bounds.min.equals({ x: 0, y: 0 })).toBe(true);
    expect(bounds.max.equals({ x: 4, y: 3, z: 1 })).toBe(true);

    terrain.setTile({ x: 3, y: 2 }, null);
    expect(terrain.hasTile({ x: 3, y: 2 })).toBe(false);
    terrain.clearAllTiles();
    expect(terrain.getUsedTilesCount()).toBe(0);
  });

  test('boxFill, swapTile and floodFill', () => {
    const { terrain } = makeGrid();
    terrain.boxFill(grass, { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(terrain.getUsedTilesCount()).toBe(16);
    // A wall of water splits the map; the bucket only fills one side.
    terrain.boxFill(water, { x: 2, y: 0 }, { x: 2, y: 3 });
    const sand = new Tile({ name: 'Sand', color: Color.yellow });
    terrain.floodFill({ x: 0, y: 0 }, sand);
    expect(terrain.getTile({ x: 1, y: 3 })).toBe(sand);
    expect(terrain.getTile({ x: 3, y: 0 })).toBe(grass);
    terrain.swapTile(water, grass);
    expect(terrain.containsTile(water)).toBe(false);
    expect(terrain.getTile({ x: 2, y: 1 })).toBe(grass);
  });

  test('tiles can carry game data through subclasses', () => {
    class TerrainTile extends Tile {
      moveCost = 1;
    }
    const forest = new TerrainTile({ name: 'Forest' });
    forest.moveCost = 2;
    const { terrain } = makeGrid();
    terrain.setTile({ x: 1, y: 1 }, forest);
    expect(terrain.getTile<TerrainTile>({ x: 1, y: 1 })?.moveCost).toBe(2);
  });

  test('sprites cut a sheet into texture rectangles (top-left pixel origin)', () => {
    const sheet = { width: 128, height: 64 } as never;
    const sprites = Sprite.slice(sheet, 2, 2);
    expect(sprites.length).toBe(4);
    // PlayCanvas texture coordinates put v = 0 at the top row of the image.
    expect(sprites[0]?.uv).toEqual([0, 0.5, 0.5, 0]); // top-left quarter
    expect(sprites[3]?.uv).toEqual([0.5, 1, 1, 0.5]); // bottom-right quarter
    expect(new Sprite(sheet).uv).toEqual([0, 1, 1, 0]);
  });

  test('a tile can spawn a GameObject on its cell and removes it with the tile', () => {
    const tree = new Prefab('Tree', (go) => {
      go.tag = 'Tree';
    });
    const forest = new Tile({ name: 'Forest', gameObject: tree });
    const { grid, terrain } = makeGrid((g) => {
      g.cellSwizzle = CellSwizzle.XZY;
    });
    terrain.setTile({ x: 2, y: 1 }, forest);
    const spawned = terrain.getInstantiatedObject({ x: 2, y: 1 });
    expect(spawned?.tag).toBe('Tree');
    expect(spawned?.transform.parent).toBe(terrain.transform);
    expect(spawned?.transform.position.equals(grid.getCellCenterWorld({ x: 2, y: 1 }), 1e-4)).toBe(true);
    terrain.setTile({ x: 2, y: 1 }, null);
    engine.step();
    expect(isAlive(spawned)).toBe(false);
  });

  test('layers share their parent grid; a tilemap without one uses the default layout', () => {
    const lone = new GameObject('Lone').addComponent(Tilemap);
    expect(() => lone.layoutGrid).toThrow(/has no Grid/);
    expect(lone.getCellCenterWorld({ x: 1, y: 2 }).equals(new Vector3(1.5, 2.5, 0))).toBe(true);
    const own = lone.gameObject.addComponent(Grid);
    expect(lone.layoutGrid).toBe(own);
    const { grid, terrain } = makeGrid();
    const overlay = new GameObject('Overlay').addComponent(Tilemap);
    overlay.transform.setParent(grid.transform, false);
    expect(terrain.layoutGrid).toBe(grid);
    expect(overlay.layoutGrid).toBe(grid);
  });
});

describe('TilemapRenderer', () => {
  test('builds one mesh per texture and rebuilds only when something changed', () => {
    const { grid, terrain, renderer } = makeGrid();
    const render = () => terrain.gameObject.entity.render as NonNullable<typeof terrain.gameObject.entity.render>;
    expect(render().meshInstances.length).toBe(0);

    terrain.boxFill(grass, { x: 0, y: 0 }, { x: 4, y: 4 });
    engine.step();
    expect(render().meshInstances.length).toBe(1);
    const mesh = render().meshInstances[0]?.mesh;
    expect(mesh?.vertexBuffer.numVertices).toBe(25 * 4);
    expect(mesh?.primitive[0]?.count).toBe(25 * 6);

    // Nothing changed: the same mesh is kept.
    engine.step();
    expect(render().meshInstances[0]?.mesh).toBe(mesh as never);

    // Changing a tile, a colour or the grid layout triggers a rebuild.
    terrain.setColor({ x: 0, y: 0 }, Color.red);
    engine.step();
    expect(render().meshInstances[0]?.mesh).not.toBe(mesh as never);
    grid.cellLayout = CellLayout.Hexagon;
    engine.step();
    expect(render().meshInstances[0]?.mesh?.vertexBuffer.numVertices).toBe(25 * 6);
    expect(render().meshInstances[0]?.mesh?.primitive[0]?.count).toBe(25 * 12);

    renderer.enabled = false;
    expect(render().enabled).toBe(false);
    renderer.enabled = true;
    expect(render().enabled).toBe(true);
  });

  test('tile bounds follow the grid plane and sortingOrder lifts a layer off it', () => {
    const { terrain, renderer } = makeGrid((g) => {
      g.cellSwizzle = CellSwizzle.XZY;
    });
    terrain.boxFill(grass, { x: 0, y: 0 }, { x: 1, y: 1 });
    renderer.rebuild();
    const bounds = () => {
      const aabb = terrain.gameObject.entity.render?.meshInstances[0]?.mesh?.aabb;
      if (!aabb) throw new Error('the tilemap has no mesh');
      return { min: Vector3.from(aabb.getMin()), max: Vector3.from(aabb.getMax()) };
    };
    expect(bounds().min.equals(new Vector3(0, 0, -2), 1e-4)).toBe(true);
    expect(bounds().max.equals(new Vector3(2, 0, 0), 1e-4)).toBe(true);
    renderer.sortingOrder = 3;
    engine.step();
    expect(bounds().min.y).toBeCloseTo(0.03);
  });

  test('translucent tiles are blended; rule tiles decide their look per cell', () => {
    class Checker extends TileBase {
      getTileData(cell: Vector3Int): TileData {
        const dark = (cell.x + cell.y) % 2 === 0;
        return { sprite: null, color: dark ? Color.black : Color.white.withAlpha(0.5), gameObject: null };
      }
    }
    const { terrain, renderer } = makeGrid();
    terrain.boxFill(new Checker(), { x: 0, y: 0 }, { x: 1, y: 0 });
    renderer.rebuild();
    const material = terrain.gameObject.entity.render?.meshInstances[0]?.material as { blendType: number; depthWrite: boolean };
    expect(material.depthWrite).toBe(false);
  });

  test('cloning a tilemap copies its tiles and draws them', () => {
    const { grid, terrain } = makeGrid();
    terrain.boxFill(grass, { x: 0, y: 0 }, { x: 2, y: 0 });
    engine.step();
    const copy = instantiate(grid.gameObject);
    const copied = copy.getComponentInChildren(Tilemap) as Tilemap;
    expect(copied).not.toBe(terrain);
    expect(copied.getUsedTilesCount()).toBe(3);
    expect(copied.layoutGrid).toBe(copy.getComponent(Grid) as Grid);
    engine.step();
    expect(copied.gameObject.entity.render?.meshInstances.length).toBe(1);
    expect(copied.gameObject.entity.render?.enabled).toBe(true);
    // The clone is independent of the original.
    copied.clearAllTiles();
    expect(terrain.getUsedTilesCount()).toBe(3);
  });
});

describe('Tween', () => {
  test('animates a value with easing and fires onComplete once', () => {
    const values: number[] = [];
    let done = 0;
    const tween = Tween.to(0, 10, 1, (value) => values.push(value))
      .setEase(Ease.Linear)
      .onComplete(() => done++);
    engine.step(0.25);
    engine.step(0.25);
    expect(values).toEqual([2.5, 5]);
    expect(tween.isActive).toBe(true);
    engine.stepSeconds(1, 0.25);
    expect(values.at(-1)).toBe(10);
    expect(done).toBe(1);
    expect(tween.isComplete).toBe(true);
    engine.step(0.25);
    expect(done).toBe(1);
  });

  test('transform shortcuts, delay, yoyo loops and kill', () => {
    const t = new GameObject('Mover').transform;
    Tween.move(t, new Vector3(4, 0, 0), 1).setEase(Ease.Linear).setDelay(0.5);
    engine.stepSeconds(0.5, 0.1);
    expect(t.position.x).toBeCloseTo(0, 5);
    engine.stepSeconds(0.5, 0.1);
    expect(t.position.x).toBeCloseTo(2, 4);

    const pulse = Tween.scale(t, new Vector3(2, 2, 2), 0.2).setEase(Ease.Linear).setLoops(2, LoopType.Yoyo);
    engine.stepSeconds(0.2, 0.05);
    expect(t.localScale.x).toBeGreaterThan(1.5);
    engine.stepSeconds(0.3, 0.05);
    expect(t.localScale.equals(Vector3.one, 1e-4)).toBe(true);
    expect(pulse.isComplete).toBe(true);

    const spin = Tween.to(0, 1, 5, () => {});
    spin.kill();
    expect(spin.isActive).toBe(false);
    Tween.move(t, Vector3.zero, 5);
    Tween.scale(t, Vector3.zero, 5);
    expect(Tween.kill(t.gameObject)).toBe(2);
    engine.step();
    expect(t.localScale.equals(Vector3.one, 1e-4)).toBe(true);
  });

  test('tweens stop when their target is destroyed and can ignore timeScale', () => {
    const go = new GameObject('Doomed');
    let updates = 0;
    Tween.to(0, 1, 10, () => updates++).setTarget(go);
    engine.step();
    expect(updates).toBe(1);
    engine.lifecycle.destroyNow(go);
    engine.step();
    expect(updates).toBe(1);

    Time.timeScale = 0;
    let scaled = 0;
    let unscaled = 0;
    Tween.to(0, 1, 1, (v) => (scaled = v)).setEase(Ease.Linear);
    Tween.to(0, 1, 1, (v) => (unscaled = v)).setEase(Ease.Linear).setUpdate(true);
    engine.step(0.05);
    engine.step(0.05);
    expect(scaled).toBe(0);
    expect(unscaled).toBeCloseTo(0.1);
  });

  test('a coroutine can yield a tween to wait for it', () => {
    const log: string[] = [];
    class Sequence extends MonoBehaviour {
      *run(): IEnumerator {
        yield Tween.moveLocal(this.transform, new Vector3(1, 0, 0), 0.2);
        log.push(`arrived at ${this.transform.localPosition.x.toFixed(1)}`);
        yield Tween.delayedCall(0.1, () => log.push('called'));
        log.push('done');
      }
    }
    const sequence = new GameObject('S').addComponent(Sequence);
    sequence.startCoroutine(sequence.run());
    engine.stepSeconds(0.1, 0.05);
    expect(log).toEqual([]);
    engine.stepSeconds(0.6, 0.05);
    expect(log).toEqual(['arrived at 1.0', 'called', 'done']);
  });
});
