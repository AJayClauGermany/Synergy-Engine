import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour, Component } from '../core/Component';
import type { Engine } from '../core/Engine';
import type { GameObject } from '../core/GameObject';
import { adopters, PrimitiveType } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { fromPlayCanvasAabb } from '../core/handedness';
import { Color } from '../math/Color';
import { Bounds } from '../math/geometry';
import { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';

/** A GPU texture. This is PlayCanvas's own class; load one with `Assets.loadTexture(url)`. */
export type Texture = pc.Texture;

// ---- Mesh -------------------------------------------------------------------------------

/** A built-in shape, in PlayCanvas's space (right-handed, counter-clockwise, v = 0 at the top). */
function primitiveGeometry(type: PrimitiveType): pc.Geometry {
  // Sizes follow Unity's built-in primitives.
  switch (type) {
    case PrimitiveType.Cube:
      return new pc.BoxGeometry();
    case PrimitiveType.Sphere:
      return new pc.SphereGeometry({ radius: 0.5, latitudeBands: 24, longitudeBands: 32 });
    case PrimitiveType.Capsule:
      return new pc.CapsuleGeometry({ radius: 0.5, height: 2 });
    case PrimitiveType.Cylinder:
      return new pc.CylinderGeometry({ radius: 0.5, height: 2, capSegments: 32 });
    case PrimitiveType.Plane:
      return new pc.PlaneGeometry({ halfExtents: new pc.Vec2(5, 5), widthSegments: 10, lengthSegments: 10 });
    case PrimitiveType.Quad: {
      // Unity's Quad: 1 x 1 on the XY plane, its front facing -Z (toward a default
      // camera). In PlayCanvas's mirrored space that front faces +Z.
      const geometry = new pc.Geometry();
      geometry.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
      geometry.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
      geometry.uvs = [0, 1, 1, 1, 1, 0, 0, 0];
      geometry.indices = [0, 1, 2, 0, 2, 3];
      return geometry;
    }
  }
}

/** The mesh data a script sees, in Unity's space and conventions. */
interface MeshData {
  vertices: Vector3[];
  triangles: number[];
  normals: Vector3[];
  uv: Vector2[];
}

/**
 * Unity-space mesh data -> PlayCanvas geometry: mirror Z, flip v (PlayCanvas puts v = 0 at
 * the top of an image) and turn clockwise front faces into counter-clockwise ones.
 */
function toPlayCanvasGeometry(data: MeshData, autoNormals: boolean): pc.Geometry {
  const geometry = new pc.Geometry();
  geometry.positions = data.vertices.flatMap((v) => [v.x, v.y, -v.z]);
  const indices: number[] = [];
  for (let i = 0; i + 2 < data.triangles.length; i += 3) {
    indices.push(data.triangles[i] as number, data.triangles[i + 2] as number, data.triangles[i + 1] as number);
  }
  geometry.indices = indices;
  if (data.uv.length === data.vertices.length) geometry.uvs = data.uv.flatMap((v) => [v.x, 1 - v.y]);
  if (data.normals.length === data.vertices.length && !autoNormals) {
    geometry.normals = data.normals.flatMap((v) => [v.x, v.y, -v.z]);
  } else {
    geometry.calculateNormals();
  }
  return geometry;
}

/** The inverse of `toPlayCanvasGeometry`, for the built-in shapes. */
function fromPlayCanvasGeometry(geometry: pc.Geometry): MeshData {
  const positions = geometry.positions ?? [];
  const normals = geometry.normals ?? [];
  const uvs = geometry.uvs ?? [];
  const indices = geometry.indices ?? [];
  const vertices: Vector3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    vertices.push(new Vector3(positions[i] as number, positions[i + 1] as number, -(positions[i + 2] as number)));
  }
  const triangles: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    triangles.push(indices[i] as number, indices[i + 2] as number, indices[i + 1] as number);
  }
  const normalList: Vector3[] = [];
  for (let i = 0; i + 2 < normals.length; i += 3) {
    normalList.push(new Vector3(normals[i] as number, normals[i + 1] as number, -(normals[i + 2] as number)));
  }
  const uv: Vector2[] = [];
  for (let i = 0; i + 1 < uvs.length; i += 2) uv.push(new Vector2(uvs[i] as number, 1 - (uvs[i + 1] as number)));
  return { vertices, triangles, normals: normalList, uv };
}

/**
 * Geometry that a MeshFilter can show. Three ways to get one:
 *
 *   Mesh.primitive(PrimitiveType.Cube)        // shared built-in shape (read-only)
 *   const mesh = new Mesh();                   // build your own (e.g. a hex tile)
 *   mesh.vertices = [...]; mesh.triangles = [...]; mesh.recalculateNormals();
 *   meshFilter.mesh                            // this object's own copy, as in Unity
 *
 * Same conventions as Unity: positions in the object's local space (Z forward), front
 * faces wound CLOCKWISE seen from the front, and texture coordinates with v = 0 at the
 * BOTTOM of the image. Data written for a Unity mesh works unchanged.
 *
 * As in Unity, `vertices`, `triangles`, `normals` and `uv` return copies: change the
 * copy and assign it back (`mesh.vertices = changed`). Editing the returned array in
 * place changes nothing, exactly as in Unity.
 */
