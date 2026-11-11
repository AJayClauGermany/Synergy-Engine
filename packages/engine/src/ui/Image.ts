import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Behaviour } from '../core/Component';
import { adopters } from '../core/hooks';
import { Color } from '../math/Color';
import { Vector2 } from '../math/Vector2';
import type { Sprite } from '../components/Sprite';
import { RectTransform } from './RectTransform';

/**
 * Draws a sprite (or a plain coloured rectangle) in a Canvas, filling its RectTransform.
 * Unity: `UnityEngine.UI.Image`, Simple type. Adds a RectTransform if there is none.
 *
 *   const panel = new GameObject('Panel');
 *   panel.transform.setParent(canvas.transform, false);
 *   panel.addComponent(Image).color = new Color(0, 0, 0, 0.5);   // no sprite: a flat panel
 *
 * The sprite is stretched to the rectangle; call `setNativeSize()` to size the rectangle
 * to the sprite. Not supported yet: sliced/tiled/filled types, `preserveAspect`, clicks.
 *
 * Use sRGB textures (what `Assets.loadTexture`/`loadSprite` produce). PlayCanvas's UI
 * shader does not decode plain RGBA8 colour textures, which then look washed out.
 */
export class Image extends Behaviour {
  static readonly disallowMultiple = true;
  static readonly requireComponents = [RectTransform];

  private element!: pc.ElementComponent;
  private _sprite: Sprite | null = null;

  override _attach(): void {
    const rect = this.gameObject.getComponent(RectTransform);
    if (!rect) throw new Error('Image needs a RectTransform.');
    this.element = rect.pcElement;
    if (this.element.type !== pc.ELEMENTTYPE_IMAGE) {
      this.element.type = pc.ELEMENTTYPE_IMAGE;
      this.color = Color.white;
    }
  }

  override _enabledChanged(): void {
    this.element.enabled = this._enabled;
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed && this.gameObject.entity.element) {
      this.element.type = pc.ELEMENTTYPE_GROUP;
      this.element.enabled = true;
    }
  }

  override _copyFrom(source: this, remap: <V>(value: V) => V): void {
    super._copyFrom(source, remap);
    // PlayCanvas cloned the texture, rectangle and colour; only the Sprite object is ours.
    this._sprite = source._sprite;
  }

  /** The image to draw. `null` fills the rectangle with `color`. */
  get sprite(): Sprite | null {
    return this._sprite;
  }

  set sprite(value: Sprite | null) {
    this._sprite = value;
    // PlayCanvas's typings omit null, which clears the texture.
    this.element.texture = (value?.texture ?? null) as pc.Texture;
    if (value) {
      // PlayCanvas's image rectangle is (x, y, width, height) in texture space measured
      // from the image's bottom-left; a Sprite's `uv` uses PlayCanvas's top-down v.
      const [left, bottom, right, top] = value.uv;
      this.element.rect = new pc.Vec4(left, 1 - bottom, right - left, bottom - top);
    } else {
      this.element.rect = new pc.Vec4(0, 0, 1, 1);
    }
  }

  /** Tint multiplied with the sprite. An alpha below 1 makes it see-through. */
  get color(): Color {
    const { r, g, b } = this.element.color;
    return new Color(r, g, b, this.element.opacity);
  }

  set color(value: Color) {
    this.element.color = new pc.Color(value.r, value.g, value.b);
    this.element.opacity = value.a;
  }

  /** Resizes the RectTransform to the sprite's size in pixels (at 100 pixels per unit, as in Unity). */
  setNativeSize(): void {
    const sprite = this._sprite;
    const rect = this.gameObject.getComponent(RectTransform);
    if (!sprite || !rect) return;
    const scale = 100 / sprite.pixelsPerUnit;
    rect.anchorMax = rect.anchorMin;
    rect.sizeDelta = new Vector2(sprite.rect.width * scale, sprite.rect.height * scale);
  }
}

adopters.push((gameObject, entity) => {
  if (entity.element?.type === pc.ELEMENTTYPE_IMAGE && !gameObject.getComponent(Image)) gameObject.addComponent(Image);
});

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(Image, 'Image');
