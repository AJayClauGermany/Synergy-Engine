import {
  Assets,
  Camera,
  Canvas,
  Color,
  GameObject,
  Image,
  Light,
  LightType,
  MeshRenderer,
  PrimitiveType,
  RectTransform,
  RenderSettings,
  type SceneBuilder,
  type Sprite,
  SpriteRenderer,
  Vector2,
  Vector3,
} from '@synergy/engine';

/**
 * 3D meshes, 2D sprites and UI images in one scene, as in Unity. Open it with
 * `?scene=Showcase`.
 *
 *   Main Camera (Camera)          Sun (Light)
 *   Ground, Crate, Ball           3D primitives (a loaded glTF Model works the same way)
 *   Tree x3, Coin x2              SpriteRenderer: flat images standing in the 3D world
 *   Canvas (Canvas)               screen-space UI, drawn over everything
 *     Panel (Image)               a plain translucent rectangle
 *       Coin Icon (Image)         a sprite, anchored to the panel
 *     Badge (Image)               anchored to the top-right corner
 *
 * The images are drawn at load time so the template ships without binary assets; in a
 * real game use `Assets.loadSprite(url)` with an imported PNG.
 */
export const buildShowcaseScene: SceneBuilder = async () => {
  RenderSettings.ambientLight = new Color(0.45, 0.47, 0.52);

  const camera = new GameObject('Main Camera');
  camera.tag = 'MainCamera';
  const lens = camera.addComponent(Camera);
  lens.backgroundColor = Color.fromHex('#1d2733');
  lens.fieldOfView = 45;
  camera.transform.position = new Vector3(0, 2.4, -7);
  camera.transform.lookAt(new Vector3(0, 0.8, 0));

  const sun = new GameObject('Sun').addComponent(Light);
  sun.type = LightType.Directional;
  sun.direction = new Vector3(-0.4, -1, 0.5);

  // ---- 3D ----
  const ground = GameObject.createPrimitive(PrimitiveType.Plane);
  ground.transform.localScale = new Vector3(1.4, 1, 1);
  const groundRenderer = ground.getComponent(MeshRenderer);
  if (groundRenderer) groundRenderer.material.color = Color.fromHex('#4a6b3f');

  const crate = GameObject.createPrimitive(PrimitiveType.Cube);
  crate.name = 'Crate';
  crate.transform.position = new Vector3(-0.6, 0.5, -1);
  crate.transform.eulerAngles = new Vector3(0, -30, 0);
  const crateRenderer = crate.getComponent(MeshRenderer);
  if (crateRenderer) crateRenderer.material.color = Color.fromHex('#b07a43');

  const ball = GameObject.createPrimitive(PrimitiveType.Sphere);
  ball.name = 'Ball';
  ball.transform.position = new Vector3(1.8, 0.5, -0.5);
  const ballRenderer = ball.getComponent(MeshRenderer);
  if (ballRenderer) ballRenderer.material.color = Color.fromHex('#5b8bd6');

  // ---- 2D sprites in the world ----
  const tree = await drawSprite(
    128,
    192,
    (g) => {
      g.fillStyle = '#6b4a2b';
      g.fillRect(54, 140, 20, 52);
      g.fillStyle = '#2f8f4e';
      for (const [top, half, base] of [
        [0, 60, 90],
        [40, 64, 140],
        [80, 64, 160],
      ] as const) {
        g.beginPath();
        g.moveTo(64, top);
        g.lineTo(64 + half, base);
        g.lineTo(64 - half, base);
        g.closePath();
        g.fill();
      }
    },
    new Vector2(0.5, 0),
  ); // pivot at the trunk's base, so trees stand on the ground

  const coin = await drawSprite(96, 96, (g) => {
    g.fillStyle = '#f2c230';
    g.strokeStyle = '#9a6b10';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(48, 48, 40, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#9a6b10';
    g.font = 'bold 44px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('$', 48, 50);
  });

  // The left tree is behind the crate: the crate hides part of it through the depth buffer.
  for (const [x, z] of [
    [-1.1, 0.6],
    [-2.6, 1.5],
    [2.9, 1.2],
  ] as const) {
    const go = new GameObject('Tree');
    go.addComponent(SpriteRenderer).sprite = tree;
    go.transform.position = new Vector3(x, 0, z);
  }
  for (const [x, y, z] of [
    [0.6, 1.1, -1.6],
    [1.3, 0.9, -1.9],
  ] as const) {
    const go = new GameObject('Coin');
    const renderer = go.addComponent(SpriteRenderer);
    renderer.sprite = coin;
    go.transform.position = new Vector3(x, y, z);
    go.transform.localScale = new Vector3(0.5, 0.5, 0.5);
  }

  // ---- UI images on a canvas ----
  const canvas = new GameObject('Canvas').addComponent(Canvas);

  const panel = uiObject('Panel', canvas.transform).addComponent(Image);
  panel.color = new Color(0.07, 0.09, 0.12, 0.75);
  const panelRect = rectOf(panel);
  panelRect.anchorMin = panelRect.anchorMax = panelRect.pivot = new Vector2(0, 1); // top-left
  panelRect.anchoredPosition = new Vector2(16, -16);
  panelRect.sizeDelta = new Vector2(180, 64);

  const icon = uiObject('Coin Icon', panel.transform).addComponent(Image);
  icon.sprite = coin;
  const iconRect = rectOf(icon);
  iconRect.anchorMin = iconRect.anchorMax = iconRect.pivot = new Vector2(0, 0.5); // left middle
  iconRect.anchoredPosition = new Vector2(12, 0);
  iconRect.sizeDelta = new Vector2(44, 44);

  const bar = uiObject('Bar', panel.transform).addComponent(Image);
  bar.color = Color.fromHex('#f2c230');
  const barRect = rectOf(bar);
  barRect.anchorMin = new Vector2(0, 0.5); // stretched across the panel's right part
  barRect.anchorMax = new Vector2(1, 0.5);
  barRect.offsetMin = new Vector2(68, -6);
  barRect.offsetMax = new Vector2(-14, 6);

  const badge = uiObject('Badge', canvas.transform).addComponent(Image);
  badge.sprite = tree;
  badge.setNativeSize();
  const badgeRect = rectOf(badge);
  badgeRect.anchorMin = badgeRect.anchorMax = badgeRect.pivot = new Vector2(1, 1); // top-right
  badgeRect.anchoredPosition = new Vector2(-16, -16);
  badgeRect.sizeDelta = badgeRect.sizeDelta.mul(0.5);
};

function uiObject(name: string, parent: GameObject['transform']): GameObject {
  const go = new GameObject(name);
  go.transform.setParent(parent, false);
  return go;
}

function rectOf(image: Image): RectTransform {
  const rect = image.getComponent(RectTransform);
  if (!rect) throw new Error('Image without RectTransform');
  return rect;
}

/** Paints an image on a 2D canvas and loads it as a Sprite. */
async function drawSprite(
  width: number,
  height: number,
  paint: (g: CanvasRenderingContext2D) => void,
  pivot?: Vector2,
): Promise<Sprite> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  paint(context);
  return Assets.loadSprite(canvas.toDataURL('image/png'), { pivot });
}
