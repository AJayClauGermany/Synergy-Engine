import * as pc from 'playcanvas';
import { MonoBehaviour } from '../core/MonoBehaviour';
import { currentEngine } from '../core/runtime';
import { cellCorners, inverseSwizzle, planeNormal } from '../grid/layout';
import { Material, type Texture } from '../components/rendering';
import { Tilemap } from './Tilemap';

/** Geometry being collected for all tiles that share one texture. */
interface Batch {
  texture: Texture | null;
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
  translucent: boolean;
}

/**
 * Draws the Tilemap on the same GameObject. Unity: `TilemapRenderer`.
 *
 * All tiles are merged into one mesh per texture, so a large map costs a draw call or
 * two rather than one per tile. The mesh is rebuilt (once, at the end of the frame)
 * whenever the tilemap or its grid changes.
 */
export class TilemapRenderer extends MonoBehaviour {
  static readonly disallowMultiple = true;
  static readonly requireComponents = [Tilemap];

  /**
   * Which layer is on top. Unity sorts 2D layers by this number; in 3D the layers are
   * physically separated instead: each step lifts this layer `sortingStep` units off
   * the grid's surface, which avoids flickering between layers that would otherwise
   * occupy the same plane.
   */
  sortingOrder = 0;
  /** Distance between consecutive `sortingOrder` values, in world units. */
  sortingStep = 0.01;
  /**
   * Use the alpha channel of tile textures as transparency (cut-out sprites, soft edges).
   * Tiles whose colour has an alpha below 1 are always blended, with or without this.
   */
  transparent = false;
  /** Whether the tiles respond to scene lights and shadows. Turn off for a flat 2D look. */
  lit = true;

  private _tilemap: Tilemap | null = null;
  private _render: pc.RenderComponent | null = null;
  private _signature = '';
  private _base: Material | null = null;

  /**
   * The material the tiles are drawn with. Tile colours arrive as vertex colours and
   * tile textures replace its `mainTexture`, so use this for everything else (smoothness,
   * emission, or a custom PlayCanvas setup through `pcMaterial`).
   */
  get material(): Material {
    if (!this._base) {
      this._base = new Material();
      this._base.name = 'Tilemap';
      this._base.smoothness = 0.1;
    }
    return this._base;
  }

  set material(value: Material) {
    this._base = value;
    this._signature = '';
  }

  awake() {
    this._tilemap = this.getComponent(Tilemap);
  }

  onEnable() {
    this.rebuild();
  }

  onDisable() {
    if (this._render) this._render.enabled = false;
  }

  onDestroy() {
    if (this._render && !this.gameObject.isDestroyed) this._render.meshInstances = [];
  }

  lateUpdate() {
    if (this.signature() !== this._signature) this.rebuild();
  }

  /** Everything the mesh depends on. When this string changes, the mesh is stale. */
  private signature(): string {
    const tilemap = this._tilemap;
    if (!tilemap) return '';
    return [
      tilemap._version,
      tilemap._layoutVersion,
      this.sortingOrder,
      this.sortingStep,
      this.transparent,
      this.lit,
    ].join(':');
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this._base = source._base;
  }

