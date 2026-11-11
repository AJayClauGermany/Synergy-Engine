import * as synergy from '@synergy/engine';
import { Engine, SceneManager } from '@synergy/engine';
import { mountUI } from '@synergy/ui';
import { buildSkirmishScene } from './scenes/SkirmishScene';
import { Hud } from './ui/Hud';

// Scenes are registered by name, like Unity's "Scenes in Build" list.
SceneManager.register('Skirmish', buildSkirmishScene);

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const engine = await Engine.create({ canvas });

  // For the browser console and automated tools (see scripts/screenshot.ts):
  //   synergy.GameObject.find('Board'), synergy.engine.stop(), synergy.engine.step(), ...
  Object.assign(globalThis, { synergy: { ...synergy, engine } });

  mountUI(<Hud />, { engine });

  // `?scene=Name` opens a different registered scene, handy while building new ones.
  const requested = new URLSearchParams(location.search).get('scene');
  await SceneManager.loadScene(requested && SceneManager.isRegistered(requested) ? requested : 'Skirmish');
  document.documentElement.dataset.ready = 'true';
}

main().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre class="boot-error">The game failed to start.\n${String(error?.message ?? error)}</pre>`,
  );
});
