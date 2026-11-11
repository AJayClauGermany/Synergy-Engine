import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour, Component } from '../core/Component';
import type { Engine } from '../core/Engine';
import type { GameObject } from '../core/GameObject';
import { adopters, PrimitiveType } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { Color } from '../math/Color';
import { Bounds } from '../math/geometry';
import type { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';

/** A GPU texture. This is PlayCanvas's own class; load one with `Assets.loadTexture(url)`. */
export type Texture = pc.Texture;

// ---- Mesh -------------------------------------------------------------------------------

function buildPrimitive(device: pc.GraphicsDevice, type: PrimitiveType): pc.Mesh {
  // Sizes follow Unity's built-in primitives.
  switch (type) {
    case PrimitiveType.Cube:
      return pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
    case PrimitiveType.Sphere:
      return pc.Mesh.fromGeometry(
        device,
        new pc.SphereGeometry({ radius: 0.5, latitudeBands: 24, longitudeBands: 32 }),
      );
    case PrimitiveType.Capsule:
      return pc.Mesh.fromGeometry(device, new pc.CapsuleGeometry({ radius: 0.5, height: 2 }));
    case PrimitiveType.Cylinder:
      return pc.Mesh.fromGeometry(device, new pc.CylinderGeometry({ radius: 0.5, height: 2, capSegments: 32 }));
    case PrimitiveType.Plane:
      return pc.Mesh.fromGeometry(
        device,
        new pc.PlaneGeometry({ halfExtents: new pc.Vec2(5, 5), widthSegments: 10, lengthSegments: 10 }),
      );
    case PrimitiveType.Quad: {
      const geometry = new pc.Geometry();
      geometry.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
      geometry.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
      // PlayCanvas texture coordinates have v = 0 at the top of the image.
      geometry.uvs = [0, 1, 1, 1, 1, 0, 0, 0];
      geometry.indices = [0, 1, 2, 0, 2, 3];
      return pc.Mesh.fromGeometry(device, geometry);
    }
  }
}

/**
 * Geometry that a MeshFilter can show. Three ways to get one:
 *
 *   Mesh.primitive(PrimitiveType.Cube)        // shared built-in shape
 *   const mesh = new Mesh();                   // build your own (e.g. a hex tile)
 *   mesh.vertices = [...]; mesh.triangles = [...]; mesh.recalculateNormals();
 *   // or from a loaded model, via its MeshFilter
 *
 * Triangles are COUNTER-clockwise when seen from the front (Unity's are clockwise),
 * because the world is right-handed.
 */
export class Mesh {
  name = 'Mesh';
  /** Corner positions. Reassign the array (and call `markDirty`) after changing it. */
  vertices: Vector3[] = [];
  /** Indices into `vertices`, three per triangle. */
  triangles: number[] = [];
  /** One normal per vertex. Leave empty and call `recalculateNormals()` to generate them. */
  normals: Vector3[] = [];
  /** One texture coordinate per vertex. Optional. */
  uv: Vector2[] = [];

  private primitiveType: PrimitiveType | null = null;
  private wrapped: pc.Mesh[] | null = null;
  private built: pc.Mesh | null = null;
  private autoNormals = false;

  private static readonly primitives = new Map<PrimitiveType, Mesh>();

  /** A shared built-in shape. The same `Mesh` object is returned for the same type. */
  static primitive(type: PrimitiveType): Mesh {
    let mesh = Mesh.primitives.get(type);
    if (!mesh) {
      mesh = new Mesh();
      mesh.name = type;
      mesh.primitiveType = type;
      Mesh.primitives.set(type, mesh);
    }
    return mesh;
  }

  /** Wraps existing PlayCanvas meshes (one per sub-mesh). */
  static fromPlayCanvas(meshes: pc.Mesh | pc.Mesh[], name = 'Mesh'): Mesh {
    const mesh = new Mesh();
    mesh.name = name;
    mesh.wrapped = Array.isArray(meshes) ? meshes : [meshes];
    return mesh;
  }

  /** Generates smooth normals from the triangles when the mesh is next built. */
  recalculateNormals(): void {
    this.autoNormals = true;
    this.markDirty();
  }

  /** Call after editing `vertices`/`triangles`/`normals`/`uv` in place, then reassign the mesh to its MeshFilter. */
  markDirty(): void {
    this.built = null;
  }

  /** Axis-aligned bounds in the mesh's own space. */
  get bounds(): Bounds {
    const meshes = this._resolve(currentEngine());
    let bounds: Bounds | null = null;
    for (const mesh of meshes) {
      const min = Vector3.from(mesh.aabb.getMin());
      const max = Vector3.from(mesh.aabb.getMax());
      bounds = bounds ? bounds.encapsulate(min).encapsulate(max) : Bounds.fromMinMax(min, max);
    }
    return bounds ?? new Bounds();
  }

  /** @internal The PlayCanvas meshes to render, one per sub-mesh. */
  _resolve(engine: Engine): pc.Mesh[] {
    if (this.wrapped) return this.wrapped;
    const device = engine.app.graphicsDevice;
    if (this.primitiveType) {
      const key = `mesh:${this.primitiveType}`;
      let mesh = engine.cache.get(key) as pc.Mesh | undefined;
      if (!mesh) {
        mesh = buildPrimitive(device, this.primitiveType);
        // Shared by many renderers; never let reference counting free it.
        mesh.incRefCount();
        engine.cache.set(key, mesh);
      }
      return [mesh];
    }
    if (!this.built || this.built.device !== device) {
      if (this.vertices.length === 0) return [];
      const geometry = new pc.Geometry();
      geometry.positions = this.vertices.flatMap((v) => [v.x, v.y, v.z]);
      geometry.indices = [...this.triangles];
      if (this.uv.length === this.vertices.length) geometry.uvs = this.uv.flatMap((v) => [v.x, v.y]);
      if (this.normals.length === this.vertices.length && !this.autoNormals) {
        geometry.normals = this.normals.flatMap((v) => [v.x, v.y, v.z]);
      } else {
        geometry.calculateNormals();
      }
      this.built = pc.Mesh.fromGeometry(device, geometry);
      this.built.incRefCount();
    }
    return [this.built];
  }
}

// ---- Material ---------------------------------------------------------------------------

const wrappers = new WeakMap<pc.Material, Material>();

/**
 * How a surface looks. A thin layer over PlayCanvas's `StandardMaterial` exposing the
 * properties Unity's Standard/Lit shader users reach for first.
 *
 *   const red = new Material();
 *   red.color = Color.red;
 *   renderer.sharedMaterial = red;      // many renderers can share it
 *   renderer.material.color = Color.blue; // or give this renderer its own copy
 */
export class Material {
  /** The PlayCanvas material, for anything not wrapped here (normal maps, custom shaders, ...). Call `.update()` after changing it. */
  readonly pcMaterial: pc.StandardMaterial;

  constructor(source?: Material) {
    this.pcMaterial = source ? (source.pcMaterial.clone() as pc.StandardMaterial) : new pc.StandardMaterial();
    if (!source) {
      this.pcMaterial.useMetalness = true;
      this.pcMaterial.metalness = 0;
      this.pcMaterial.gloss = 0.5;
      this.pcMaterial.update();
    }
    wrappers.set(this.pcMaterial, this);
  }

  /** @internal The wrapper for a PlayCanvas material, created on first use. */
  static _wrap(material: pc.Material): Material {
    const existing = wrappers.get(material);
    if (existing) return existing;
    const wrapper = Object.create(Material.prototype) as Material;
    (wrapper as { pcMaterial: pc.Material }).pcMaterial = material;
    wrappers.set(material, wrapper);
    return wrapper;
  }

  /** @internal The engine-wide default material (plain white). */
  static _default(engine: Engine): Material {
    let material = engine.cache.get('material:default') as Material | undefined;
    if (!material) {
      material = new Material();
      material.name = 'Default-Material';
      engine.cache.set('material:default', material);
    }
    return material;
  }

  get name(): string {
    return this.pcMaterial.name;
  }

  set name(value: string) {
    this.pcMaterial.name = value;
  }

  /** Base colour. An alpha below 1 makes the material transparent. */
  get color(): Color {
    const { r, g, b } = this.pcMaterial.diffuse;
    return new Color(r, g, b, this.pcMaterial.opacity);
  }

  set color(value: Color) {
    this.pcMaterial.diffuse.set(value.r, value.g, value.b);
    this.pcMaterial.opacity = value.a;
    this.pcMaterial.blendType = value.a < 1 ? pc.BLEND_NORMAL : pc.BLEND_NONE;
    this.pcMaterial.depthWrite = value.a >= 1;
    this.pcMaterial.update();
  }

  /** Base colour texture. */
  get mainTexture(): Texture | null {
    return this.pcMaterial.diffuseMap ?? null;
  }

  set mainTexture(value: Texture | null) {
    this.pcMaterial.diffuseMap = value;
    this.pcMaterial.update();
  }

  /** 0 = non-metal, 1 = metal. */
  get metallic(): number {
    return this.pcMaterial.metalness;
  }

  set metallic(value: number) {
    this.pcMaterial.useMetalness = true;
    this.pcMaterial.metalness = value;
    this.pcMaterial.update();
  }

  /** 0 = rough, 1 = mirror-like. */
  get smoothness(): number {
    return this.pcMaterial.gloss;
  }

  set smoothness(value: number) {
    this.pcMaterial.gloss = value;
    this.pcMaterial.update();
  }

  /** Light the surface gives off by itself. Black means none. */
  get emissionColor(): Color {
    const { r, g, b } = this.pcMaterial.emissive;
    return new Color(r, g, b, 1);
  }

  set emissionColor(value: Color) {
    this.pcMaterial.emissive.set(value.r, value.g, value.b);
    this.pcMaterial.update();
  }
}

// ---- MeshFilter / MeshRenderer ----------------------------------------------------------

function renderComponent(gameObject: GameObject): pc.RenderComponent {
  const entity = gameObject.entity;
  return (
    entity.render ??
    (entity.addComponent('render', { type: 'asset', castShadows: true, receiveShadows: true }) as pc.RenderComponent)
  );
}

/** Pushes the MeshFilter's mesh and the MeshRenderer's materials into PlayCanvas. */
function syncRender(gameObject: GameObject, rebuildMeshes: boolean): void {
  const filter = gameObject.getComponent(MeshFilter);
  const renderer = gameObject.getComponent(MeshRenderer);
  const render = renderComponent(gameObject);
  const engine = currentEngine();
  const materials = renderer?._materials ?? [];
  const fallback = Material._default(engine);
  const materialAt = (index: number) => (materials[index] ?? materials[materials.length - 1] ?? fallback).pcMaterial;

  if (rebuildMeshes) {
    const meshes = filter?._mesh?._resolve(engine) ?? [];
    render.meshInstances = meshes.map((mesh, index) => new pc.MeshInstance(mesh, materialAt(index)));
  } else {
    render.meshInstances.forEach((instance, index) => {
      instance.material = materialAt(index);
    });
  }
  // As in Unity, a mesh with no renderer is invisible.
  render.enabled = !!renderer && renderer.enabled;
}

/** Holds the mesh a MeshRenderer on the same GameObject draws. */
export class MeshFilter extends Component {
  static readonly disallowMultiple = true;

  /** @internal */
  _mesh: Mesh | null = null;

  override _attach(): void {
    const existing = this.gameObject.entity.render;
    if (existing && existing.meshInstances.length > 0) {
      // Adopting a PlayCanvas render component (glTF model or a clone).
      this._mesh = Mesh.fromPlayCanvas(
        existing.meshInstances.flatMap((instance) => (instance.mesh ? [instance.mesh] : [])),
        this.gameObject.name,
      );
    } else {
      syncRender(this.gameObject, true);
    }
  }

  get mesh(): Mesh | null {
    return this._mesh;
  }

  set mesh(value: Mesh | null) {
    this._mesh = value;
    syncRender(this.gameObject, true);
  }

  /** Alias of `mesh`. (Unity distinguishes instanced and shared meshes; here they are the same.) */
  get sharedMesh(): Mesh | null {
    return this._mesh;
  }

  set sharedMesh(value: Mesh | null) {
    this.mesh = value;
  }

  override _destroy(): void {
    this._mesh = null;
    if (!this.gameObject.isDestroyed) syncRender(this.gameObject, true);
  }

  override _copyFrom(source: this): void {
    // PlayCanvas already cloned the mesh instances; just share the same Mesh object.
    this._mesh = source._mesh;
  }
}

/** Draws the MeshFilter's mesh with one or more materials. */
export class MeshRenderer extends Behaviour {
  static readonly disallowMultiple = true;

  /** @internal */
  _materials: Material[] = [];
  private ownsMaterials = false;

  override _attach(): void {
    const existing = this.gameObject.entity.render;
    if (existing && existing.meshInstances.length > 0) {
      const fallback = Material._default(currentEngine());
      this._materials = existing.meshInstances.map((instance) =>
        instance.material ? Material._wrap(instance.material) : fallback,
      );
      existing.enabled = this._enabled;
    } else {
      this._materials = [Material._default(currentEngine())];
      syncRender(this.gameObject, false);
    }
  }

  override _enabledChanged(): void {
    renderComponent(this.gameObject).enabled = this._enabled;
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed) renderComponent(this.gameObject).enabled = false;
  }

  /** The material as assigned, possibly shared with other renderers. Changing it affects all of them. */
  get sharedMaterial(): Material {
    return this._materials[0] ?? Material._default(currentEngine());
  }

  set sharedMaterial(value: Material) {
    this.sharedMaterials = [value];
  }

  get sharedMaterials(): Material[] {
    return [...this._materials];
  }

  set sharedMaterials(value: Material[]) {
    this._materials = [...value];
    this.ownsMaterials = false;
    syncRender(this.gameObject, false);
  }

  /**
   * This renderer's own material. The first time you read it, the shared material is
   * copied so that changes affect only this object (Unity does the same).
   */
  get material(): Material {
    return this.materials[0] as Material;
  }

  set material(value: Material) {
    this._materials = [value];
    this.ownsMaterials = true;
    syncRender(this.gameObject, false);
  }

  get materials(): Material[] {
    if (!this.ownsMaterials) {
      this._materials = (this._materials.length ? this._materials : [Material._default(currentEngine())]).map(
        (material) => new Material(material),
      );
      this.ownsMaterials = true;
      syncRender(this.gameObject, false);
    }
    return [...this._materials];
  }

  set materials(value: Material[]) {
    this._materials = [...value];
    this.ownsMaterials = true;
    syncRender(this.gameObject, false);
  }

  get castShadows(): boolean {
    return renderComponent(this.gameObject).castShadows;
  }

  set castShadows(value: boolean) {
    renderComponent(this.gameObject).castShadows = value;
  }

  get receiveShadows(): boolean {
    return renderComponent(this.gameObject).receiveShadows;
  }

  set receiveShadows(value: boolean) {
    renderComponent(this.gameObject).receiveShadows = value;
  }

  /** World-space bounding box of everything this renderer draws. */
  get bounds(): Bounds {
    let bounds: Bounds | null = null;
    for (const instance of renderComponent(this.gameObject).meshInstances) {
      const min = Vector3.from(instance.aabb.getMin());
      const max = Vector3.from(instance.aabb.getMax());
      bounds = bounds ? bounds.encapsulate(min).encapsulate(max) : Bounds.fromMinMax(min, max);
    }
    return bounds ?? new Bounds(this.transform.position, Vector3.zero);
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    // The clone shares the original's materials until it asks for its own.
    this._materials = [...source._materials];
    this.ownsMaterials = false;
  }
}

adopters.push((gameObject, entity) => {
  if (!entity.render) return;
  if (!gameObject.getComponent(MeshFilter)) gameObject.addComponent(MeshFilter);
  if (!gameObject.getComponent(MeshRenderer)) gameObject.addComponent(MeshRenderer);
});

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(MeshFilter, 'MeshFilter');
nameType(MeshRenderer, 'MeshRenderer');
