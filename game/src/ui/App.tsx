import { useObservable } from '@synergy/ui';
import { FrontierHud } from '../frontier/FrontierHud';
import { flow, frontierManager, openScreen, quitToMenu, type Screen } from '../flow';
import { Hud } from './Hud';

/**
 * The one HUD root, mounted once at boot. It draws the HUD of the screen in `flow`, and a
 * loading overlay while a scene loads. Switching screens never mounts a second HUD.
 */
export function App() {
  const state = useObservable(flow);
  return (
    <>
      {state.screen === 'Menu' && <MenuScreen />}
      {state.screen === 'Skirmish' && <Hud />}
      {state.screen === 'Frontier' && <FrontierHud manager={frontierManager()} />}
      {state.screen !== null && state.screen !== 'Menu' && (
        <button type="button" className="menu-button" onClick={() => void quitToMenu()}>
          Menu
        </button>
      )}
      {state.loading && (
        <div className="loading" data-interactive>
          Loading {state.loading}…
        </div>
      )}
    </>
  );
}

const GAMES: { screen: Screen; title: string; about: string }[] = [
  { screen: 'Skirmish', title: 'Skirmish', about: 'Turn-based tactics on a hex board. Commands, hot-seat or online.' },
  {
    screen: 'Frontier',
    title: 'Frontier',
    about: 'Real-time skirmish with fog of war. Netcode, host and join, test windows.',
  },
  { screen: 'Showcase', title: 'Showcase', about: '3D models, sprites and canvas UI in one scene.' },
];

function MenuScreen() {
  return (
    <div className="menu" data-interactive>
      <h1>Synergy</h1>
      {GAMES.map((game) => (
        <button key={game.screen} type="button" onClick={() => void openScreen(game.screen)}>
          <strong>{game.title}</strong>
          <span>{game.about}</span>
        </button>
      ))}
    </div>
  );
}
