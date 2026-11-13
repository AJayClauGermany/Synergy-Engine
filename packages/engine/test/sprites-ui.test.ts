import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as pc from 'playcanvas';
import {
  Camera,
  Canvas,
  CanvasScaler,
  Color,
  Engine,
  GameObject,
  Image,
  instantiate,
  MeshRenderer,
  PrimitiveType,
  Prefab,
  RectTransform,
  ScaleMode,
  Sprite,
  SpriteRenderer,
  Vector2,
  Vector3,
} from '../src';

let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

function texture(width = 128, height = 64): pc.Texture {
  return new pc.Texture(engine.app.graphicsDevice, { width, height });
}

/** Screen rectangle of a UI element in device pixels, origin bottom-left (PlayCanvas's). */
function screenRect(rect: RectTransform): { left: number; bottom: number; right: number; top: number } {
  engine.step();
  const corners = rect.pcElement.screenCorners;
  const [bottomLeft, , topRight] = corners;
  if (!bottomLeft || !topRight) throw new Error('no corners');
  return { left: bottomLeft.x, bottom: bottomLeft.y, right: topRight.x, top: topRight.y };
}

function makeCanvas(): Canvas {
  return new GameObject('Canvas').addComponent(Canvas);
}

function uiChild(parent: GameObject | Canvas, name = 'UI'): GameObject {
  const go = new GameObject(name);
  go.transform.setParent(parent.transform, false);
  return go;
}

describe('Sprite', () => {
  test('has Unity defaults: centred pivot, 100 pixels per unit', () => {
    const sprite = new Sprite(texture(200, 50));
    expect(sprite.rect).toEqual({ x: 0, y: 0, width: 200, height: 50 });
    expect(sprite.pivot).toEqual(new Vector2(0.5, 0.5));
    expect(sprite.size).toEqual(new Vector2(2, 0.5));
    expect(sprite.bounds.min).toEqual(new Vector3(-1, -0.25, 0));
  });

  test('Sprite.create takes a pivot and pixels per unit', () => {
    const sprite = Sprite.create(texture(), { x: 0, y: 0, width: 64, height: 64 }, new Vector2(0.5, 0), 32);
    expect(sprite.size).toEqual(new Vector2(2, 2));
    expect(sprite.bounds.min).toEqual(new Vector3(-1, 0, 0));
    expect(sprite.bounds.max).toEqual(new Vector3(1, 2, 0));
  });
});

