import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour } from '../core/Component';
import { isAlive } from '../core/EngineObject';
import { adopters } from '../core/hooks';
import { currentEngine } from '../core/runtime';
import { Mathf } from '../math/Mathf';
import { Vector2 } from '../math/Vector2';

/** Where a Canvas draws. Only screen-space overlay is supported so far. */
export enum RenderMode {
  /** Drawn on top of everything, in screen space, whatever the cameras see. */
  ScreenSpaceOverlay = 'screenSpaceOverlay',
}

/** How a CanvasScaler sizes the canvas. Unity: `CanvasScaler.ScaleMode`. */
export enum ScaleMode {
  /** One canvas unit is `scaleFactor` CSS pixels, whatever the screen size. */
  ConstantPixelSize = 'constantPixelSize',
  /** The canvas keeps roughly `referenceResolution` units, growing and shrinking with the screen. */
  ScaleWithScreenSize = 'scaleWithScreenSize',
}

/**
 * The root of in-scene UI (Unity: `Canvas`). Children with a `RectTransform` (an `Image`
 * adds one) are laid out against it and drawn on top of the 3D world and sprites, in
 * hierarchy order: later siblings draw over earlier ones.
 *
 *   const canvas = new GameObject('Canvas').addComponent(Canvas);
 *   const icon = new GameObject('Icon');
 *   icon.transform.setParent(canvas.transform, false);   // false, as in Unity
 *   const image = icon.addComponent(Image);
 *   image.sprite = await Assets.loadSprite(iconUrl);
 *   image.setNativeSize();
 *
 * Canvas units are CSS pixels by default (y up, origin at the anchors, as in Unity). Add
 * a `CanvasScaler` to scale with the screen instead. Built on PlayCanvas's `screen`
 * component (`pcScreen`).
 *
 * Canvas images are not clickable yet. For interactive UI (buttons, text, forms), use the
 * React HUD (`@synergy/ui`), which sits over the same canvas.
 */
export class Canvas extends Behaviour {
  static readonly disallowMultiple = true;

  private component!: pc.ScreenComponent;
  private device!: pc.GraphicsDevice;

  /** The PlayCanvas screen component, for settings not wrapped here. */
  get pcScreen(): pc.ScreenComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    this.device = currentEngine().app.graphicsDevice;
    this.component =
      entity.screen ??
      (entity.addComponent('screen', { screenSpace: true, scaleMode: pc.SCALEMODE_BLEND }) as pc.ScreenComponent);
    this.device.on('resizecanvas', this._refresh, this);
    this._refresh();
  }

  override _enabledChanged(): void {
    this.component.enabled = this._enabled;
  }

  override _destroy(): void {
    this.device.off('resizecanvas', this._refresh, this);
    if (!this.gameObject.isDestroyed) this.gameObject.entity.removeComponent('screen');
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this._refresh();
  }

  get renderMode(): RenderMode {
    return RenderMode.ScreenSpaceOverlay;
  }

  /** Canvases with a higher order draw on top. 0 to 127 (Unity allows a wider range). */
  get sortingOrder(): number {
    return this.component.priority;
  }

  set sortingOrder(value: number) {
    this.component.priority = Mathf.clamp(Math.round(value), 0, 127);
  }

  /** CSS pixels per canvas unit, as currently applied. Unity: `Canvas.scaleFactor`. */
  get scaleFactor(): number {
    return this.component.scale / this.devicePixelRatio();
  }

  /** The canvas's size in canvas units. Unity: the size of the canvas's own RectTransform. */
  get size(): Vector2 {
    const { resolution, scale } = this.component;
    return new Vector2(resolution.x / scale, resolution.y / scale);
  }

  private devicePixelRatio(): number {
    const cssWidth = this.device.canvas.clientWidth;
    return cssWidth > 0 ? this.device.width / cssWidth : 1;
  }

  /** @internal Re-applies the scaling rules after a resize or a CanvasScaler change. */
  _refresh(): void {
    const screen = this.component;
    const scaler = this.gameObject.getComponent(CanvasScaler);
    const active = isAlive(scaler) && scaler.enabled ? scaler : null;
    const width = this.device.width || 1;
    const height = this.device.height || 1;
    screen.scaleMode = pc.SCALEMODE_BLEND;
    if (active?.uiScaleMode === ScaleMode.ScaleWithScreenSize) {
      // PlayCanvas blends the width and height ratios on a log scale, exactly like Unity's
      // "Match Width Or Height" mode.
      screen.scaleBlend = Mathf.clamp01(active.matchWidthOrHeight);
      screen.referenceResolution = new pc.Vec2(active.referenceResolution.x, active.referenceResolution.y);
    } else {
      // A reference resolution of "the screen, divided by the wanted scale" yields that
      // scale on both axes. The screen is measured in device pixels, so fold in the
      // device pixel ratio to make one unit one CSS pixel.
      const scale = this.devicePixelRatio() * (active?.scaleFactor ?? 1);
      screen.scaleBlend = 0;
      screen.referenceResolution = new pc.Vec2(width / scale, height / scale);
    }
  }
}

/**
 * Controls how big a Canvas's units are on screen. Unity: `CanvasScaler`.
 *
 *   const scaler = canvas.gameObject.addComponent(CanvasScaler);
 *   scaler.uiScaleMode = ScaleMode.ScaleWithScreenSize;
 *   scaler.referenceResolution = new Vector2(1920, 1080);
 *   scaler.matchWidthOrHeight = 0.5;
 */
export class CanvasScaler extends Behaviour {
  static readonly disallowMultiple = true;
  static readonly requireComponents = [Canvas];

  private _uiScaleMode = ScaleMode.ConstantPixelSize;
  private _scaleFactor = 1;
  private _referenceResolution = new Vector2(800, 600);
  private _matchWidthOrHeight = 0;

  get uiScaleMode(): ScaleMode {
    return this._uiScaleMode;
  }

  set uiScaleMode(value: ScaleMode) {
    this._uiScaleMode = value;
    this.refresh();
  }

  /** ConstantPixelSize: CSS pixels per canvas unit. */
  get scaleFactor(): number {
    return this._scaleFactor;
  }

  set scaleFactor(value: number) {
    this._scaleFactor = value;
    this.refresh();
  }

  /** ScaleWithScreenSize: the screen size the layout was designed for. Default 800 x 600. */
  get referenceResolution(): Vector2 {
    return this._referenceResolution;
  }

  set referenceResolution(value: Vector2) {
    this._referenceResolution = value;
    this.refresh();
  }

  /** ScaleWithScreenSize: 0 scales with the width, 1 with the height, in between blends. */
  get matchWidthOrHeight(): number {
    return this._matchWidthOrHeight;
  }

  set matchWidthOrHeight(value: number) {
    this._matchWidthOrHeight = value;
    this.refresh();
  }

  override _attach(): void {
    this.refresh();
  }

  override _enabledChanged(): void {
    this.refresh();
  }

  override _destroy(): void {
    this.refresh();
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    this._uiScaleMode = source._uiScaleMode;
    this._scaleFactor = source._scaleFactor;
    this._referenceResolution = source._referenceResolution;
    this._matchWidthOrHeight = source._matchWidthOrHeight;
    this.refresh();
  }

  private refresh(): void {
    const canvas = this.gameObject.getComponent(Canvas);
    if (isAlive(canvas)) canvas._refresh();
  }
}

adopters.push((gameObject, entity) => {
  if (entity.screen && !gameObject.getComponent(Canvas)) gameObject.addComponent(Canvas);
});

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Canvas, 'Canvas');
nameType(CanvasScaler, 'CanvasScaler');
