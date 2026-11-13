import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Engine, findObjectsByType, SceneManager } from '@synergy/engine';
import { GameController } from '../src/behaviours/GameController';
import { flow, frontierManager, openScreen, quitToMenu } from '../src/flow';
import { Soldier } from '../src/frontier/Soldier';
import { parseLaunchOptions } from '../src/localPlay';
import { buildMenuScene } from '../src/scenes/MenuScene';
import { buildSkirmishScene } from '../src/scenes/SkirmishScene';

describe('launch options', () => {
  test('an ordinary window', () => {
    expect(parseLaunchOptions('')).toEqual({ net: 'online', host: null, join: null, player: null });
  });

  test('a test player window joining a local room', () => {
    expect(parseLaunchOptions('?scene=Frontier&net=local&join=ab12cd&player=3')).toEqual({
      net: 'local',
      host: null,
      join: 'AB12CD',
      player: 3,
    });
    expect(parseLaunchOptions('?host=ROOM&player=zero').player).toBeNull();
  });
});

describe('screens', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = Engine.createHeadless();
    SceneManager.register('Menu', buildMenuScene);
    SceneManager.register('Skirmish', buildSkirmishScene);
  });

  afterEach(() => {
    engine.dispose();
  });

  test('menu -> Skirmish -> menu replaces the scene and its controller', async () => {
    await openScreen('Menu');
    expect(flow.value).toEqual({ screen: 'Menu', loading: null });
    expect(SceneManager.getActiveScene().name).toBe('Menu');

    const opening = openScreen('Skirmish');
    // The overlay is up while the scene loads.
    expect(flow.value.loading).toBe('Skirmish');
    await opening;
    engine.stepFrames(2);
    expect(GameController.instance).not.toBeNull();

    await quitToMenu();
    engine.stepFrames(1);
    expect(GameController.instance).toBeNull();
    expect(flow.value.screen).toBe('Menu');
  });

  test('a screen whose scene fails to load leaves the previous screen in place', async () => {
    await openScreen('Menu');
    // Showcase is not registered in this test, so its load throws.
    await expect(openScreen('Showcase')).rejects.toThrow();
    expect(flow.value).toEqual({ screen: 'Menu', loading: null });
  });

  test('leaving Frontier shuts its network down, so no networked object outlives the match', async () => {
    await openScreen('Frontier');
    engine.stepFrames(3);
    const manager = frontierManager();
    expect(manager.isServer).toBe(true);
    expect(findObjectsByType(Soldier).length).toBeGreaterThan(0);

    await quitToMenu();
    engine.stepFrames(2);
    expect(manager.isListening).toBe(false);
    expect(findObjectsByType(Soldier)).toHaveLength(0);
    expect(SceneManager.getActiveScene().name).toBe('Menu');
  });
});
