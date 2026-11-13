import {
  Camera,
  Color,
  GameObject,
  Light,
  LightType,
  MeshRenderer,
  PrimitiveType,
  Quaternion,
  RenderSettings,
  type SceneBuilder,
  Vector3,
} from '@synergy/engine';
import { Turntable } from '../behaviours/Turntable';

/**
 * The title screen's scene: a camera, a light and a slowly turning backdrop. The menu
 * itself is HTML (`MenuScreen` in `ui/App.tsx`). Loading this scene is also how a match
 * is left: it replaces the match's scene (see `flow.ts` for networked objects).
 */
export const buildMenuScene: SceneBuilder = () => {
  RenderSettings.ambientLight = new Color(0.4, 0.43, 0.5);

  const camera = new GameObject('Main Camera');
  camera.tag = 'MainCamera';
  const lens = camera.addComponent(Camera);
  lens.backgroundColor = Color.fromHex('#141b24');
  lens.fieldOfView = 40;
  camera.transform.position = new Vector3(0, 4, -9);
  camera.transform.lookAt(new Vector3(0, 0.5, 0));

  const sun = new GameObject('Sun').addComponent(Light);
  sun.type = LightType.Directional;
  sun.transform.rotation = Quaternion.euler(50, -30, 0); // Unity's default sun

  const table = new GameObject('Backdrop');
  table.addComponent(Turntable);
  const colours = ['#3b6fb6', '#b64a3b', '#4a6b3f', '#b07a43'];
  colours.forEach((hex, index) => {
    const piece = GameObject.createPrimitive(index % 2 === 0 ? PrimitiveType.Capsule : PrimitiveType.Cube);
    piece.transform.setParent(table.transform, false);
    const angle = (index / colours.length) * Math.PI * 2;
    piece.transform.localPosition = new Vector3(Math.cos(angle) * 2.2, 0.6, Math.sin(angle) * 2.2);
    piece.transform.localScale = new Vector3(0.7, 0.7, 0.7);
    const renderer = piece.getComponent(MeshRenderer);
    if (renderer) renderer.material.color = Color.fromHex(hex);
  });
  const ground = GameObject.createPrimitive(PrimitiveType.Plane);
  ground.transform.localScale = new Vector3(0.6, 1, 0.6);
  const groundRenderer = ground.getComponent(MeshRenderer);
  if (groundRenderer) groundRenderer.material.color = Color.fromHex('#26303d');
};
