import {
  Camera,
  Color,
  GameObject,
  Light,
  LightShadows,
  LightType,
  RenderSettings,
  type SceneBuilder,
  Vector3,
} from '@synergy/engine';
import { BoardView } from '../behaviours/BoardView';
import { CameraRig } from '../behaviours/CameraRig';
import { GameController } from '../behaviours/GameController';

/**
 * The scene, as code. In Unity you would build this hierarchy in the editor:
 *
 *   Camera Rig (CameraRig)
 *     Main Camera (Camera)       tag: MainCamera
 *   Sun (Light)
 *   Board (BoardView, BoxCollider)
 *   Game Controller (GameController)
 */
export const buildSkirmishScene: SceneBuilder = () => {
  RenderSettings.ambientLight = new Color(0.42, 0.45, 0.5);

  const rig = new GameObject('Camera Rig').addComponent(CameraRig);
  // Look at a point slightly in front of the board's centre, leaving room for the HUD at the bottom.
  rig.transform.position = new Vector3(0, 0, 0.9);
  rig.distance = 14;
  const camera = new GameObject('Main Camera');
  camera.tag = 'MainCamera';
  camera.transform.setParent(rig.transform, false);
  const lens = camera.addComponent(Camera);
  lens.fieldOfView = 40;
  lens.backgroundColor = Color.fromHex('#1d2733');
  rig.camera = camera.transform;

  const sun = new GameObject('Sun').addComponent(Light);
  sun.type = LightType.Directional;
  sun.intensity = 1.1;
  sun.shadows = LightShadows.Soft;
  sun.shadowDistance = 40;
  sun.direction = new Vector3(-0.45, -1, -0.6);

  const board = new GameObject('Board').addComponent(BoardView);

  const controller = new GameObject('Game Controller').addComponent(GameController);
  controller.board = board;
};