  /** Rebuilds the mesh right now. It happens automatically; call this only to force it early. */
  rebuild(): void {
    const tilemap = this._tilemap ?? this.getComponent(Tilemap);
    if (!tilemap) return;
    this._tilemap = tilemap;
    const entity = this.gameObject.entity;
    this._render ??=
      entity.render ?? (entity.addComponent('render', { type: 'asset', castShadows: false }) as pc.RenderComponent);

    const shape = tilemap._shape;
    const normal = planeNormal(shape);
    const lift = normal.mul(this.sortingOrder * this.sortingStep);
    const tint = tilemap.color;
    const batches = new Map<Texture | null, Batch>();

    for (const entry of tilemap._entries.values()) {
      const data = entry.tile.getTileData(entry.cell, tilemap);
      const texture = data.sprite?.texture ?? null;
      let batch = batches.get(texture);
      if (!batch) {
        batch = { texture, positions: [], normals: [], uvs: [], colors: [], indices: [], translucent: false };
        batches.set(texture, batch);
      }

      const cell = entry.color;
      const r = data.color.r * tint.r * (cell?.r ?? 1);
      const g = data.color.g * tint.g * (cell?.g ?? 1);
      const b = data.color.b * tint.b * (cell?.b ?? 1);
      const a = data.color.a * tint.a * (cell?.a ?? 1);
      if (a < 0.999) batch.translucent = true;

      const corners = cellCorners(shape, entry.cell);
      // Winding must be counter-clockwise seen from the side the normal points to.
      const first = corners[0];
      const second = corners[1];
      const third = corners[2];
      if (first && second && third && second.sub(first).cross(third.sub(first)).dot(normal) < 0) corners.reverse();

      // Texture coordinates come from where each corner sits inside the cell's bounding box.
      const base = batch.positions.length / 3;
      let minU = Number.POSITIVE_INFINITY;
      let maxU = Number.NEGATIVE_INFINITY;
      let minV = Number.POSITIVE_INFINITY;
      let maxV = Number.NEGATIVE_INFINITY;
      // Back in layout axes (x across the map, y up the map), whatever plane the grid is on.
      const flat = corners.map((corner): [number, number] => {
        const p = inverseSwizzle(shape.cellSwizzle, corner);
        return [p.x, p.y];
      });
      for (const [u, v] of flat) {
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
      const [u0, v0, u1, v1] = data.sprite?.uv ?? [0, 1, 1, 0];
      corners.forEach((corner, index) => {
        const point = corner.add(lift);
        batch.positions.push(point.x, point.y, point.z);
        batch.normals.push(normal.x, normal.y, normal.z);
        const [u, v] = flat[index] as [number, number];
        const s = maxU > minU ? (u - minU) / (maxU - minU) : 0;
        const t = maxV > minV ? (v - minV) / (maxV - minV) : 0;
        batch.uvs.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
        batch.colors.push(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255));
      });
      for (let i = 1; i < corners.length - 1; i++) batch.indices.push(base, base + i, base + i + 1);
    }

    const device = currentEngine().app.graphicsDevice;
    const instances: pc.MeshInstance[] = [];
    for (const batch of batches.values()) {
      const geometry = new pc.Geometry();
      geometry.positions = batch.positions;
      geometry.normals = batch.normals;
      geometry.uvs = batch.uvs;
      geometry.colors = batch.colors;
      geometry.indices = batch.indices;
      instances.push(new pc.MeshInstance(pc.Mesh.fromGeometry(device, geometry), this.materialFor(batch)));
    }
    // Assigning the list releases the previous meshes.
    this._render.meshInstances = instances;
    this._render.enabled = this.enabled;
    this._render.receiveShadows = this.lit;
    this._signature = this.signature();
  }

  private materialFor(batch: Batch): pc.StandardMaterial {
    const material = this.material.pcMaterial.clone() as pc.StandardMaterial;
    // Tile colours are authored like every other colour (sRGB), so have the shader
    // convert them; otherwise they come out washed-out next to ordinary materials.
    material.vertexColorGamma = true;
    material.useLighting = this.lit;
    if (this.lit) {
      material.diffuseVertexColor = true;
      material.diffuseMap = batch.texture;
    } else {
      // Without lighting the diffuse colour contributes nothing; emission is what shows.
      material.diffuse.set(0, 0, 0);
      material.emissive.set(1, 1, 1);
      material.emissiveVertexColor = true;
      material.emissiveMap = batch.texture;
    }
    // Flat maps are often seen from both sides (and from below in 2D set-ups).
    material.cull = pc.CULLFACE_NONE;
    material.twoSidedLighting = true;
    const textureAlpha = this.transparent && batch.texture !== null;
    if (batch.translucent || textureAlpha) {
      material.blendType = pc.BLEND_NORMAL;
      material.depthWrite = false;
      material.opacityVertexColor = true;
      material.opacityVertexColorChannel = 'a';
      if (textureAlpha) {
        material.opacityMap = batch.texture;
        material.opacityMapChannel = 'a';
      }
    }
    material.update();
    return material;
  }
}
