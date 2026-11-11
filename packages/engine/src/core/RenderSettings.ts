import { Color } from '../math/Color';
import { currentEngine } from './runtime';

/** Scene-wide lighting settings. Unity: `RenderSettings` (Window > Rendering > Lighting). */
export class RenderSettings {
  /** Flat light added to everything, so surfaces facing away from lights are not pure black. */
  static get ambientLight(): Color {
    return Color.from(currentEngine().app.scene.ambientLight);
  }

  static set ambientLight(value: Color) {
    currentEngine().app.scene.ambientLight.set(value.r, value.g, value.b);
  }
}
