import * as pc from 'playcanvas';
import { MonoBehaviour } from '../core/MonoBehaviour';
import { currentEngine } from '../core/runtime';
import { cellCorners, cellToLocal, type GridShape, inverseSwizzle, planeNormal } from '../grid/layout';
import type { Color } from '../math/Color';
import type { Vector3 } from '../math/Vector3';
import { Material, type Texture } from '../components/rendering';
import { Tilemap, type TilemapEntry } from './Tilemap';

/** Geometry being collected for the tiles of one block that share a texture. */
interface Batch {
  texture: Texture | null;
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
  translucent: boolean;
}

/** What every cell of a layout has in common, worked out once per rebuild instead of once per cell. */
interface CellTemplate {
  shape: GridShape;
  normal: Vector3;
  tint: Color;
  /** Each corner as an offset from `cellToLocal(cell)`, wound counter-clockwise, already lifted by the sorting order. */
  corners: Vector3[];
  /** Where each corner sits inside the cell's bounding box, 0 to 1 on both axes: its place in the sprite. */
  fractions: [number, number][];
}

/**
 * Draws the Tilemap on the same GameObject. Unity: `TilemapRenderer`.
 *
 * The map is drawn in blocks of 16 x 16 cells (Unity's "Chunk" mode): each block is one
 * mesh per texture it uses. Changing a cell rebuilds only its block, at the end of the
 * frame, so a map of tens of thousands of tiles stays cheap to edit while it is on
 * screen, and blocks outside the camera's view are not drawn.
 *
 * The meshes are handed straight to PlayCanvas's world layer rather than through a
 * `render` component, which would rebuild all of them whenever one changed.
 * `pcMeshInstances` is the escape hatch.
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
  /** True while the meshes are in the world layer, that is, while this renderer is switched on. */
  private _shown = false;
  private _built = false;
  private _signature = '';
  private _base: Material | null = null;
  /** The meshes of each block, by block key. */
  private _blocks = new Map<string, pc.MeshInstance[]>();
  /** One material per texture and blending mode (opaque, blended), shared by every block. */
  private _materials = new Map<Texture | null, [pc.StandardMaterial | null, pc.StandardMaterial | null]>();

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

  /** The PlayCanvas mesh instances being drawn: one per block and texture. An escape hatch. */
  get pcMeshInstances(): pc.MeshInstance[] {
    return [...this._blocks.values()].flat();
  }

  onEnable() {
    this._shown = true;
    this.rebuild();
  }

  onDisable() {
    this._shown = false;
    this.layer()?.removeMeshInstances(this.pcMeshInstances);
  }

  onDestroy() {
    this.release();
  }

  private layer(): pc.Layer | null {
    return currentEngine().app.scene?.layers?.getLayerById(pc.LAYERID_WORLD) ?? null;
  }

  lateUpdate() {
    this.refresh(false);
  }

  /**
   * Everything all blocks depend on. When this string changes, every mesh is stale.
   * Changes to individual cells are tracked by the tilemap, block by block.
   */
  private signature(): string {
    const tilemap = this._tilemap;
    if (!tilemap) return '';
    return [tilemap._layoutVersion, this.sortingOrder, this.sortingStep, this.transparent, this.lit].join(':');
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this._base = source._base;
  }

  /** Rebuilds every mesh right now. It happens automatically; call this only to force it early. */
  rebuild(): void {
    this.refresh(true);
  }

  /** Brings the meshes up to date: all of them, or only the blocks whose cells changed. */
  private refresh(everything: boolean): void {
    const tilemap = this._tilemap ?? this.getComponent(Tilemap);
    if (!tilemap) return;
    this._tilemap = tilemap;
    const signature = this.signature();
    const dirty = tilemap._takeDirtyChunks();
    const all = everything || dirty === null || signature !== this._signature || !this._built;
    if (!all && dirty.size === 0) return;

    const layer = this.layer();
    if (all) this.release();
    const template = this.template(tilemap);
    const entity = this.gameObject.entity;
    for (const key of all ? tilemap._chunks.keys() : dirty) {
      const previous = this._blocks.get(key);
      if (previous) {
        layer?.removeMeshInstances(previous);
        for (const instance of previous) instance.destroy();
      }
      const entries = tilemap._chunks.get(key);
      if (!entries) {
        this._blocks.delete(key);
        continue;
      }
      const instances = this.build(entries, tilemap, template);
      for (const instance of instances) {
        instance.node = entity; // drawn wherever the tilemap's transform puts it
        instance.castShadow = false;
        instance.receiveShadow = this.lit;
      }
      this._blocks.set(key, instances);
      if (this._shown) layer?.addMeshInstances(instances);
    }
    this._built = true;
    this._signature = signature;
  }

  /** Takes every mesh out of the scene and frees it, with the materials made for them. */
  private release(): void {
    const instances = this.pcMeshInstances;
    this.layer()?.removeMeshInstances(instances);
    for (const instance of instances) instance.destroy();
    this._blocks.clear();
    for (const pair of this._materials.values()) for (const material of pair) material?.destroy();
    this._materials.clear();
  }

  private template(tilemap: Tilemap): CellTemplate {
    const shape = tilemap._shape;
    const normal = planeNormal(shape);
    const lift = normal.mul(this.sortingOrder * this.sortingStep);
    const origin = { x: 0, y: 0, z: 0 };
    const anchor = cellToLocal(shape, origin);
    const outline = cellCorners(shape, origin);
    // Winding must be counter-clockwise seen from the side the normal points to.
    const [first, second, third] = outline;
    if (first && second && third && second.sub(first).cross(third.sub(first)).dot(normal) < 0) outline.reverse();

    // Texture coordinates come from where each corner sits inside the cell's bounding box,
    // measured in layout axes (x across the map, y up the map) whatever plane the grid is on.
    const flat = outline.map((corner): [number, number] => {
      const p = inverseSwizzle(shape.cellSwizzle, corner);
      return [p.x, p.y];
    });
    const us = flat.map(([u]) => u);
    const vs = flat.map(([, v]) => v);
    const minU = Math.min(...us);
    const maxU = Math.max(...us);
    const minV = Math.min(...vs);
    const maxV = Math.max(...vs);
    return {
      shape,
      normal,
      tint: tilemap.color,
      corners: outline.map((corner) => corner.sub(anchor).add(lift)),
      fractions: flat.map(([u, v]) => [maxU > minU ? (u - minU) / (maxU - minU) : 0, maxV > minV ? (v - minV) / (maxV - minV) : 0]),
    };
  }

  /** The meshes for one block: one per texture its tiles use. */
  private build(entries: Iterable<TilemapEntry>, tilemap: Tilemap, template: CellTemplate): pc.MeshInstance[] {
    const { shape, normal, tint, corners, fractions } = template;
    const batches = new Map<Texture | null, Batch>();

    for (const entry of entries) {
      const data = entry.tile.getTileData(entry.cell, tilemap);
      const texture = data.sprite?.texture ?? null;
      let batch = batches.get(texture);
      if (!batch) {
        batch = { texture, positions: [], normals: [], uvs: [], colors: [], indices: [], translucent: false };
        batches.set(texture, batch);
      }

      const cell = entry.color;
      const r = Math.round(data.color.r * tint.r * (cell?.r ?? 1) * 255);
      const g = Math.round(data.color.g * tint.g * (cell?.g ?? 1) * 255);
      const b = Math.round(data.color.b * tint.b * (cell?.b ?? 1) * 255);
      const alpha = data.color.a * tint.a * (cell?.a ?? 1);
      const a = Math.round(alpha * 255);
      if (alpha < 0.999) batch.translucent = true;

      const at = cellToLocal(shape, entry.cell);
      const base = batch.positions.length / 3;
      const [u0, v0, u1, v1] = data.sprite?.uv ?? [0, 1, 1, 0];
      for (let i = 0; i < corners.length; i++) {
        const corner = corners[i] as Vector3;
        const [s, t] = fractions[i] as [number, number];
        batch.positions.push(at.x + corner.x, at.y + corner.y, at.z + corner.z);
        batch.normals.push(normal.x, normal.y, normal.z);
        batch.uvs.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
        batch.colors.push(r, g, b, a);
      }
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
    return instances;
  }

  private materialFor(batch: Batch): pc.StandardMaterial {
    const textureAlpha = this.transparent && batch.texture !== null;
    const blended = batch.translucent || textureAlpha;
    let pair = this._materials.get(batch.texture);
    if (!pair) {
      pair = [null, null];
      this._materials.set(batch.texture, pair);
    }
    const existing = pair[blended ? 1 : 0];
    if (existing) return existing;

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
    if (blended) {
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
    pair[blended ? 1 : 0] = material;
    return material;
  }
}