describe('SpriteRenderer', () => {
  test('draws a quad sized by pixelsPerUnit around the pivot, facing +Z', () => {
    const go = new GameObject('Coin');
    const renderer = go.addComponent(SpriteRenderer);
    expect(go.entity.render?.meshInstances.length).toBe(0); // no sprite, nothing drawn
    renderer.sprite = new Sprite(texture(200, 100), undefined, { pivot: new Vector2(0, 0) });
    go.transform.position = new Vector3(5, 0, 0);
    const bounds = renderer.bounds;
    expect(bounds.min.x).toBeCloseTo(5);
    expect(bounds.max.x).toBeCloseTo(7);
    expect(bounds.max.y).toBeCloseTo(1);
    expect(bounds.size.z).toBeCloseTo(0);
    expect(go.entity.render?.enabled).toBe(true);
    // Not mistaken for a mesh by the engine.
    expect(go.getComponent(MeshRenderer)).toBeNull();
  });

  test('colour and texture go through an unlit, blended material', () => {
    const renderer = new GameObject('S').addComponent(SpriteRenderer);
    const tex = texture();
    renderer.sprite = new Sprite(tex);
    renderer.color = new Color(1, 0.5, 0, 0.25);
    const material = renderer.pcMaterial;
    expect(material.useLighting).toBe(false);
    expect(material.emissiveMap).toBe(tex);
    expect(material.opacityMap).toBe(tex);
    expect(material.opacity).toBe(0.25);
    expect(material.emissive.g).toBe(0.5);
    expect(material.blendType).toBe(pc.BLEND_NORMAL);
    expect(material.depthWrite).toBe(false);
  });

  test('flipX mirrors the texture coordinates', () => {
    const renderer = new GameObject('S').addComponent(SpriteRenderer);
    renderer.sprite = Sprite.slice(texture(), 2, 1)[0] as Sprite; // left half: u 0 to 0.5
    const firstU = () => {
      const mesh = renderer.gameObject.entity.render?.meshInstances[0]?.mesh;
      const uvs: number[] = [];
      mesh?.getUvs(0, uvs);
      return uvs[0];
    };
    expect(firstU()).toBeCloseTo(0);
    renderer.flipX = true;
    expect(firstU()).toBeCloseTo(0.5);
  });

  test('sortingOrder beats distance when transparent objects are sorted', () => {
    const near = new GameObject('Near').addComponent(SpriteRenderer);
    const far = new GameObject('Far').addComponent(SpriteRenderer);
    near.sprite = far.sprite = new Sprite(texture());
    far.transform.position = new Vector3(0, 0, 10);
    const key = (renderer: SpriteRenderer) => {
      const instance = renderer.gameObject.entity.render?.meshInstances[0];
      if (!instance?.calculateSortDistance) throw new Error('no sort callback');
      // A camera at z = -10 looking along +Z (Unity space), which is z = 10 looking down -Z
      // in PlayCanvas's mirrored space, where this callback runs. Larger keys draw first.
      return instance.calculateSortDistance(instance, new pc.Vec3(0, 0, 10), new pc.Vec3(0, 0, -1));
    };
    expect(key(far)).toBeGreaterThan(key(near)); // far draws first, by distance
    far.sortingOrder = 1;
    expect(key(far)).toBeLessThan(key(near)); // now far draws last, on top
  });

  test('disabling hides it; instantiate copies it', () => {
    const prefab = new Prefab('Unit', (go) => {
      const renderer = go.addComponent(SpriteRenderer);
      renderer.sprite = new Sprite(texture());
      renderer.color = Color.red;
      renderer.sortingOrder = 3;
      renderer.flipX = true;
    });
    const unit = instantiate(prefab, new Vector3(1, 2, 3));
    const renderer = unit.getComponent(SpriteRenderer);
    expect(renderer?.color).toEqual(Color.red);
    expect(renderer?.sortingOrder).toBe(3);
    expect(renderer?.flipX).toBe(true);
    expect(unit.getComponent(MeshRenderer)).toBeNull();
    expect(unit.entity.render?.meshInstances.length).toBe(1);
    expect(unit.entity.render?.enabled).toBe(true);
    expect(renderer?.bounds.center.x).toBeCloseTo(1);
    if (renderer) renderer.enabled = false;
    expect(unit.entity.render?.enabled).toBe(false);
  });
});

describe('Canvas and CanvasScaler', () => {
  test('one canvas unit is one CSS pixel by default', () => {
    const canvas = makeCanvas();
    expect(canvas.scaleFactor).toBeCloseTo(1);
    expect(canvas.size.x).toBeCloseTo(1280);
    expect(canvas.size.y).toBeCloseTo(720);
  });

  test('ConstantPixelSize multiplies by scaleFactor', () => {
    const scaler = makeCanvas().gameObject.addComponent(CanvasScaler);
    scaler.scaleFactor = 2;
    const canvas = scaler.getComponent(Canvas);
    expect(canvas?.scaleFactor).toBeCloseTo(2);
    expect(canvas?.size.x).toBeCloseTo(640);
  });

  test('ScaleWithScreenSize keeps the reference resolution, matching width or height', () => {
    const canvas = makeCanvas();
    const scaler = canvas.gameObject.addComponent(CanvasScaler);
    scaler.uiScaleMode = ScaleMode.ScaleWithScreenSize;
    scaler.referenceResolution = new Vector2(640, 480);
    scaler.matchWidthOrHeight = 0; // width: 1280 / 640
    expect(canvas.scaleFactor).toBeCloseTo(2);
    expect(canvas.size.x).toBeCloseTo(640);
    scaler.matchWidthOrHeight = 1; // height: 720 / 480
    expect(canvas.scaleFactor).toBeCloseTo(1.5);
    scaler.enabled = false;
    expect(canvas.scaleFactor).toBeCloseTo(1);
  });
});

