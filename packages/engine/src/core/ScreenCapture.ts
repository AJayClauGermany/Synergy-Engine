import { currentEngine } from './runtime';

/**
 * Unity's `ScreenCapture`: a picture of the game view. The Preact HUD is HTML over the
 * canvas and is not in it.
 *
 *   await ScreenCapture.captureScreenshot('turn-3.png');
 *
 * Both calls wait for the next frame to be drawn (the drawing buffer can only be read
 * just after a frame), or draw one at once when the game is paused. A headless engine
 * draws nothing and resolves to `null`.
 */
export class ScreenCapture {
  /**
   * Saves the game view as a PNG. With the editor attached (`bun run dev`) it goes to
   * `.screenshots/<filename>` in the project; otherwise the browser downloads it. Without
   * a name it is called `screenshot-<date>_<time>.png`.
   * Resolves to where it went, or `null` when nothing could be captured.
   */
  static async captureScreenshot(filename = ''): Promise<string | null> {
    const engine = currentEngine();
    // No name: one with the time in it, so a series of captures do not overwrite each other.
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
    const name = (filename.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]+/g, '-') || `screenshot-${stamp}.png`;
    const file = name.toLowerCase().endsWith('.png') ? name : `${name}.png`;
    const image = await ScreenCapture.captureScreenshotAsDataUrl();
    if (!image) return null;
    if (engine.editor) {
      const saved = await engine.editor.saveScreenshot(file, image);
      if (saved) return saved;
    }
    if (typeof document === 'undefined') return null;
    const link = document.createElement('a');
    link.href = image;
    link.download = file;
    link.click();
    return file;
  }

  /** The game view as a PNG `data:` URL (Unity: `CaptureScreenshotAsTexture`). */
  static captureScreenshotAsDataUrl(): Promise<string | null> {
    const engine = currentEngine();
    if (engine.isHeadless) return Promise.resolve(null);
    const read = () => {
      try {
        return engine.canvas.toDataURL('image/png');
      } catch {
        return null;
      }
    };
    if (!engine.isRunning) {
      engine.app.render();
      return Promise.resolve(read());
    }
    return new Promise((resolve) => {
      engine.app.once('frameend', () => resolve(read()));
    });
  }
}
