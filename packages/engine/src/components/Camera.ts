import * as pc from 'playcanvas';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { Color } from '../math/Color';
import { Ray } from '../math/geometry';
import { Vector3, type Vector3Like } from '../math/Vector3';

export enum CameraClearFlags {
  /** Clear colour and depth to `backgroundColor`. (No skybox support yet; same as SolidColor.) */
  Skybox = 'skybox',
  SolidColor = 'solidColor',
  /** Keep the colour buffer, clear depth. For cameras layered on top of another. */
  Depth = 'depth',
  Nothing = 'nothing',
}

const scratch = new pc.Vec3();
const scratchOut = new pc.Vec3();

/**
 * Renders the scene from its GameObject's point of view. It looks along the transform's
 * forward direction (-Z).
 *
 * Screen points are CSS pixels with the origin at the TOP-left of the game view, the
 * same space as `Input.mousePosition` and the React HUD.
 */
export class Camera extends Behaviour {
  static readonly disallowMultiple = true;

  /** The first enabled camera tagged "MainCamera", or `null`. */
  static get main(): Camera | null {
    return currentEngine().cameras.find((camera) => camera.gameObject.tag === 'MainCamera') ?? null;
  }

  /** Every enabled camera. */
  static get allCameras(): Camera[] {
    return [...currentEngine().cameras];
  }

  private component!: pc.CameraComponent;
  private flags = CameraClearFlags.SolidColor;

  /** The PlayCanvas camera component, for features not wrapped here (post effects, layers, ...). */
  get pcCamera(): pc.CameraComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (entity.camera) {
      this.component = entity.camera;
      return;
    }
    // Unity's defaults.
    this.component = entity.addComponent('camera', {
      fov: 60,
      nearClip: 0.3,
      farClip: 1000,
      clearColor: new pc.Color(0.19, 0.3, 0.47, 1),
    }) as pc.CameraComponent;
  }

  override _enable(): void {
    currentEngine().cameras.push(this);
  }

  override _disable(): void {
    const cameras = currentEngine().cameras;
    const index = cameras.indexOf(this);
    if (index >= 0) cameras.splice(index, 1);
  }

  override _enabledChanged(): void {
    this.component.enabled = this._enabled;
  }

  override _destroy(): void {
    this.gameObject.entity.removeComponent('camera');
  }

  /** Vertical field of view in degrees. */
  get fieldOfView(): number {
    return this.component.fov;
  }

  set fieldOfView(value: number) {
    this.component.fov = value;
  }

  get nearClipPlane(): number {
    return this.component.nearClip;
  }

  set nearClipPlane(value: number) {
    this.component.nearClip = value;
  }

  get farClipPlane(): number {
    return this.component.farClip;
  }

  set farClipPlane(value: number) {
    this.component.farClip = value;
  }

  get orthographic(): boolean {
    return this.component.projection === pc.PROJECTION_ORTHOGRAPHIC;
  }

  set orthographic(value: boolean) {
    this.component.projection = value ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
  }

  /** Half the height of the view in world units, when orthographic. */
  get orthographicSize(): number {
    return this.component.orthoHeight;
  }

  set orthographicSize(value: number) {
    this.component.orthoHeight = value;
  }

  get backgroundColor(): Color {
    return Color.from(this.component.clearColor);
  }

  set backgroundColor(value: Color) {
    this.component.clearColor = new pc.Color(value.r, value.g, value.b, value.a);
  }

  get clearFlags(): CameraClearFlags {
    return this.flags;
  }

  set clearFlags(value: CameraClearFlags) {
    this.flags = value;
    const color = value === CameraClearFlags.Skybox || value === CameraClearFlags.SolidColor;
    this.component.clearColorBuffer = color;
    this.component.clearDepthBuffer = value !== CameraClearFlags.Nothing;
  }

  /** Draw order: cameras with a higher depth render later (on top). */
  get depth(): number {
    return this.component.priority;
  }

  set depth(value: number) {
    this.component.priority = value;
  }

  /** Width divided by height of the game view. */
  get aspect(): number {
    const { width, height } = currentEngine().canvasSize;
    return height > 0 ? width / height : 1;
  }

  get pixelWidth(): number {
    return currentEngine().canvasSize.width;
  }

  get pixelHeight(): number {
    return currentEngine().canvasSize.height;
  }

  /** Keeps PlayCanvas's projection in step with the view size even when nothing has rendered yet. */
  private size(): { width: number; height: number } {
    const size = currentEngine().canvasSize;
    if (this.component.aspectRatioMode === pc.ASPECT_AUTO && size.height > 0) {
      this.component.camera.aspectRatio = size.width / size.height;
    }
    return size;
  }

  /**
   * A ray from the camera through a screen point. The classic way to find what the
   * mouse is over: `Physics.raycast(camera.screenPointToRay(Input.mousePosition))`.
   */
  screenPointToRay(position: { x: number; y: number }): Ray {
    const { width, height } = this.size();
    const forward = this.transform.forward;
    if (this.orthographic) {
      this.component.screenToWorld(position.x, position.y, 0, scratchOut, width, height);
      return new Ray(Vector3.from(scratchOut), forward);
    }
    const origin = this.transform.position;
    this.component.screenToWorld(position.x, position.y, 1, scratchOut, width, height);
    const direction = Vector3.from(scratchOut).sub(origin).normalized;
    // Start on the near plane, as Unity does.
    const cosine = Math.max(direction.dot(forward), 1e-6);
    return new Ray(origin.add(direction.mul(this.nearClipPlane / cosine)), direction);
  }

  /** Screen point -> world point. `position.z` is the distance in front of the camera. */
  screenToWorldPoint(position: Vector3Like): Vector3 {
    const { width, height } = this.size();
    if (this.orthographic) {
      const depth = position.z - this.nearClipPlane;
      this.component.screenToWorld(position.x, position.y, 0, scratchOut, width, height);
      return Vector3.from(scratchOut).add(this.transform.forward.mul(depth));
    }
    const origin = this.transform.position;
    this.component.screenToWorld(position.x, position.y, 1, scratchOut, width, height);
    const direction = Vector3.from(scratchOut).sub(origin).normalized;
    const cosine = Math.max(direction.dot(this.transform.forward), 1e-6);
    return origin.add(direction.mul(position.z / cosine));
  }

  /**
   * World point -> screen point. `z` is the distance in front of the camera, and is
   * negative when the point is behind it (check this before drawing a HUD marker).
   */
  worldToScreenPoint(position: Vector3Like): Vector3 {
    const { width, height } = this.size();
    scratch.set(position.x, position.y, position.z);
    this.component.worldToScreen(scratch, scratchOut, width, height);
    const depth = Vector3.from(position).sub(this.transform.position).dot(this.transform.forward);
    return new Vector3(scratchOut.x, scratchOut.y, depth);
  }

  /** World point -> viewport point, where (0, 0) is top-left and (1, 1) is bottom-right. */
  worldToViewportPoint(position: Vector3Like): Vector3 {
    const { width, height } = currentEngine().canvasSize;
    const screen = this.worldToScreenPoint(position);
    return new Vector3(width > 0 ? screen.x / width : 0, height > 0 ? screen.y / height : 0, screen.z);
  }

  viewportPointToRay(position: { x: number; y: number }): Ray {
    const { width, height } = currentEngine().canvasSize;
    return this.screenPointToRay({ x: position.x * width, y: position.y * height });
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    this.flags = source.flags;
  }
}

adopters.push((gameObject, entity) => {
  if (entity.camera && !gameObject.getComponent(Camera)) gameObject.addComponent(Camera);
});
