import * as synergy from '@synergy/engine';
import { Engine, SceneManager } from '@synergy/engine';
import { mountUI } from '@synergy/ui';
import { buildId } from './env';
import { isScreen, openScreen, watchNetworkStatus } from './flow';
import { launch } from './localPlay';
import { buildMenuScene } from './scenes/MenuScene';
import { buildShowcaseScene } from './scenes/ShowcaseScene';
import { buildSkirmishScene } from './scenes/SkirmishScene';
import { App } from './ui/App';

// Scenes are registered by name, like Unity's "Scenes in Build" list. Frontier's scene is
// registered by its network manager (frontier/session.ts), which loads it on every machine.
SceneManager.register('Menu', buildMenuScene);
SceneManager.register('Skirmish', buildSkirmishScene);
SceneManager.register('Showcase', buildShowcaseScene);

async function main() {
  // The editor (Unity's Hierarchy, Inspector and Console), the log file and reports, for
  // development builds only. A release build replaces the condition with `false` and
  // leaves the whole package out (docs/devtools.md).
  const devtools = process.env.NODE_ENV !== 'production' ? await import('@synergy/devtools') : null;
  // Before anything else, so that a failure while starting is in the log too.
  devtools?.startLogCapture();

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  // WebGPU wherever the browser or webview has it, WebGL2 everywhere else (PlayCanvas
  // falls back on its own). `?renderer=webgl2` forces WebGL2, e.g. to compare the two.
  const deviceTypes = params.get('renderer') === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'];
  const engine = await Engine.create({ canvas, deviceTypes });

  // For the browser console and automated tools (see scripts/screenshot.ts):
  //   synergy.GameObject.find('Board'), synergy.engine.stop(), synergy.engine.step(), ...
  //   synergy.editor.report('note'), synergy.editor.logs.text() in a development build.
  const editor = devtools?.attachEditor(engine, { header: `build ${buildId}` });
  Object.assign(globalThis, { synergy: { ...synergy, engine, editor } });

  // One HUD root for the whole page; it follows the screen in `flow` (ui/App.tsx).
  mountUI(<App />, { engine });
  watchNetworkStatus();

  // `?scene=Name` opens another screen or any registered scene, handy while building new
  // ones. Without it the game opens on Skirmish; use 'Menu' to start on the title screen.
  // `?host=` / `?join=` connect as soon as it is up (localPlay.ts: testing several players).
  const requested = params.get('scene') ?? 'Skirmish';
  if (isScreen(requested)) {
    await openScreen(requested, { host: launch.host, join: launch.join });
  } else {
    // A name nobody registered fails here, with the list of names that exist. Opening the
    // default instead would show a working game and hide the typo.
    await SceneManager.loadScene(requested);
  }
  document.documentElement.dataset.ready = 'true';
}

main().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre class="boot-error">The game failed to start.\n${String(error?.message ?? error)}</pre>`,
  );
});
