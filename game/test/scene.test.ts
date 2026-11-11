import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Camera, Engine, GameObject, KeyCode, SceneManager, Vector3 } from '@synergy/engine';
import { cellToWorld, worldToCell } from '../src/behaviours/BoardView';
import { GameController } from '../src/behaviours/GameController';
import { UnitView } from '../src/behaviours/UnitView';
import { hud, unitMarkers } from '../src/hud';
import { unitById } from '../src/rules/skirmish';
import { buildSkirmishScene } from '../src/scenes/SkirmishScene';

/**
 * The whole scene running without a browser: real scripts, real raycasts, simulated
 * mouse and keyboard. This is the fastest way to check gameplay changes.
 */
let engine: Engine;

beforeEach(async () => {
  engine = Engine.createHeadless();
  SceneManager.register('Skirmish', buildSkirmishScene);
  await SceneManager.loadScene('Skirmish');
  engine.stepFrames(2);
});

afterEach(() => {
  engine.dispose();
});

function clickCell(x: number, y: number) {
  const camera = Camera.main as Camera;
  const screen = camera.worldToScreenPoint(cellToWorld({ x, y }));
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
    expect(GameObject.find('Board')?.transform.childCount).toBe(64);
    expect(GameController.instance).not.toBeNull();
    expect(unitMarkers.value.length).toBe(8);
    expect(hud.value).toMatchObject({ turn: 0, turnNumber: 1, winner: null, localTeam: 0 });
  });

  test('cell <-> world mapping round-trips', () => {
    expect(worldToCell(cellToWorld({ x: 2, y: 5 }))).toEqual({ x: 2, y: 5 });
    expect(worldToCell(new Vector3(40, 0, 0))).toBeNull();
  });

  test('clicking a unit and then a tile moves it, with the view following', () => {
    const controller = GameController.instance as GameController;
    clickCell(3, 0);
    expect(hud.value.selected?.id).toBe(1);
    clickCell(3, 2);
    expect(unitById(controller.current, 1)).toMatchObject({ x: 3, y: 2, moved: true });

    const view = unitMarkers.value.find((marker) => marker.id === 1)?.gameObject as GameObject;
    expect(view.getComponent(UnitView)).not.toBeNull();
    // The piece slides over several frames rather than teleporting.
    expect(view.transform.position.equals(cellToWorld({ x: 3, y: 2 }))).toBe(false);
    engine.stepSeconds(1);
    expect(view.transform.position.equals(cellToWorld({ x: 3, y: 2 }), 1e-3)).toBe(true);
  });

  test('illegal clicks are explained, Space ends the turn, Escape deselects', () => {
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

  test('destroying the scene cleans up', async () => {
    SceneManager.register('Empty', () => {});
    await SceneManager.loadScene('Empty');
    expect(GameController.instance).toBeNull();
    expect(unitMarkers.value).toEqual([]);
  });
});
