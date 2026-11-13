import * as pc from 'playcanvas';
import { type GameObject, gameObjectOf } from '../core/GameObject';
import { currentEngine } from '../core/runtime';
import type { Transform } from '../core/Transform';
import type { Texture } from '../components/rendering';
import { Sprite, type SpriteOptions } from '../components/Sprite';

function load<T>(url: string, type: string, data: Record<string, unknown> = {}): Promise<pc.Asset & { resource: T }> {
  const engine = currentEngine();
  const cacheKey = `asset:${type}:${JSON.stringify(data)}:${url}`;
  const cached = engine.cache.get(cacheKey) as Promise<pc.Asset & { resource: T }> | undefined;
  if (cached) return cached;
  const promise = new Promise<pc.Asset & { resource: T }>((resolve, reject) => {
    const name = url.startsWith('data:') ? type : (url.split(/[?#]/)[0]?.split('/').pop() ?? type);
    const asset = new pc.Asset(name, type, { url }, data);
    asset.once('load', () => resolve(asset as pc.Asset & { resource: T }));
    asset.once('error', (error: unknown) => {
      // PlayCanvas reports a message; anything else has no text worth printing.
      const reason = typeof error === 'string' ? error : error instanceof Error ? error.message : 'unknown error';
      reject(new Error(`Failed to load ${type} "${url}": ${reason}`));
    });
    engine.app.assets.add(asset);
    engine.app.assets.load(asset);
  });
  engine.cache.set(cacheKey, promise);
  // A failed load should be retried next time rather than cached forever.
  promise.catch(() => engine.cache.delete(cacheKey));
  return promise;
}

const HALF_TURN = new pc.Quat().setFromEulerAngles(0, 180, 0);

/** A loaded 3D model (glTF/GLB). Call `instantiate()` for each copy you want in the scene. */
export class Model {
  /** @internal */
  constructor(
    readonly name: string,
    private readonly container: pc.ContainerResource,
  ) {}

  /**
   * Adds a copy of the model to the active scene (or under `parent`) and returns its
   * root GameObject. Child nodes are regular GameObjects with MeshFilter/MeshRenderer.
   *
   * As with Unity's glTF importers, the model faces the root's `transform.forward` (+Z)
   * and keeps its handedness (text on it reads the right way round). The nodes inside
   * are turned 180 degrees about Y to get there, so their local rotations differ from
   * the same model imported into Unity; place and turn the root instead.
   */
  instantiate(parent: Transform | null = null): GameObject {
    const engine = currentEngine();
    const entity = this.container.instantiateRenderEntity();
    entity.name = this.name;
    // glTF content faces +Z in its right-handed space, which is -Z (backward) once the
    // engine's mirror to Unity's space is applied. A half turn about Y puts it facing
    // forward with its handedness intact: exactly where Unity's importers put it.
    for (const child of entity.children) {
      const position = child.getLocalPosition();
      child.setLocalPosition(-position.x, position.y, -position.z);
      child.setLocalRotation(new pc.Quat().mul2(HALF_TURN, child.getLocalRotation()));
    }
    (parent ? parent._node : engine.scenes.targetScene._root).addChild(entity);
    return engine.lifecycle.runDeferred(() => gameObjectOf(entity));
  }
}

/**
 * Loads files at runtime. Unity's closest equivalents are `Resources.Load` and
 * Addressables. Everything is asynchronous and cached by URL, so load in an `async`
 * scene builder or a coroutine (`yield Assets.loadModel(url)` works).
 *
 * URLs are relative to the page. With Bun's bundler, import the file to get its URL:
 *
 *   import knightUrl from '../assets/knight.glb' with { type: 'file' };
 *   const knight = await Assets.loadModel(knightUrl);
 *   knight.instantiate();
 */
export class Assets {
  /** Loads a `.glb` / `.gltf` model. */
  static async loadModel(url: string): Promise<Model> {
    const asset = await load<pc.ContainerResource>(url, 'container');
    const name =
      url
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? 'Model';
    return new Model(name, asset.resource);
  }

  /**
   * Loads an image as a texture, e.g. for `material.mainTexture` or `new Sprite(texture)`.
   *
   * Images are colour data stored in sRGB by default, like Unity's "sRGB (Color Texture)"
   * import setting, which every renderer (meshes, sprites, tiles, UI) decodes correctly.
   * Pass `{ srgb: false }` for data textures such as normal maps or masks.
   */
  static async loadTexture(url: string, options: { srgb?: boolean } = {}): Promise<Texture> {
    return (await load<Texture>(url, 'texture', { srgb: options.srgb ?? true })).resource;
  }

  /**
   * Loads an image as a Sprite covering the whole image, for a `SpriteRenderer` or a UI
   * `Image`. For sprite sheets, load the texture and use `Sprite.slice`.
   */
  static async loadSprite(url: string, options: SpriteOptions = {}): Promise<Sprite> {
    return new Sprite(await Assets.loadTexture(url), undefined, options);
  }
}