describe('RectTransform', () => {
  test('defaults to a centred 100 x 100 rectangle', () => {
    const rect = uiChild(makeCanvas()).addComponent(RectTransform);
    expect(rect.anchorMin).toEqual(new Vector2(0.5, 0.5));
    expect(rect.pivot).toEqual(new Vector2(0.5, 0.5));
    expect(rect.sizeDelta).toEqual(new Vector2(100, 100));
    expect(rect.anchoredPosition).toEqual(Vector2.zero);
    expect(screenRect(rect)).toEqual({ left: 590, bottom: 310, right: 690, top: 410 });
  });

  test('anchors to a corner with Unity semantics (y up)', () => {
    const rect = uiChild(makeCanvas()).addComponent(RectTransform);
    rect.anchorMin = new Vector2(1, 1);
    rect.anchorMax = new Vector2(1, 1);
    rect.pivot = new Vector2(1, 1);
    rect.sizeDelta = new Vector2(64, 32);
    rect.anchoredPosition = new Vector2(-16, -8);
    expect(screenRect(rect)).toEqual({ left: 1280 - 80, bottom: 720 - 40, right: 1264, top: 712 });
    expect(rect.offsetMin).toEqual(new Vector2(-80, -40));
    expect(rect.offsetMax).toEqual(new Vector2(-16, -8));
  });

  test('stretched anchors follow the parent, with offsets as margins', () => {
    const rect = uiChild(makeCanvas()).addComponent(RectTransform);
    rect.anchorMin = new Vector2(0, 0);
    rect.anchorMax = new Vector2(1, 0);
    rect.offsetMin = new Vector2(10, 0);
    rect.offsetMax = new Vector2(-10, 50);
    expect(screenRect(rect)).toEqual({ left: 10, bottom: 0, right: 1270, top: 50 });
    expect(rect.rect.width).toBeCloseTo(1260);
    expect(rect.sizeDelta).toEqual(new Vector2(-20, 50));
  });

  test('a layout set up before parenting holds once under the canvas; children nest', () => {
    const canvas = makeCanvas();
    const panel = new GameObject('Panel').addComponent(RectTransform);
    panel.anchorMin = Vector2.zero;
    panel.anchorMax = Vector2.zero;
    panel.pivot = Vector2.zero;
    panel.sizeDelta = new Vector2(200, 100);
    panel.anchoredPosition = new Vector2(20, 30);
    panel.transform.setParent(canvas.transform, false);
    expect(screenRect(panel)).toEqual({ left: 20, bottom: 30, right: 220, top: 130 });

    const child = uiChild(panel.gameObject).addComponent(RectTransform);
    child.anchorMin = Vector2.zero;
    child.anchorMax = Vector2.one;
    child.offsetMin = new Vector2(5, 5);
    child.offsetMax = new Vector2(-5, -5);
    expect(screenRect(child)).toEqual({ left: 25, bottom: 35, right: 215, top: 125 });
  });

  test('moving the transform directly updates anchoredPosition', () => {
    const rect = uiChild(makeCanvas()).addComponent(RectTransform);
    rect.transform.localPosition = new Vector3(40, -20, 0);
    expect(rect.anchoredPosition).toEqual(new Vector2(40, -20));
    rect.sizeDelta = new Vector2(10, 10); // must not snap back
    expect(rect.anchoredPosition).toEqual(new Vector2(40, -20));
  });

  test('changing the pivot keeps anchoredPosition, as in Unity', () => {
    const rect = uiChild(makeCanvas()).addComponent(RectTransform);
    rect.anchoredPosition = new Vector2(10, 10);
    rect.pivot = Vector2.zero;
    expect(rect.anchoredPosition).toEqual(new Vector2(10, 10));
    expect(screenRect(rect)).toEqual({ left: 650, bottom: 370, right: 750, top: 470 });
  });
});

