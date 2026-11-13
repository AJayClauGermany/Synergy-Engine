import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { Color } from '../math/Color';
import { Quaternion } from '../math/Quaternion';
import { Vector3 } from '../math/Vector3';

export enum LightType {
  /** Parallel light from infinitely far away, like the sun. */
  Directional = 'directional',
  /** Shines in all directions from a point. */
  Point = 'omni',
  /** A cone of light. */
  Spot = 'spot',
}

export enum LightShadows {
  None = 'none',
  Hard = 'hard',
  Soft = 'soft',
}

/** PlayCanvas lights shine along their node's -Y; this turns -Y onto the node's forward. */
const AIM_OFFSET = new pc.Quat().setFromEulerAngles(90, 0, 0);
const scratchQuat = new pc.Quat();

/**
 * Lights the scene.
 *
 * As in Unity, directional and spot lights shine along `transform.forward` (+Z): an
 * unrotated light shines along +Z, and `Quaternion.euler(50, -30, 0)` (Unity's default
 * sun) works unchanged. `light.direction = ...` aims one without working out angles.
 */
export class Light extends Behaviour {
  static readonly disallowMultiple = true;

  private component!: pc.LightComponent;
  private shadowMode = LightShadows.None;
  private shadowsConfigured = false;
  /** Where PlayCanvas reads the light's position and direction from: the entity, turned to face forward. */
  private aim: pc.GraphNode | null = null;
  private aimApp: pc.AppBase | null = null;
  private readonly syncAim = (): void => {
    const aim = this.aim;
    if (!aim || this.gameObject.isDestroyed) return;
    const entity = this.gameObject.entity;
    aim.setPosition(entity.getPosition());
    aim.setRotation(scratchQuat.mul2(entity.getRotation(), AIM_OFFSET));
  };

  /** The PlayCanvas light component, for settings not wrapped here (cookies, cascades, ...). */
  get pcLight(): pc.LightComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (entity.light) {
      // A light PlayCanvas made (a glTF light, or a clone of one): it is already aimed the
      // way its file says. A clone of one of ours is re-aimed in _copyFrom.
      this.component = entity.light;
      this.shadowMode = this.component.castShadows ? LightShadows.Soft : LightShadows.None;
      this.shadowsConfigured = true;
      return;
    }
    // Unity's default for a new Light component is a point light.
    this.component = entity.addComponent('light', {
      type: LightType.Point,
      color: new pc.Color(1, 1, 1),
      intensity: 1,
      range: 10,
      castShadows: false,
      // Unity's spot cone defaults: spotAngle 30, innerSpotAngle 21.8 (full angles).
      outerConeAngle: 15,
      innerConeAngle: 10.9,
    }) as pc.LightComponent;
    this.aimAlongForward();
  }

  /** Makes PlayCanvas shine this light along the transform's forward, as Unity does. */
  private aimAlongForward(): void {
    if (this.aim) return;
    this.aim = new pc.GraphNode('LightAim');
    this.component.light._node = this.aim;
    this.aimApp = currentEngine().app;
    this.aimApp.on('prerender', this.syncAim);
    this.syncAim();
  }

  override _enabledChanged(): void {
    this.component.enabled = this._enabled;
  }

  override _destroy(): void {
    this.aimApp?.off('prerender', this.syncAim);
    this.aim = null;
    this.gameObject.entity.removeComponent('light');
  }

  override _summary(): string {
    return `${this.type}, intensity ${this.intensity}`;
  }

  /**
   * The world-space direction a directional or spot light shines in: `transform.forward`.
   * Setting it turns the transform to face that way. (Not in Unity, where you set the
   * rotation.)
   */
  get direction(): Vector3 {
    return this.transform.forward;
  }

  set direction(value: Vector3) {
    this.transform.rotation = Quaternion.lookRotation(value);
  }

  get type(): LightType {
    return this.component.type as LightType;
  }

  set type(value: LightType) {
    this.component.type = value;
  }

  get color(): Color {
    return Color.from(this.component.color);
  }

  set color(value: Color) {
    this.component.color = new pc.Color(value.r, value.g, value.b);
  }

  get intensity(): number {
    return this.component.intensity;
  }

  set intensity(value: number) {
    this.component.intensity = value;
  }

  /** How far a point or spot light reaches. */
  get range(): number {
    return this.component.range;
  }

  set range(value: number) {
    this.component.range = value;
  }

  /** Full angle of a spot light's cone, in degrees. */
  get spotAngle(): number {
    return this.component.outerConeAngle * 2;
  }

  set spotAngle(value: number) {
    this.component.outerConeAngle = value / 2;
    this.component.innerConeAngle = Math.min(this.component.innerConeAngle, value / 2);
  }

  /** Full angle of the fully lit inner part of a spot light's cone, in degrees. */
  get innerSpotAngle(): number {
    return this.component.innerConeAngle * 2;
  }

  set innerSpotAngle(value: number) {
    this.component.innerConeAngle = value / 2;
  }

  get shadows(): LightShadows {
    return this.shadowMode;
  }

  set shadows(value: LightShadows) {
    this.shadowMode = value;
    this.component.castShadows = value !== LightShadows.None;
    if (value === LightShadows.Hard) this.component.shadowType = pc.SHADOW_PCF1_32F;
    if (value === LightShadows.Soft) this.component.shadowType = pc.SHADOW_PCF3_32F;
    if (value !== LightShadows.None && !this.shadowsConfigured) {
      // Defaults that avoid "shadow acne" (striped self-shadowing) on curved surfaces.
      this.shadowsConfigured = true;
      this.component.shadowResolution = 2048;
      this.component.shadowBias = 0.2;
      this.component.normalOffsetBias = 0.05;
    }
  }

  /** Pushes shadows away from the light to hide self-shadowing artefacts. */
  get shadowBias(): number {
    return this.component.shadowBias;
  }

  set shadowBias(value: number) {
    this.shadowsConfigured = true;
    this.component.shadowBias = value;
  }

  /** Like `shadowBias`, but along the surface normal. Helps on surfaces at grazing angles. */
  get shadowNormalBias(): number {
    return this.component.normalOffsetBias;
  }

  set shadowNormalBias(value: number) {
    this.shadowsConfigured = true;
    this.component.normalOffsetBias = value;
  }

  /** How far from the camera shadows are drawn (directional lights). */
  get shadowDistance(): number {
    return this.component.shadowDistance;
  }

  set shadowDistance(value: number) {
    this.component.shadowDistance = value;
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    this.shadowMode = source.shadowMode;
    this.shadowsConfigured = source.shadowsConfigured;
    if (source.aim) this.aimAlongForward();
  }
}

adopters.push((gameObject, entity) => {
  if (entity.light && !gameObject.getComponent(Light)) gameObject.addComponent(Light);
});

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Light, 'Light');
