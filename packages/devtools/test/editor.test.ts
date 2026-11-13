import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  Camera,
  Color,
  destroyImmediate,
  Engine,
  GameObject,
  MonoBehaviour,
  SceneManager,
  Vector2,
  Vector3,
} from '@synergy/engine';
import { EditorApplication, PauseState } from '../src/EditorApplication';
import { EditorPrefs } from '../src/EditorPrefs';
import { nicify } from '../src/editor/fields';
import {
  allGameObjects,
  childrenOf,
  colorToHex,
  fieldsOf,
  gameObjectOfReference,
  sceneRoots,
  setField,
  summaryOf,
} from '../src/inspect';
import { Selection } from '../src/Selection';

/** What the Hierarchy and Inspector read and write, and the editor's Unity-named APIs, on a headless engine. */
let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  Selection.activeGameObject = null;
  engine.dispose();
});

class Unit extends MonoBehaviour {
  moveRange = 3;
  name2 = 'Scout';
  alive = true;
  target: GameObject | null = null;
  heading = Vector3.forward;
  offset = new Vector2(1, 2);
  tint = Color.red;
  cells: number[] = [1, 2];
  _hidden = 9;
  speak() {}
}

describe('the Hierarchy', () => {
  test('lists the loaded scenes with their roots, and each object its children', () => {
    SceneManager.createScene('Map');
    const board = new GameObject('Board');
    const tile = new GameObject('Tile');
    tile.transform.parent = board.transform;
    const [first] = sceneRoots(engine);
    expect(first?.active).toBe(true);
    expect(first?.roots).toContain(board);
    expect(childrenOf(board)).toEqual([tile]);
    expect(allGameObjects(engine)).toEqual(expect.arrayContaining([board, tile]));
  });
});

describe('the Inspector', () => {
  test("shows a script's public fields, each with how it is edited", () => {
    const unit = new GameObject('U').addComponent(Unit);
    const fields = Object.fromEntries(fieldsOf(unit).map((field) => [field.key, field.kind]));
    expect(fields).toEqual({
      moveRange: 'number',
      name2: 'string',
      alive: 'boolean',
      target: 'readonly',
      heading: 'vector3',
      offset: 'vector2',
      tint: 'color',
      cells: 'readonly',
    });
    expect(fieldsOf(unit).find((field) => field.key === 'cells')?.text).toBe('Array(2)');
    expect(fieldsOf(unit.transform)).toEqual([]);
  });

  test('a reference field selects what it points at', () => {
    const unit = new GameObject('U').addComponent(Unit);
    const enemy = new GameObject('Enemy');
    unit.target = enemy;
    const field = fieldsOf(unit).find((item) => item.key === 'target');
    expect(field?.kind).toBe('reference');
    expect(field?.text).toBe('Enemy (GameObject)');
    expect(gameObjectOfReference(field?.value)).toBe(enemy);
    expect(gameObjectOfReference(unit)).toBe(unit.gameObject);
  });

  test('typed text becomes a value of the type the field already has', () => {
    const unit = new GameObject('U').addComponent(Unit);
    setField(unit, 'moveRange', '5.5');
    setField(unit, 'alive', false);
    setField(unit, 'name2', 'Knight');
    setField(unit, 'heading', [1, 0, -1]);
    setField(unit, 'offset', '3, 4');
    setField(unit, 'tint', '#00ff00');
    expect(unit.moveRange).toBe(5.5);
    expect(unit.alive).toBe(false);
    expect(unit.name2).toBe('Knight');
    expect(unit.heading.equals(new Vector3(1, 0, -1))).toBe(true);
    expect(unit.offset.equals(new Vector2(3, 4))).toBe(true);
    expect(colorToHex(unit.tint)).toBe('#00ff00');
  });

  test('text that does not convert is refused and the field keeps its value', () => {
    const unit = new GameObject('U').addComponent(Unit);
    expect(() => setField(unit, 'moveRange', 'fast')).toThrow('moveRange needs 1 numbers, got "fast".');
    expect(() => setField(unit, 'heading', '1, 2')).toThrow('heading needs 3 numbers');
    expect(() => setField(unit, 'cells', '1')).toThrow('cells cannot be edited in the Inspector.');
    expect(unit.moveRange).toBe(3);
  });

  test('a built-in component describes itself', () => {
    const camera = new GameObject('Cam').addComponent(Camera);
    expect(summaryOf(camera)).toContain('fieldOfView');
  });

  test("labels are Unity's nicified variable names", () => {
    expect(nicify('moveRange')).toBe('Move Range');
    expect(nicify('m_Speed')).toBe('Speed');
    expect(nicify('HPMax')).toBe('HP Max');
    expect(nicify('team_id')).toBe('Team id');
  });
});

describe('EditorApplication and Selection', () => {
  test('pausing is remembered, announced once per change, and step() leaves it paused one frame on', () => {
    const states: PauseState[] = [];
    const off = EditorApplication.pauseStateChanged.addListener((state) => states.push(state));
    try {
      expect(EditorApplication.isPlaying).toBe(true);
      expect(EditorApplication.isPaused).toBe(false);
      EditorApplication.isPaused = true;
      EditorApplication.isPaused = true;
      const frame = engine.time.frameCount;
      EditorApplication.step();
      expect(engine.time.frameCount).toBe(frame + 1);
      expect(EditorApplication.isPaused).toBe(true);
      EditorApplication.isPaused = false;
      expect(states).toEqual([PauseState.Paused, PauseState.Unpaused]);
    } finally {
      off();
    }
  });

  test('the selection forgets a destroyed object, and says when it changes', () => {
    let changes = 0;
    const off = Selection.selectionChanged.addListener(() => changes++);
    try {
      const unit = new GameObject('Unit');
      Selection.activeGameObject = unit;
      Selection.activeGameObject = unit;
      expect(Selection.activeTransform).toBe(unit.transform);
      destroyImmediate(unit);
      expect(Selection.activeGameObject).toBeNull();
      expect(changes).toBe(1);
    } finally {
      off();
    }
  });

  test('EditorPrefs keeps typed values and defaults', () => {
    EditorPrefs.setBool('test.flag', true);
    EditorPrefs.setInt('test.count', 4.7);
    EditorPrefs.setString('test.name', 'x');
    expect(EditorPrefs.getBool('test.flag')).toBe(true);
    expect(EditorPrefs.getInt('test.count')).toBe(4);
    expect(EditorPrefs.getString('test.name')).toBe('x');
    expect(EditorPrefs.getFloat('test.missing', 2.5)).toBe(2.5);
    EditorPrefs.deleteKey('test.flag');
    expect(EditorPrefs.hasKey('test.flag')).toBe(false);
  });
});
