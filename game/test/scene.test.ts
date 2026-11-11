import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Camera, Engine, GameObject, Grid, Hex, KeyCode, SceneManager, Tilemap, TilemapRenderer } from '@synergy/engine';
import { BoardView } from '../src/behaviours/BoardView';
import { GameController } from '../src/behaviours/GameController';
import { UnitView } from '../src/behaviours/UnitView';
import { hud, unitMarkers } from '../src/hud';
import { COLUMNS, MAX_HP, reachable, ROWS, type Unit, unitById } from '../src/rules/skirmish';
import { buildSkirmishScene } from '../src/scenes/SkirmishScene';

/**
 * The whole scene running without a browser: real scripts, real picking, simulated
 * mouse and keyboard. This is the fastest way to check gameplay changes.
 */
let engine: Engine;
let board: BoardView;

beforeEach(async () => {
  engine = Engine.createHeadless();
  SceneManager.register('Skirmish', buildSkirmishScene);
  await SceneManager.loadScene('Skirmish');
  engine.stepFrames(2);
  board = GameObject.find('Board')?.getComponent(BoardView) as BoardView;
});

afterEach(() => {
  engine.dispose();
});

function clickCell(x: number, y: number) {
  const camera = Camera.main as Camera;
  const screen = camera.worldToScreenPoint(board.cellToWorld({ x, y }));
  engine.input.moveMouse(screen.x, screen.y);
  engine.input.pressMouseButton(0);
  engine.step();
  engine.input.releaseMouseButton(0);
  engine.step();
}

function pressKey(key: string) {
  engine.input.pressKey(key);
  engine.step();
  engine.input.releaseKey(key);
  engine.step();
}

describe('Skirmish scene', () => {
  test('builds the hierarchy described in the scene file', () => {
    expect(GameObject.find('Camera Rig/Main Camera')).not.toBeNull();
    expect(Camera.main?.gameObject.name).toBe('Main Camera');
    expect(GameObject.find('Board')?.getComponent(Grid)).not.toBeNull();
    const terrain = GameObject.find('Board/Terrain')?.getComponent(Tilemap);
    expect(terrain?.getUsedTilesCount()).toBe(COLUMNS * ROWS);
    // One draw call for the whole map: a map this small fits in a single block of tiles.
    expect(terrain?.getComponent(TilemapRenderer)?.pcMeshInstances.length).toBe(1);
    // Forest tiles spawned their trees.
    expect(terrain?.getInstantiatedObject({ x: 2, y: 1 })?.name).toBe('Tree');
    expect(GameController.instance).not.toBeNull();
    expect(unitMarkers.value.length).toBe(8);
    expect(hud.value).toMatchObject({ turn: 0, turnNumber: 1, winner: null, localTeam: 0 });
  });

  test('the mouse picks hex cells through the grid, and misses outside the map', () => {
    const camera = Camera.main as Camera;
    for (const cell of [{ x: 0, y: 0 }, { x: 4, y: 3 }, { x: 8, y: 7 }, { x: 2, y: 5 }]) {
      const ray = camera.screenPointToRay(camera.worldToScreenPoint(board.cellToWorld(cell)));
      expect(board.rayToCell(ray)).toEqual(cell);
    }
    expect(board.rayToCell(camera.screenPointToRay({ x: 2, y: 2 }))).toBeNull();
  });

  test('clicking a unit and then a tile walks it there along the path', () => {
    const controller = GameController.instance as GameController;
    clickCell(3, 0);
    expect(hud.value.selected?.id).toBe(1);
    // The highlight layer shows the selection and where it can go.
    const overlay = GameObject.find('Board/Highlight')?.getComponent(Tilemap) as Tilemap;
    expect(overlay.hasTile({ x: 3, y: 0 })).toBe(true);
    expect(overlay.hasTile({ x: 3, y: 2 })).toBe(true);
    expect(overlay.hasTile({ x: 4, y: 3 })).toBe(false); // water

    clickCell(3, 2);
    expect(unitById(controller.current, 1)).toMatchObject({ x: 3, y: 2, moved: true });
    const view = unitMarkers.value.find((marker) => marker.id === 1)?.gameObject as GameObject;
    expect(view.getComponent(UnitView)).not.toBeNull();
    // The piece walks over several frames rather than teleporting.
    expect(view.transform.position.equals(board.cellToWorld({ x: 3, y: 2 }))).toBe(false);
    engine.stepSeconds(1);
    expect(view.transform.position.equals(board.cellToWorld({ x: 3, y: 2 }), 1e-3)).toBe(true);
  });

  test('illegal clicks deselect, Space ends the turn, Escape deselects', () => {
    clickCell(3, 0);
    clickCell(3, 6); // Too far: treated as a click on empty ground, which deselects.
    expect(hud.value.selected).toBeNull();
    clickCell(3, 7); // An enemy unit cannot be selected.
    expect(hud.value.selected).toBeNull();

    clickCell(3, 0);
    pressKey(KeyCode.Escape);
    expect(hud.value.selected).toBeNull();

    pressKey(KeyCode.Space);
    expect(hud.value).toMatchObject({ turn: 1, turnNumber: 2 });
    // Hot-seat: the single local player now controls Red.
    clickCell(3, 7);
    expect(hud.value.selected?.team).toBe(1);
  });

  test('a unit can march across the map and attack, with the views animating', () => {
    const controller = GameController.instance as GameController;
    const targetId = 5; // the red unit that starts at (3, 7)
    // Each Blue turn: step toward the target; attack once adjacent. Red just passes.
    for (let turn = 0; turn < 12 && unitById(controller.current, targetId)?.hp === MAX_HP; turn++) {
      const state = controller.current;
      const unit = unitById(state, 1) as Unit;
      const target = unitById(state, targetId) as Unit;
      if (Hex.distance(unit, target) > 1) {
        const options = reachable(state, unit).sort((a, b) => Hex.distance(a, target) - Hex.distance(b, target));
        const step = options[0] as { x: number; y: number };
        controller.submit({ type: 'move', unit: 1, x: step.x, y: step.y });
      }
      const moved = unitById(controller.current, 1) as Unit;
      if (Hex.distance(moved, target) === 1) controller.submit({ type: 'attack', unit: 1, target: targetId });
      engine.stepSeconds(0.5); // let the walk, lunge and hit reaction play
      controller.endTurn();
      controller.endTurn();
    }
    expect(unitById(controller.current, targetId)?.hp).toBe(MAX_HP - 2);
    expect(unitMarkers.value.find((marker) => marker.id === targetId)?.hp).toBe(MAX_HP - 2);
    // After the animations the attacker stands exactly on its cell again.
    engine.stepSeconds(1);
    const attacker = unitById(controller.current, 1) as Unit;
    const view = unitMarkers.value.find((marker) => marker.id === 1)?.gameObject as GameObject;
    expect(view.transform.position.equals(board.cellToWorld(attacker), 1e-3)).toBe(true);
  });

  test('destroying the scene cleans up', async () => {
    SceneManager.register('Empty', () => {});
    await SceneManager.loadScene('Empty');
    expect(GameController.instance).toBeNull();
    expect(unitMarkers.value).toEqual([]);
  });
});
