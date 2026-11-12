import * as synergy from '@synergy/engine';
import { Engine, SceneManager } from '@synergy/engine';
import { mountUI } from '@synergy/ui';
import { FrontierHud } from './frontier/FrontierHud';
import { FRONTIER_SCENE } from './frontier/scene';
import { createFrontierManager, playOffline } from './frontier/session';
import { buildShowcaseScene } from './scenes/ShowcaseScene';
import { buildSkirmishScene } from './scenes/SkirmishScene';
import { Hud } from './ui/Hud';

// Scenes are registered by name, like Unity's "Scenes in Build" list.
SceneManager.register('Skirmish', buildSkirmishScene);
SceneManager.register('Showcase', buildShowcaseScene);

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  // WebGPU wherever the browser or webview has it, WebGL2 everywhere else (PlayCanvas
  // falls back on its own). `?renderer=webgl2` forces WebGL2, e.g. to compare the two.
  const deviceTypes = params.get('renderer') === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'];
  const engine = await Engine.create({ canvas, deviceTypes });

  // For the browser console and automated tools (see scripts/screenshot.ts):
  //   synergy.GameObject.find('Board'), synergy.engine.stop(), synergy.engine.step(), ...
  Object.assign(globalThis, { synergy: { ...synergy, engine } });

  // `?scene=Name` opens a different registered scene, handy while building new ones.
  const requested = params.get('scene');
  if (requested === FRONTIER_SCENE) {
    // The netcode sample (game/src/frontier). Its scene is loaded through the network
    // manager, so that a second player who joins is taken to the same place.
    const manager = createFrontierManager();
    mountUI(<FrontierHud manager={manager} />, { engine });
    await playOffline(manager);
  } else {
    // A name nobody registered fails here, with the list of names that exist. Opening the
    // default instead would show a working game and hide the typo.
    const scene = requested ?? 'Skirmish';
    // The Preact HUD belongs to the Skirmish game; other scenes bring their own UI.
    if (scene === 'Skirmish') mountUI(<Hud />, { engine });
    await SceneManager.loadScene(scene);
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
