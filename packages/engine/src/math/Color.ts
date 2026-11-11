import { Mathf } from './Mathf';

/** Anything with r/g/b and optional alpha, e.g. a PlayCanvas `Color`. */
export interface ColorLike {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

/** Immutable RGBA colour with components in [0, 1]. */
export class Color implements ColorLike {
  constructor(
    readonly r: number = 0,
    readonly g: number = 0,
    readonly b: number = 0,
    readonly a: number = 1,
  ) {}

  static readonly white = new Color(1, 1, 1, 1);
  static readonly black = new Color(0, 0, 0, 1);
  static readonly red = new Color(1, 0, 0, 1);
  static readonly green = new Color(0, 1, 0, 1);
  static readonly blue = new Color(0, 0, 1, 1);
  static readonly yellow = new Color(1, 0.92, 0.016, 1);
  static readonly cyan = new Color(0, 1, 1, 1);
  static readonly magenta = new Color(1, 0, 1, 1);
  static readonly gray = new Color(0.5, 0.5, 0.5, 1);
  static readonly grey = Color.gray;
  /** Fully transparent black. */
  static readonly clear = new Color(0, 0, 0, 0);

  static from(value: ColorLike): Color {
    return new Color(value.r, value.g, value.b, value.a ?? 1);
  }

  /** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (the leading `#` is optional). */
  static fromHex(hex: string): Color {
    let digits = hex.trim().replace(/^#/, '');
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((d) => d + d).join('');
    }
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits)) {
      throw new Error(`Color.fromHex: "${hex}" is not a valid hex colour`);
    }
    const channel = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16) / 255;
    return new Color(channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) : 1);
  }

  /** Hue, saturation and value in [0, 1]. Unity: `Color.HSVToRGB`. */
  static hsvToRgb(h: number, s: number, v: number): Color {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
      case 0:
        return new Color(v, t, p);
      case 1:
        return new Color(q, v, p);
      case 2:
        return new Color(p, v, t);
      case 3:
        return new Color(p, q, v);
      case 4:
        return new Color(t, p, v);
      default:
        return new Color(v, p, q);
    }
  }

  static lerp(a: Color, b: Color, t: number): Color {
    const k = Mathf.clamp01(t);
    return new Color(
      a.r + (b.r - a.r) * k,
      a.g + (b.g - a.g) * k,
      a.b + (b.b - a.b) * k,
      a.a + (b.a - a.a) * k,
    );
  }

  /** Multiplies RGB (not alpha) by `factor`. */
  mul(factor: number): Color {
    return new Color(this.r * factor, this.g * factor, this.b * factor, this.a);
  }

  withAlpha(a: number): Color {
    return new Color(this.r, this.g, this.b, a);
  }

  equals(other: ColorLike, tolerance = 1e-4): boolean {
    return (
      Math.abs(this.r - other.r) <= tolerance &&
      Math.abs(this.g - other.g) <= tolerance &&
      Math.abs(this.b - other.b) <= tolerance &&
      Math.abs(this.a - (other.a ?? 1)) <= tolerance
    );
  }

  /** `#rrggbb`, or `#rrggbbaa` when not fully opaque. Handy for CSS. */
  toHex(): string {
    const part = (value: number) =>
      Math.round(Mathf.clamp01(value) * 255)
        .toString(16)
        .padStart(2, '0');
    const rgb = `#${part(this.r)}${part(this.g)}${part(this.b)}`;
    return this.a >= 1 ? rgb : rgb + part(this.a);
  }

  toString(): string {
    return `RGBA(${this.r.toFixed(3)}, ${this.g.toFixed(3)}, ${this.b.toFixed(3)}, ${this.a.toFixed(3)})`;
  }
}