export class Mesh {
  name = 'Mesh';

  private data: MeshData | null = { vertices: [], triangles: [], normals: [], uv: [] };
  /** @internal The MeshFilters drawing this mesh. They are redrawn when it changes. */
  readonly _users = new Set<MeshFilter>();

  /** The data as stored, filled in from the built-in shape on first use. */
  private read(member: string): MeshData {
    if (this.wrapped) {
      throw new Error(
        `Mesh "${this.name}" comes from a loaded model, and its ${member} cannot be read here (mesh.isReadable is false). ` +
          `Unity refuses this too unless the model was imported with Read/Write enabled. Build the shape with \`new Mesh()\` instead.`,
      );
    }
    if (!this.data) {
      this.data = this.primitiveType ? fromPlayCanvasGeometry(primitiveGeometry(this.primitiveType)) : null;
      this.data ??= { vertices: [], triangles: [], normals: [], uv: [] };
    }
    return this.data;
  }

  /** The data, about to be changed. A copy of a built-in shape stops sharing it here. */
  private write(member: string): MeshData {
    if (this.isBuiltIn) {
      throw new Error(
        `Mesh "${this.name}" is the built-in shape that every ${this.name} shares, so its ${member} cannot be changed. ` +
          `Change this object's own copy: \`meshFilter.mesh.${member} = ...\` (reading meshFilter.mesh makes the copy, as in Unity).`,
      );
    }
    const data = this.read(member);
    this.primitiveType = null;
    return data;
  }

  /** False for meshes of loaded models: their data stays on the GPU. Unity: `Mesh.isReadable`. */
  get isReadable(): boolean {
    return this.wrapped === null;
  }

  /** Corner positions in local space. A copy (see the class comment); assign to change. */
  get vertices(): Vector3[] {
    return [...this.read('vertices').vertices];
  }

  set vertices(value: Vector3[]) {
    this.write('vertices').vertices = [...value];
    this.markDirty();
  }

  /** Indices into `vertices`, three per triangle, clockwise seen from the front (Unity's winding). A copy. */
  get triangles(): number[] {
    return [...this.read('triangles').triangles];
  }

  set triangles(value: number[]) {
    this.write('triangles').triangles = [...value];
    this.markDirty();
  }

  /** One normal per vertex. Leave empty and call `recalculateNormals()` to generate them. A copy. */
  get normals(): Vector3[] {
    return [...this.read('normals').normals];
  }

  set normals(value: Vector3[]) {
    this.write('normals').normals = [...value];
    this.autoNormals = false;
    this.markDirty();
  }

  /** One texture coordinate per vertex, v = 0 at the bottom of the image (as in Unity). Optional. A copy. */
  get uv(): Vector2[] {
    return [...this.read('uv').uv];
  }

  set uv(value: Vector2[]) {
    this.write('uv').uv = [...value];
    this.markDirty();
  }

  private primitiveType: PrimitiveType | null = null;
  private isBuiltIn = false;
  private wrapped: pc.Mesh[] | null = null;
  private built: pc.Mesh | null = null;
  private autoNormals = false;

  private static readonly primitives = new Map<PrimitiveType, Mesh>();

  /**
   * A shared built-in shape, with Unity's sizes. The same `Mesh` object is returned for
   * the same type, and it cannot be changed: read `meshFilter.mesh` for an object's own
   * copy to edit.
   */
  static primitive(type: PrimitiveType): Mesh {
    let mesh = Mesh.primitives.get(type);
    if (!mesh) {
      mesh = new Mesh();
      // Unity's names: "Cube", "Sphere", ...
      mesh.name = type.charAt(0).toUpperCase() + type.slice(1);
      mesh.primitiveType = type;
      mesh.isBuiltIn = true;
      mesh.data = null;
      Mesh.primitives.set(type, mesh);
    }
    return mesh;
  }

  /** Wraps existing PlayCanvas meshes (one per sub-mesh). Their data is not readable (`isReadable` is false). */
  static fromPlayCanvas(meshes: pc.Mesh | pc.Mesh[], name = 'Mesh'): Mesh {
    const mesh = new Mesh();
    mesh.name = name;
    mesh.wrapped = Array.isArray(meshes) ? meshes : [meshes];
    mesh.data = null;
    return mesh;
  }

