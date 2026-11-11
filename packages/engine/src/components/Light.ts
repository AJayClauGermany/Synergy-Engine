import * as pc from 'playcanvas';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
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

/**
 * Lights the scene.
 *
 * Directional and spot lights shine along the transform's DOWN direction (-Y), which is
 * PlayCanvas's convention; in Unity it is the transform's forward. An unrotated light
 * therefore points straight down. The simplest way to aim one is `light.direction`.
 */
export class Light extends Behaviour {
  static readonly disallowMultiple = true;

  private component!: pc.LightComponent;
  private shadowMode = LightShadows.None;
  private shadowsConfigured = false;

  /** The PlayCanvas light component, for settings not wrapped here (cookies, cascades, ...). */
  get pcLight(): pc.LightComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (entity.light) {
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
    }) as pc.LightComponent;
  }

  override _enabledChanged(): void {
    this.component.enabled = this._enabled;
  }

  override _destroy(): void {
    this.gameObject.entity.removeComponent('light');
  }

  /** The world-space direction a directional or spot light shines in. Setting it rotates the transform. */
  get direction(): Vector3 {
    return this.transform.up.neg();
  }

  set direction(value: Vector3) {
    this.transform.rotation = Quaternion.fromToRotation(Vector3.down, value);
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
  }
}

adopters.push((gameObject, entity) => {
  if (entity.light && !gameObject.getComponent(Light)) gameObject.addComponent(Light);
});
