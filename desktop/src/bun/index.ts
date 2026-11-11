import { BrowserWindow, Updater } from 'electrobun/main';

// The desktop "main process". It runs on Bun, outside the web page, and owns the window.
// Everything the player sees is the same web build that runs in the browser.

/** Where `bun run dev` serves the game. */
const DEV_SERVER_URL = 'http://localhost:3000';

async function gameUrl(): Promise<string> {
  // During `bun run desktop:dev`, prefer the dev server if it is running, so edits
  // hot-reload inside the desktop window. Packaged builds always load the bundled files.
  if ((await Updater.localInfo.channel()) === 'dev') {
    try {
      await fetch(DEV_SERVER_URL, { method: 'HEAD' });
      return DEV_SERVER_URL;
    } catch {
      // Dev server not running: fall through to the bundled build.
    }
  }
  return 'views://game/index.html';
}

new BrowserWindow({
  title: 'Synergy Skirmish',
  url: await gameUrl(),
  frame: { width: 1280, height: 800, x: 120, y: 80 },
});
