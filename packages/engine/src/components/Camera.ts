import * as pc from 'playcanvas';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { Color } from '../math/Color';
import { Ray } from '../math/geometry';
import { Mathf } from '../math/Mathf';
import { Vector3, type Vector3Like } from '../math/Vector3';

export enum CameraClearFlags {
  /** Clear colour and depth to `backgroundColor`. (No skybox support yet; same as SolidColor.) */
  Skybox = 'skybox',
  SolidColor = 'solidColor',
  /** Keep the colour buffer, clear depth. For cameras layered on top of another. */
  Depth = 'depth',
  Nothing = 'nothing',
}

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

  override _summary(): string {
    return this.orthographic ? `orthographic, size ${this.orthographicSize}` : `fieldOfView ${this.fieldOfView}`;
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

  // The conversions below are computed from the transform and the lens settings directly.
  // PlayCanvas's own helpers read view matrices that are only refreshed when a frame is
  // rendered, which makes them stale right after the camera moves (and always in
  // headless mode).

  /** Half the view's width and height at one unit in front of the camera (or overall, when orthographic). */
  private halfExtents(): { x: number; y: number } {
    const aspect = this.aspect;
    if (this.orthographic) {
      const y = this.component.orthoHeight;
      return { x: y * aspect, y };
    }
    const tangent = Math.tan((this.component.fov * Mathf.deg2Rad) / 2);
    return this.component.horizontalFov ? { x: tangent, y: tangent / aspect } : { x: tangent * aspect, y: tangent };
  }

  /** Screen pixels -> normalised device coordinates: x right, y up, both in [-1, 1]. */
  private toNdc(position: { x: number; y: number }): { x: number; y: number } {
    const { width, height } = currentEngine().canvasSize;
    return {
      x: width > 0 ? (position.x / width) * 2 - 1 : 0,
      y: height > 0 ? 1 - (position.y / height) * 2 : 0,
    };
  }

  /** Camera space (x right, y up, looking down -z) -> world space, ignoring any scale on the camera. */
  private fromCameraSpace(point: Vector3): Vector3 {
    return this.transform.position.add(this.transform.rotation.rotate(point));
  }

  /**
   * A ray from the camera through a screen point. The classic way to find what the
   * mouse is over: `Physics.raycast(camera.screenPointToRay(Input.mousePosition))`.
   */
  screenPointToRay(position: { x: number; y: number }): Ray {
    const ndc = this.toNdc(position);
    const half = this.halfExtents();
    const near = this.nearClipPlane;
    if (this.orthographic) {
      return new Ray(this.fromCameraSpace(new Vector3(ndc.x * half.x, ndc.y * half.y, -near)), this.transform.forward);
    }
    // Start on the near plane, as Unity does.
    const onNearPlane = new Vector3(ndc.x * half.x * near, ndc.y * half.y * near, -near);
    const origin = this.fromCameraSpace(onNearPlane);
    return new Ray(origin, origin.sub(this.transform.position));
  }

  /** Screen point -> world point. `position.z` is the distance in front of the camera. */
  screenToWorldPoint(position: Vector3Like): Vector3 {
    const ndc = this.toNdc(position);
    const half = this.halfExtents();
    const depth = position.z;
    const spread = this.orthographic ? 1 : depth;
    return this.fromCameraSpace(new Vector3(ndc.x * half.x * spread, ndc.y * half.y * spread, -depth));
  }

  /**
   * World point -> screen point. `z` is the distance in front of the camera, and is
   * negative when the point is behind it (check this before drawing a HUD marker).
   */
  worldToScreenPoint(position: Vector3Like): Vector3 {
    const { width, height } = currentEngine().canvasSize;
    const local = this.transform.rotation.inverse().rotate(Vector3.from(position).sub(this.transform.position));
    const depth = -local.z;
    const half = this.halfExtents();
    // Avoid dividing by zero for a point exactly on the camera plane.
    const spread = this.orthographic ? 1 : Math.abs(depth) < 1e-9 ? 1e-9 : depth;
    const ndcX = local.x / (half.x * spread);
    const ndcY = local.y / (half.y * spread);
    return new Vector3((ndcX * 0.5 + 0.5) * width, (1 - (ndcY * 0.5 + 0.5)) * height, depth);
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
