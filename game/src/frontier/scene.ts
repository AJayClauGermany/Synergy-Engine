import {
  Camera,
  Color,
  Engine,
  GameObject,
  Light,
  LightShadows,
  LightType,
  RenderSettings,
  type SceneDefinition,
  TilePalette,
  Vector3,
} from '@synergy/engine';
import { CameraRig } from '../behaviours/CameraRig';
import terrainUrl from './data/terrain.png' with { type: 'file' };
import { FrontierBoard } from './FrontierBoard';
import { FrontierPlayer } from './FrontierPlayer';
import { type Terrain, tiles } from './rules';

/** The name the match scene is registered under, on every machine. */
export const FRONTIER_SCENE = 'Frontier';

/**
 * The match scene: everything that is the same on every machine and is not networked.
 * The host loads it for everyone with `networkManager.sceneManager.loadScene`, then
 * spawns the Match and the Soldiers into it (see session.ts).
 *
 *   Camera Rig (CameraRig)
 *     Main Camera (Camera)        tag: MainCamera
 *   Sun (Light)
 *   Board (FrontierBoard)         the map, built from data/map.json and data/tiles.json
 *   Player (FrontierPlayer)       this machine's selection, fog and clicks
 *
 * `preload` loads the tile images before `build` runs, so the scene appears complete.
 */
export const frontierScene: SceneDefinition<TilePalette<Terrain>> = {
  preload: () =>
    // A headless engine (tests) cannot decode images: the tiles fall back to flat colours.
    Engine.current?.isHeadless
      ? TilePalette.create<Terrain>(tiles)
      : TilePalette.load<Terrain>(tiles, { images: { 'terrain.png': terrainUrl } }),

  build: (_scene, palette) => {
    RenderSettings.ambientLight = new Color(0.5, 0.52, 0.56);

    const rig = new GameObject('Camera Rig').addComponent(CameraRig);
    rig.distance = 17;
    rig.maxDistance = 26;
    rig.bounds = 8;
    const camera = new GameObject('Main Camera');
    camera.tag = 'MainCamera';
    camera.transform.setParent(rig.transform, false);
    const lens = camera.addComponent(Camera);
    lens.fieldOfView = 40;
    lens.backgroundColor = Color.fromHex('#141b24');
    rig.camera = camera.transform;

    const sun = new GameObject('Sun').addComponent(Light);
    sun.type = LightType.Directional;
    sun.intensity = 1.1;
    sun.shadows = LightShadows.Soft;
    sun.shadowDistance = 50;
    sun.direction = new Vector3(-0.45, -1, 0.6);

    const board = new GameObject('Board').addComponent(FrontierBoard);
    board.palette = palette;

    const player = new GameObject('Player').addComponent(FrontierPlayer);
    player.board = board;
  },
};
