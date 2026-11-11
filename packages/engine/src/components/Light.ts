import * as pc from 'playcanvas';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
import { Color } from '../math/Color';

export enum LightType {
  /** Parallel light from infinitely far away, like the sun. Shines along the transform's forward. */
  Directional = 'directional',
  /** Shines in all directions from a point. */
  Point = 'omni',
  /** A cone along the transform's forward. */
  Spot = 'spot',
}

export enum LightShadows {
  None = 'none',
  Hard = 'hard',
  Soft = 'soft',
}

/** Lights the scene. */
export class Light extends Behaviour {
  static readonly disallowMultiple = true;

  private component!: pc.LightComponent;
  private shadowMode = LightShadows.None;

  /** The PlayCanvas light component, for settings not wrapped here (cookies, cascades, ...). */
  get pcLight(): pc.LightComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (entity.light) {
      this.component = entity.light;
      this.shadowMode = this.component.castShadows ? LightShadows.Soft : LightShadows.None;
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
  }
}

adopters.push((gameObject, entity) => {
  if (entity.light && !gameObject.getComponent(Light)) gameObject.addComponent(Light);
});
