import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  Camera,
  CellLayout,
  Color,
  Debug,
  Engine,
  GameObject,
  Grid,
  MonoBehaviour,
  Tile,
  Tilemap,
  TilemapRenderer,
  type Transform,
  Vector3,
} from '../src';

/**
 * The things that turn a silent mistake into a message, and let a script (or an agent)
 * read the scene as text.
 */
let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

describe('message names', () => {
  test("Unity's spelling of a message is an error when the script is added, every time", () => {
    class Spinner extends MonoBehaviour {
      // @ts-expect-error The type-checker refuses it too: this line fails `bun run typecheck` if it ever stops.
      Update() {}
    }
    const add = () => new GameObject('S').addComponent(Spinner);
    expect(add).toThrow('Spinner.Update() will never be called: message names are camelCase here. Rename it to update().');
    expect(add).toThrow('Rename it to update()');
  });

  test('a wrong-case message on a base class is found through the classes that extend it', () => {
    class Base extends MonoBehaviour {
      // @ts-expect-error Unity's spelling.
      OnEnable() {}
    }
    class Derived extends Base {}
    expect(() => new GameObject('D').addComponent(Derived)).toThrow('Derived.OnEnable() will never be called');
  });

  test('a browser engine logs the mistake once per class and keeps running', () => {
    engine.dispose();
    engine = Engine.createHeadless({ throwOnError: false });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      class Mover extends MonoBehaviour {
        // @ts-expect-error Unity's spelling.
        LateUpdate() {}
      }
      new GameObject('A').addComponent(Mover);
      new GameObject('B').addComponent(Mover);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[1])).toContain('Rename it to lateUpdate()');
    } finally {
      errors.mockRestore();
    }
  });

  test('near misses and Unity messages the engine does not send are warned about once', () => {
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      class Door extends MonoBehaviour {
        opened = false;
        onStart() {}
        onTriggerEnter() {}
        open() {
          this.opened = true;
        }
      }
      new GameObject('A').addComponent(Door);
      new GameObject('B').addComponent(Door);
      const text = warnings.mock.calls.map((call) => String(call[0]));
      expect(text).toEqual([
        'Door.onStart() looks like a Unity message, but the engine never calls it. Did you mean start()?',
        'Door.onTriggerEnter() is a Unity message this engine does not send, so it will never be called: ' +
          'there are no trigger events yet; test for overlap with Physics.overlapSphere in update().',
      ]);
    } finally {
      warnings.mockRestore();
    }
  });

  test('correct messages and ordinary methods pass without comment', () => {
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let updates = 0;
      class Fine extends MonoBehaviour {
        awake() {}
        update() {
          updates++;
        }
        onDestroy() {}
        startle() {}
        refresh() {}
      }
      new GameObject('F').addComponent(Fine);
      engine.step();
      expect(updates).toBe(1);
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
    }
  });
});

describe('Debug.hierarchy', () => {
  class Follower extends MonoBehaviour {
    speed = 2.5;
    label = 'scout';
    target: Transform | null = null;
    waypoints = [new Vector3(1, 0, 0), new Vector3(2, 0, 0)];
    stats = { hp: 10, armour: 0 };
    tint = Color.red;
    private _cooldown = 3;
    onArrive = () => this._cooldown;
  }

  test('lists every object with its components, placement and public fields', () => {
    const camera = new GameObject('Main Camera');
    camera.tag = 'MainCamera';
    camera.transform.position = new Vector3(0, 10, 12.5);
    camera.addComponent(Camera).fieldOfView = 40;

    const squad = new GameObject('Squad');
    const scout = new GameObject('Scout');
    scout.transform.setParent(squad.transform, false);
    scout.transform.localScale = new Vector3(2, 2, 2);
    scout.layer = 8;
    const follower = scout.addComponent(Follower);
    follower.target = camera.transform;
    follower.enabled = false;
    const asleep = new GameObject('Asleep');
    asleep.transform.setParent(squad.transform, false);
    asleep.setActive(false);

    expect(Debug.hierarchy()).toBe(
      [
        'Scene "Untitled" (active)',
        '  Main Camera <Camera> tag=MainCamera at (0, 10, 12.5)',
        '    | Camera: fieldOfView 40',
        '  Squad',
        '    Scout <Follower> layer=8 scale (2, 2, 2)',
        '      | Follower (disabled): speed=2.5, label="scout", target=Main Camera (Transform), ' +
          'waypoints=[(1, 0, 0), (2, 0, 0)], stats={hp: 10, armour: 0}, tint=' + String(Color.red),
        '    Asleep (inactive)',
      ].join('\n'),
    );
  });

  test('can leave the fields out, stop at a depth, or start from one object', () => {
    const root = new GameObject('Root');
    const child = new GameObject('Child');
    child.transform.setParent(root.transform, false);
    child.addComponent(Follower);
    const leaf = new GameObject('Leaf');
    leaf.transform.setParent(child.transform, false);

    expect(Debug.hierarchy({ fields: false })).toBe(
      ['Scene "Untitled" (active)', '  Root', '    Child <Follower>', '      Leaf'].join('\n'),
    );
    expect(Debug.hierarchy({ depth: 0 })).toBe(['Scene "Untitled" (active)', '  Root', '    … 1 child'].join('\n'));
    expect(Debug.hierarchy({ root: child, fields: false })).toBe(['Child <Follower>', '  Leaf'].join('\n'));
  });

  test('a crowd of children is counted by name instead of listed', () => {
    const forest = new GameObject('Forest');
    for (let i = 0; i < 40; i++) {
      new GameObject(i < 3 ? `Oak ${i}` : i % 2 ? 'Pine' : 'Birch').transform.setParent(forest.transform, false);
    }
    expect(Debug.hierarchy({ maxChildren: 3 })).toBe(
      [
        'Scene "Untitled" (active)',
        '  Forest',
        '    Oak 0',
        '    Oak 1',
        '    Oak 2',
        '    … 37 more: Pine ×19, Birch ×18',
      ].join('\n'),
    );
  });

  test('tile maps say how much is painted, and an empty scene says so', () => {
    expect(Debug.hierarchy()).toBe('Scene "Untitled" (active)\n  (empty)');

    const grid = new GameObject('Board').addComponent(Grid);
    grid.cellLayout = CellLayout.Hexagon;
    const layer = new GameObject('Terrain');
    layer.transform.setParent(grid.transform, false);
    const terrain = layer.addComponent(Tilemap);
    layer.addComponent(TilemapRenderer).sortingOrder = 2;
    terrain.boxFill(new Tile({ color: Color.green }), { x: 0, y: 0 }, { x: 3, y: 1 });

    expect(Debug.hierarchy()).toBe(
      [
        'Scene "Untitled" (active)',
        '  Board <Grid>',
        '    | Grid: hexagon cells, swizzle xyz, cellSize (1, 1, 1)',
        '    Terrain <Tilemap, TilemapRenderer>',
        '      | Tilemap: 8 tiles, cells (0, 0) to (3, 1)',
        '      | TilemapRenderer: sortingOrder=2, sortingStep=0.01, transparent=false, lit=true',
      ].join('\n'),
    );
  });
});