  /** @internal An independent copy, for `MeshFilter.mesh`. Named "<name> Instance", as in Unity. */
  _copy(): Mesh {
    const copy = new Mesh();
    copy.name = `${this.name} Instance`;
    copy.primitiveType = this.primitiveType;
    copy.wrapped = this.wrapped;
    copy.autoNormals = this.autoNormals;
    copy.data = this.data
      ? {
          vertices: [...this.data.vertices],
          triangles: [...this.data.triangles],
          normals: [...this.data.normals],
          uv: [...this.data.uv],
        }
      : null;
    return copy;
  }

  /** Generates smooth normals from the triangles when the mesh is next built. */
  recalculateNormals(): void {
    this.write('normals');
    this.autoNormals = true;
    this.markDirty();
  }

  /** Redraws every MeshFilter showing this mesh. Assigning any of the arrays does it for you. */
  markDirty(): void {
    const superseded = this.built;
    this.built = null;
    for (const filter of [...this._users]) {
      if (filter.isDestroyed) this._users.delete(filter);
      else filter._refresh();
    }
    // Nothing draws the old geometry any more: give its buffers back.
    if (superseded) {
      superseded.decRefCount();
      if (superseded.refCount < 1) superseded.destroy();
    }
  }

  /** Axis-aligned bounds in the mesh's own space. */
  get bounds(): Bounds {
    const meshes = this._resolve(currentEngine());
    let bounds: Bounds | null = null;
    for (const mesh of meshes) {
      const part = fromPlayCanvasAabb(mesh.aabb);
      bounds = bounds ? bounds.encapsulate(part.min).encapsulate(part.max) : part;
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
        mesh = pc.Mesh.fromGeometry(device, primitiveGeometry(this.primitiveType));
        // Shared by many renderers; never let reference counting free it.
        mesh.incRefCount();
        engine.cache.set(key, mesh);
      }
      return [mesh];
    }
    if (!this.built || this.built.device !== device) {
      const data = this.read('vertices');
      // Not a drawable mesh yet (vertices assigned, triangles still to come): draw nothing.
      if (data.vertices.length === 0 || data.triangles.length < 3) return [];
      this.built = pc.Mesh.fromGeometry(device, toPlayCanvasGeometry(data, this.autoNormals));
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
    this.pcMaterial = source ? source.pcMaterial.clone() : new pc.StandardMaterial();
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

/**
 * Holds the mesh a MeshRenderer on the same GameObject draws. As in Unity, `sharedMesh`
 * is the mesh as assigned (shared with every other object using it), while reading
 * `mesh` gives this object its own copy the first time, so editing it changes only this
 * object.
 */
export class MeshFilter extends Component {
  static readonly disallowMultiple = true;

  /** @internal */
  _mesh: Mesh | null = null;
  /** True once `mesh` has made this filter's own copy. */
  private ownsMesh = false;

  override _attach(): void {
    const existing = this.gameObject.entity.render;
    if (existing && existing.meshInstances.length > 0) {
      // Adopting a PlayCanvas render component (glTF model or a clone).
      this._mesh = Mesh.fromPlayCanvas(
        existing.meshInstances.flatMap((instance) => (instance.mesh ? [instance.mesh] : [])),
        this.gameObject.name,
      );
      this._mesh._users.add(this);
    } else {
      syncRender(this.gameObject, true);
    }
  }

  private assign(value: Mesh | null, owned: boolean): void {
    this._mesh?._users.delete(this);
    this._mesh = value;
    this.ownsMesh = owned;
    value?._users.add(this);
    syncRender(this.gameObject, true);
  }

  /**
   * This object's own mesh. As in Unity, the first read copies the assigned mesh (or
   * creates an empty one when there is none), so changes affect only this object; after
   * that `sharedMesh` returns the same copy. Assigning sets the mesh as is.
   */
  get mesh(): Mesh {
    if (!this.ownsMesh || !this._mesh) this.assign(this._mesh ? this._mesh._copy() : new Mesh(), true);
    return this._mesh as Mesh;
  }

  set mesh(value: Mesh | null) {
    this.assign(value, false);
  }

  /** @internal The mesh's geometry changed: draw the new one. */
  _refresh(): void {
    syncRender(this.gameObject, true);
  }

  /** The mesh as assigned, possibly shared with other objects: reading it never copies. Same as Unity. */
  get sharedMesh(): Mesh | null {
    return this._mesh;
  }

  set sharedMesh(value: Mesh | null) {
    this.assign(value, false);
  }

  override _destroy(): void {
    this._mesh?._users.delete(this);
    this._mesh = null;
    if (!this.gameObject.isDestroyed) syncRender(this.gameObject, true);
  }

  override _copyFrom(source: this): void {
    // PlayCanvas already cloned the mesh instances; share the same Mesh object, as a
    // Unity clone shares the original's mesh until it reads `mesh`.
    this._mesh = source._mesh;
    this.ownsMesh = false;
    this._mesh?._users.add(this);
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
      const part = fromPlayCanvasAabb(instance.aabb);
      bounds = bounds ? bounds.encapsulate(part.min).encapsulate(part.max) : part;
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
