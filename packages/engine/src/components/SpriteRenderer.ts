import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour } from '../core/Component';
import { currentEngine } from '../core/runtime';
import { Color } from '../math/Color';
import { Bounds } from '../math/geometry';
import { Mathf } from '../math/Mathf';
import { Vector3 } from '../math/Vector3';
import type { Sprite } from './Sprite';

/**
 * Sort keys are "distance from the camera, minus sortingOrder x this", so a higher
 * sortingOrder always wins over distance (as in Unity, where sorting layer and order come
 * before depth). PlayCanvas adds `drawBucket x 1e9` on top, so the order is clamped to
 * keep the sum below that.
 */
const SORT_STEP = 1e4;
const MAX_SORTING_ORDER = 32767;

/**
 * Draws a `Sprite` in the world: a flat, textured rectangle on the transform's XY plane,
 * facing +Z (toward an unrotated camera, which looks along -Z). Unity: `SpriteRenderer`.
 *
 *   const coin = new GameObject('Coin');
 *   coin.addComponent(SpriteRenderer).sprite = await Assets.loadSprite(coinUrl);
 *
 * Sprites live in the same scene as 3D models: they are depth-tested against them (a
 * cube in front hides a sprite behind it), and are alpha-blended and sorted with other
 * transparent objects, farthest first, unless `sortingOrder` says otherwise.
 *
 * Like Unity's default sprite material, sprites are unlit and visible from both sides.
 * For a billboard that always faces the camera, rotate the transform toward it in
 * `lateUpdate` (`transform.rotation = Camera.main.transform.rotation`).
 */
export class SpriteRenderer extends Behaviour {
  static readonly disallowMultiple = true;

  private component!: pc.RenderComponent;
  private readonly materialInstance = new pc.StandardMaterial();
  private _sprite: Sprite | null = null;
  private _color = Color.white;
  private _flipX = false;
  private _flipY = false;
  private _sortingOrder = 0;

  /** The PlayCanvas material, for effects not wrapped here (additive blending, a custom shader). */
  get pcMaterial(): pc.StandardMaterial {
    return this.materialInstance;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    this.component =
      entity.render ??
      (entity.addComponent('render', { type: 'asset', castShadows: false, receiveShadows: false }) as pc.RenderComponent);
    this.component.castShadows = false;
    this.component.receiveShadows = false;
    const material = this.materialInstance;
    material.name = 'Sprite';
    material.useLighting = false;
    material.useSkybox = false;
    // Without lighting the diffuse colour contributes nothing; emission is what shows.
    material.diffuse.set(0, 0, 0);
    material.blendType = pc.BLEND_NORMAL;
    material.depthWrite = false;
    material.cull = pc.CULLFACE_NONE;
    this.rebuild();
  }

  override _enabledChanged(): void {
    this.component.enabled = this._enabled;
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed) this.gameObject.entity.removeComponent('render');
    this.materialInstance.destroy();
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this._sprite = source._sprite;
    this._color = source._color;
    this._flipX = source._flipX;
    this._flipY = source._flipY;
    this._sortingOrder = source._sortingOrder;
    this.rebuild();
  }

  /** The sprite to draw. `null` draws nothing. */
  get sprite(): Sprite | null {
    return this._sprite;
  }

  set sprite(value: Sprite | null) {
    this._sprite = value;
    this.rebuild();
  }

  /** Tint multiplied with the sprite. An alpha below 1 fades it. */
  get color(): Color {
    return this._color;
  }

  set color(value: Color) {
    this._color = value;
    this.updateMaterial();
  }

  /** Mirror horizontally, without changing the transform's scale. */
  get flipX(): boolean {
    return this._flipX;
  }

  set flipX(value: boolean) {
    this._flipX = value;
    this.rebuild();
  }

  /** Mirror vertically. */
  get flipY(): boolean {
    return this._flipY;
  }

  set flipY(value: boolean) {
    this._flipY = value;
    this.rebuild();
  }

  /**
   * Higher numbers draw on top of lower ones, whatever their distance from the camera.
   * Equal numbers are drawn farthest first. Ordinary transparent 3D objects count as 0.
   * Opaque objects are not affected: they hide sprites behind them through the depth buffer.
   * Range -32768 to 32767, as in Unity. (There are no sorting layers.)
   */
  get sortingOrder(): number {
    return this._sortingOrder;
  }

  set sortingOrder(value: number) {
    this._sortingOrder = Mathf.clamp(Math.round(value), -MAX_SORTING_ORDER - 1, MAX_SORTING_ORDER);
  }

  /** World-space bounding box of the drawn sprite. */
  get bounds(): Bounds {
    const instance = this.component.meshInstances[0];
    if (!instance) return new Bounds(this.transform.position, Vector3.zero);
    return Bounds.fromMinMax(Vector3.from(instance.aabb.getMin()), Vector3.from(instance.aabb.getMax()));
  }

  private updateMaterial(): void {
    const material = this.materialInstance;
    const texture = this._sprite?.texture ?? null;
    const { r, g, b, a } = this._color;
    material.emissive.set(r, g, b);
    material.emissiveMap = texture;
    material.opacity = a;
    material.opacityMap = texture;
    material.opacityMapChannel = 'a';
    material.update();
  }

  private rebuild(): void {
    this.updateMaterial();
    const sprite = this._sprite;
    if (!sprite) {
      // Assigning the list releases the previous mesh.
      this.component.meshInstances = [];
      this.component.enabled = this._enabled;
      return;
    }
    const { min, max } = sprite.bounds;
    let [u0, v0, u1, v1] = sprite.uv;
    if (this._flipX) [u0, u1] = [u1, u0];
    if (this._flipY) [v0, v1] = [v1, v0];
    const geometry = new pc.Geometry();
    // Bottom-left, bottom-right, top-right, top-left; counter-clockwise seen from +Z.
    geometry.positions = [min.x, min.y, 0, max.x, min.y, 0, max.x, max.y, 0, min.x, max.y, 0];
    geometry.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    geometry.uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
    geometry.indices = [0, 1, 2, 0, 2, 3];
    const mesh = pc.Mesh.fromGeometry(currentEngine().app.graphicsDevice, geometry);
    const instance = new pc.MeshInstance(mesh, this.materialInstance);
    instance.calculateSortDistance = (meshInstance, cameraPosition, cameraForward) => {
      const center = meshInstance.aabb.center;
      const distance =
        (center.x - cameraPosition.x) * cameraForward.x +
        (center.y - cameraPosition.y) * cameraForward.y +
        (center.z - cameraPosition.z) * cameraForward.z;
      return distance - this._sortingOrder * SORT_STEP;
    };
    this.component.meshInstances = [instance];
    this.component.enabled = this._enabled;
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(SpriteRenderer, 'SpriteRenderer');