describe('Image', () => {
  test('adds a RectTransform and maps a sprite rectangle to PlayCanvas texture space', () => {
    const image = uiChild(makeCanvas()).addComponent(Image);
    expect(image.getComponent(RectTransform)).not.toBeNull();
    const element = image.getComponent(RectTransform)?.pcElement;
    expect(element?.type).toBe(pc.ELEMENTTYPE_IMAGE);
    const tex = texture(128, 64);
    // Top-right quarter of the image, in top-left pixel coordinates.
    image.sprite = new Sprite(tex, { x: 64, y: 0, width: 64, height: 32 });
    expect(element?.texture).toBe(tex);
    expect(element?.rect?.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]); // from the bottom-left
    image.color = new Color(0, 1, 0, 0.5);
    expect(image.color).toEqual(new Color(0, 1, 0, 0.5));
  });

  test('setNativeSize sizes the rectangle to the sprite', () => {
    const image = uiChild(makeCanvas()).addComponent(Image);
    image.sprite = new Sprite(texture(48, 24));
    image.setNativeSize();
    expect(image.getComponent(RectTransform)?.sizeDelta).toEqual(new Vector2(48, 24));
  });

  test('later siblings draw on top; setAsFirstSibling moves one underneath', () => {
    const canvas = makeCanvas();
    const back = uiChild(canvas, 'Back').addComponent(Image);
    const front = uiChild(canvas, 'Front').addComponent(Image);
    const order = (image: Image) => image.getComponent(RectTransform)?.pcElement.drawOrder ?? -1;
    // PlayCanvas assigns UI draw order just before rendering, which headless engines skip.
    const render = () => engine.app.fire('prerender');
    render();
    expect(order(front)).toBeGreaterThan(order(back));
    front.transform.setAsFirstSibling();
    render();
    expect(order(front)).toBeLessThan(order(back));
  });

  test('disabling hides it without breaking the layout of its children', () => {
    const panel = uiChild(makeCanvas()).addComponent(Image);
    const child = uiChild(panel.gameObject).addComponent(Image);
    panel.enabled = false;
    expect(panel.getComponent(RectTransform)?.pcElement.enabled).toBe(false);
    expect(child.getComponent(RectTransform)?.pcElement.enabled).toBe(true);
    const childRect = child.getComponent(RectTransform);
    if (!childRect) throw new Error('missing');
    expect(screenRect(childRect)).toEqual({ left: 590, bottom: 310, right: 690, top: 410 });
  });

  test('instantiate copies a canvas with images', () => {
    const tex = texture();
    const sprite = new Sprite(tex);
    const prefab = new Prefab('HUD', (go) => {
      go.addComponent(Canvas).sortingOrder = 5;
      const icon = new GameObject('Icon');
      icon.transform.setParent(go.transform, false);
      const image = icon.addComponent(Image);
      image.sprite = sprite;
      image.color = Color.yellow;
      const rect = icon.getComponent(RectTransform);
      if (rect) rect.anchoredPosition = new Vector2(100, 0);
    });
    const copy = instantiate(prefab);
    expect(copy.getComponent(Canvas)?.sortingOrder).toBe(5);
    const icon = copy.transform.find('Icon')?.gameObject;
    const image = icon?.getComponent(Image);
    expect(icon?.getComponents(RectTransform).length).toBe(1);
    expect(image?.sprite).toBe(sprite);
    expect(image?.color.equals(Color.yellow)).toBe(true);
    expect(icon?.getComponent(RectTransform)?.anchoredPosition).toEqual(new Vector2(100, 0));
  });
});

test('3D meshes, world sprites and canvas images run together in one scene', () => {
  const camera = new GameObject('Main Camera');
  camera.tag = 'MainCamera';
  camera.addComponent(Camera);
  camera.transform.position = new Vector3(0, 0, 10);
  GameObject.createPrimitive(PrimitiveType.Cube);
  const sprite = new GameObject('Sprite').addComponent(SpriteRenderer);
  sprite.sprite = new Sprite(texture());
  const image = uiChild(makeCanvas()).addComponent(Image);
  image.sprite = new Sprite(texture());
  for (let i = 0; i < 3; i++) engine.step();
  const worldLayer = engine.app.scene.layers.getLayerById(pc.LAYERID_WORLD);
  const uiLayer = engine.app.scene.layers.getLayerById(pc.LAYERID_UI);
  expect(worldLayer?.meshInstances.length).toBe(2); // cube + sprite
  expect(uiLayer?.meshInstances.length).toBe(1);
  // The camera draws the UI layer, so canvas images appear over the 3D view.
  expect(Camera.main?.pcCamera.layers).toContain(pc.LAYERID_UI);
});
