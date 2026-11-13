import { Bounds } from '../math/geometry';
import { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';
import type { Texture } from './rendering';

/** A rectangle in pixels, origin at the image's TOP-left (as in image editors). */
export interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteOptions {
  /**
   * The sprite's origin as a FRACTION of its rectangle: (0, 0) is the bottom-left corner,
   * (0.5, 0.5) the centre (the default), (0.5, 0) the bottom middle (good for characters
   * standing on the ground). Same as the `pivot` parameter of Unity's `Sprite.Create`.
   * The `sprite.pivot` property reads it back in PIXELS, as Unity's does.
   */
  pivot?: Vector2;
  /** How many texture pixels make one world unit when drawn by a SpriteRenderer. Default 100, as in Unity. */
  pixelsPerUnit?: number;
}

/**
 * A rectangular piece of a texture. Unity: `Sprite`. Used by `SpriteRenderer` (2D images
 * in the world), `Image` (UI) and `Tile` (tilemaps).
 *
 *   const sheet = await Assets.loadTexture(unitsUrl);
 *   const [knight, archer] = Sprite.slice(sheet, 2, 1);
 *   const logo = await Assets.loadSprite(logoUrl);          // the whole image
 *
 * Differences from Unity: `rect` is measured from the image's TOP-left (Unity measures
 * from the bottom-left), and sprites are created with `new Sprite(...)` or
 * `Sprite.create(...)` rather than imported as assets.
 */
export class Sprite {
  /** The sprite's rectangle in pixels, origin at the image's top-left. */
  readonly rect: Readonly<SpriteRect>;
  /** @internal The pivot as a fraction of `rect`, (0, 0) at its bottom-left: what `SpriteOptions.pivot` gave. */
  readonly _pivotFraction: Vector2;
  /** Texture pixels per world unit. */
  readonly pixelsPerUnit: number;
  /**
   * Texture coordinates of the rectangle's edges: left, bottom, right, top. In PlayCanvas
   * `v` is 0 at the TOP row of an image, so the bottom edge has the larger `v`.
   */
  readonly uv: readonly [left: number, bottom: number, right: number, top: number];

  /** Omit `rect` to use the whole texture. */
  constructor(
    readonly texture: Texture,
    rect?: SpriteRect,
    options: SpriteOptions = {},
  ) {
    const width = texture.width || 1;
    const height = texture.height || 1;
    this.rect = Object.freeze(rect ? { ...rect } : { x: 0, y: 0, width: texture.width, height: texture.height });
    this._pivotFraction = options.pivot ?? new Vector2(0.5, 0.5);
    this.pixelsPerUnit = options.pixelsPerUnit ?? 100;
    this.uv = rect
      ? [rect.x / width, (rect.y + rect.height) / height, (rect.x + rect.width) / width, rect.y / height]
      : [0, 1, 1, 0];
  }

  /**
   * Unity: `Sprite.Create(texture, rect, pivot, pixelsPerUnit)`. `pivot` is a fraction of
   * the rectangle, as in Unity (default the centre). `rect` is from the image's top-left
   * here, from its bottom-left in Unity.
   */
  static create(texture: Texture, rect?: SpriteRect, pivot?: Vector2, pixelsPerUnit?: number): Sprite {
    return new Sprite(texture, rect, { pivot, pixelsPerUnit });
  }

  /** Cuts a sprite sheet into `columns` x `rows` equal sprites, row by row from the top-left. */
  static slice(texture: Texture, columns: number, rows: number, options: SpriteOptions = {}): Sprite[] {
    const width = texture.width / columns;
    const height = texture.height / rows;
    const sprites: Sprite[] = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        sprites.push(new Sprite(texture, { x: column * width, y: row * height, width, height }, options));
      }
    }
    return sprites;
  }

  /**
   * Same as Unity: the pivot in PIXELS, measured from the bottom-left corner of `rect`. A
   * 64 x 64 sprite made with the default pivot (0.5, 0.5) gives (32, 32). Note that
   * `Sprite.create` and `SpriteOptions.pivot` take a fraction instead, also as in Unity:
   * divide by `rect.width` and `rect.height` to go from one to the other.
   */
  get pivot(): Vector2 {
    return new Vector2(this._pivotFraction.x * this.rect.width, this._pivotFraction.y * this.rect.height);
  }

  /** Size in world units when drawn by a SpriteRenderer at scale 1. */
  get size(): Vector2 {
    return new Vector2(this.rect.width / this.pixelsPerUnit, this.rect.height / this.pixelsPerUnit);
  }

  /** Bounds in the sprite's local space (the pivot is at the origin). Unity: `sprite.bounds`. */
  get bounds(): Bounds {
    const size = this.size;
    const min = new Vector3(-this._pivotFraction.x * size.x, -this._pivotFraction.y * size.y, 0);
    return Bounds.fromMinMax(min, min.add(new Vector3(size.x, size.y, 0)));
  }
}
