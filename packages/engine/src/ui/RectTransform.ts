import * as pc from 'playcanvas';
import { nameType } from '../core/typeNames';
import { Component } from '../core/Component';
import { adopters } from '../core/hooks';
import { Vector2 } from '../math/Vector2';

/** A rectangle in a RectTransform's local space: x and y are its bottom-left corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Layout {
  anchorMin: Vector2;
  anchorMax: Vector2;
  pivot: Vector2;
  offsetMin: Vector2;
  offsetMax: Vector2;
}

/**
 * Position, size, anchors and pivot of a UI element under a `Canvas`. Unity: `RectTransform`.
 *
 * Same model as Unity: units are canvas units (CSS pixels by default), y points up,
 * `anchorMin`/`anchorMax` are fractions of the parent rectangle, `pivot` is a fraction of
 * this one, and `anchoredPosition` is the pivot's offset from the anchors.
 *
 *   rect.anchorMin = rect.anchorMax = new Vector2(1, 1);   // top-right corner
 *   rect.pivot = new Vector2(1, 1);
 *   rect.anchoredPosition = new Vector2(-16, -16);          // 16 px in from the corner
 *   rect.sizeDelta = new Vector2(64, 64);
 *
 * Difference from Unity: it is a component next to the GameObject's `Transform` rather
 * than replacing it, so reach it with `getComponent(RectTransform)`. `Image` adds one.
 * Built on PlayCanvas's `element` component (`pcElement`).
 */
export class RectTransform extends Component {
  static readonly disallowMultiple = true;

  private component!: pc.ElementComponent;

  /** The PlayCanvas element component, for features not wrapped here (masks, text, layout groups). */
  get pcElement(): pc.ElementComponent {
    return this.component;
  }

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (entity.element) {
      this.component = entity.element;
      return;
    }
    this.component = entity.addComponent('element', { type: pc.ELEMENTTYPE_GROUP }) as pc.ElementComponent;
    // Unity's defaults for a new UI object: centred, 100 x 100.
    const centre = new Vector2(0.5, 0.5);
    this.write({
      anchorMin: centre,
      anchorMax: centre,
      pivot: centre,
      offsetMin: new Vector2(-50, -50),
      offsetMax: new Vector2(50, 50),
    });
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed) this.gameObject.entity.removeComponent('element');
  }

  /** Bottom-left anchor, as a fraction of the parent rectangle. */
  get anchorMin(): Vector2 {
    return this.read().anchorMin;
  }

  set anchorMin(value: Vector2) {
    this.write({ ...this.read(), anchorMin: value });
  }

  /** Top-right anchor, as a fraction of the parent rectangle. */
  get anchorMax(): Vector2 {
    return this.read().anchorMax;
  }

  set anchorMax(value: Vector2) {
    this.write({ ...this.read(), anchorMax: value });
  }

  /** The point this rectangle is positioned, rotated and scaled around, as a fraction of its size. */
  get pivot(): Vector2 {
    return this.read().pivot;
  }

  set pivot(value: Vector2) {
    // As in Unity, the pivot keeps its anchored position and the rectangle moves around it.
    const { anchoredPosition, sizeDelta } = this;
    this.write({ ...this.read(), pivot: value, ...offsets(anchoredPosition, sizeDelta, value) });
  }

  /** The pivot's position relative to the anchors' reference point. */
  get anchoredPosition(): Vector2 {
    const { offsetMin, offsetMax, pivot } = this.read();
    return offsetMin.add(offsetMax.sub(offsetMin).scale(pivot));
  }

  set anchoredPosition(value: Vector2) {
    const layout = this.read();
    this.write({ ...layout, ...offsets(value, layout.offsetMax.sub(layout.offsetMin), layout.pivot) });
  }

  /**
   * The size minus the anchors' span. With both anchors at one point it is simply the
   * size; with stretched anchors it is how much bigger than the anchored area it is.
   */
  get sizeDelta(): Vector2 {
    const { offsetMin, offsetMax } = this.read();
    return offsetMax.sub(offsetMin);
  }

  set sizeDelta(value: Vector2) {
    const layout = this.read();
    this.write({ ...layout, ...offsets(this.anchoredPosition, value, layout.pivot) });
  }

  /** Bottom-left corner's offset from `anchorMin`. */
  get offsetMin(): Vector2 {
    return this.read().offsetMin;
  }

  set offsetMin(value: Vector2) {
    this.write({ ...this.read(), offsetMin: value });
  }

  /** Top-right corner's offset from `anchorMax`. */
  get offsetMax(): Vector2 {
    return this.read().offsetMax;
  }

  set offsetMax(value: Vector2) {
    this.write({ ...this.read(), offsetMax: value });
  }

  /** The rectangle in its own space, relative to the pivot. Width and height are the actual size. */
  get rect(): Rect {
    const element = this.component;
    const width = element.calculatedWidth;
    const height = element.calculatedHeight;
    return { x: -element.pivot.x * width, y: -element.pivot.y * height, width, height };
  }

  /** The current layout, in Unity's terms, from the PlayCanvas element. */
  private read(): Layout {
    const element = this.component;
    const { anchor, pivot, margin } = element;
    // PlayCanvas refreshes its margins from the local position only when the entity next
    // syncs. Apply any move made since (through `transform.localPosition`, for example) here.
    const position = this.gameObject.entity.getLocalPosition();
    const dx = position.x - (margin.x + element.calculatedWidth * pivot.x);
    const dy = position.y - (margin.y + element.calculatedHeight * pivot.y);
    return {
      anchorMin: new Vector2(anchor.x, anchor.y),
      anchorMax: new Vector2(anchor.z, anchor.w),
      pivot: new Vector2(pivot.x, pivot.y),
      offsetMin: new Vector2(margin.x + dx, margin.y + dy),
      offsetMax: new Vector2(-margin.z + dx, -margin.w + dy),
    };
  }

  private write(layout: Layout): void {
    const element = this.component;
    element.anchor = new pc.Vec4(layout.anchorMin.x, layout.anchorMin.y, layout.anchorMax.x, layout.anchorMax.y);
    // Setting the pivot shifts PlayCanvas's margins; they are replaced right after.
    element.pivot = new pc.Vec2(layout.pivot.x, layout.pivot.y);
    // PlayCanvas margins are the distances from each anchor edge, positive inward, which
    // is Unity's offsetMin and the negated offsetMax. They determine size and position.
    element.margin = new pc.Vec4(layout.offsetMin.x, layout.offsetMin.y, -layout.offsetMax.x, -layout.offsetMax.y);
  }
}

/** Unity's relation between anchoredPosition/sizeDelta and the corner offsets. */
function offsets(
  anchoredPosition: Vector2,
  sizeDelta: Vector2,
  pivot: Vector2,
): Pick<Layout, 'offsetMin' | 'offsetMax'> {
  const offsetMin = anchoredPosition.sub(sizeDelta.scale(pivot));
  return { offsetMin, offsetMax: offsetMin.add(sizeDelta) };
}

adopters.push((gameObject, entity) => {
  if (entity.element && !gameObject.getComponent(RectTransform)) gameObject.addComponent(RectTransform);
});

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(RectTransform, 'RectTransform');
