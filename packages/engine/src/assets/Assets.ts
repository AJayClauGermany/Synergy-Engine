import * as pc from 'playcanvas';
import { type GameObject, gameObjectOf } from '../core/GameObject';
import { currentEngine } from '../core/runtime';
import type { Transform } from '../core/Transform';
import type { Texture } from '../components/rendering';

function load<T>(url: string, type: string): Promise<pc.Asset & { resource: T }> {
  const engine = currentEngine();
  const cacheKey = `asset:${type}:${url}`;
  const cached = engine.cache.get(cacheKey) as Promise<pc.Asset & { resource: T }> | undefined;
  if (cached) return cached;
  const promise = new Promise<pc.Asset & { resource: T }>((resolve, reject) => {
    engine.app.assets.loadFromUrl(url, type, (error, asset) => {
      if (error || !asset) reject(new Error(`Failed to load ${type} "${url}": ${error ?? 'unknown error'}`));
      else resolve(asset as pc.Asset & { resource: T });
    });
  });
  engine.cache.set(cacheKey, promise);
  // A failed load should be retried next time rather than cached forever.
  promise.catch(() => engine.cache.delete(cacheKey));
  return promise;
}

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
   */
  instantiate(parent: Transform | null = null): GameObject {
    const engine = currentEngine();
    const entity = this.container.instantiateRenderEntity();
    entity.name = this.name;
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
    const name = url.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Model';
    return new Model(name, asset.resource);
  }

  /** Loads an image as a texture, e.g. for `material.mainTexture`. */
  static async loadTexture(url: string): Promise<Texture> {
    return (await load<Texture>(url, 'texture')).resource;
  }
}

