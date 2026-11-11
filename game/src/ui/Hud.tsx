import { Vector3 } from '@synergy/engine';
import { useObservable, WorldAnchor } from '@synergy/ui';
import { useState } from 'react';
import { GameController } from '../behaviours/GameController';
import { hud, network, unitMarkers } from '../hud';
import {
  convexUrl,
  hostConvexGame,
  hostPeerGame,
  joinConvexGame,
  joinPeerGame,
  leaveOnlineGame,
} from '../online';
import { MAX_HP, TEAM_NAMES } from '../rules/skirmish';

const HEAD_HEIGHT = new Vector3(0, 1.55, 0);

/** The whole heads-up display. It reads observables and calls methods on the GameController. */
export function Hud() {
  return (
    <>
      <HealthBars />
      <TurnBanner />
      <NetworkPanel />
      <ActionBar />
      <p className="hint">WASD pan · Q/E rotate · wheel zoom · click a unit, then a tile · Space ends the turn</p>
    </>
  );
}

function TurnBanner() {
  const state = useObservable(hud);
  if (state.winner !== null) {
    return (
      <div className="banner" data-team={state.winner} data-interactive>
        <strong>{TEAM_NAMES[state.winner]} wins</strong>
        <button type="button" onClick={() => GameController.instance?.restart()}>
          Play again
        </button>
      </div>
    );
  }
  const yours = state.localTeam === state.turn;
  return (
    <div className="banner" data-team={state.turn}>
      <strong>{TEAM_NAMES[state.turn]} to move</strong>
      <span>
        Turn {state.turnNumber}
        {state.localTeam === null ? ' · watching' : yours ? ' · your move' : ' · waiting'}
      </span>
    </div>
  );
}

function ActionBar() {
  const state = useObservable(hud);
  const canAct = state.winner === null && state.localTeam === state.turn;
  const unit = state.selected;
  return (
    <div className="action-bar" data-interactive>
      <div className="selection">
        {unit ? (
          <>
            <span className="swatch" data-team={unit.team} />
            <span>
              Unit {unit.id + 1} · {unit.hp}/{MAX_HP} HP
            </span>
            <span className="muted">
              {unit.attacked ? 'done for this turn' : unit.moved ? 'can still attack' : 'can move and attack'}
            </span>
          </>
        ) : (
          <span className="muted">{state.message || 'Select one of your units'}</span>
        )}
      </div>
      <button type="button" className="primary" disabled={!canAct} onClick={() => GameController.instance?.endTurn()}>
        End turn
      </button>
    </div>
  );
}

function HealthBars() {
  const markers = useObservable(unitMarkers);
  return (
    <>
      {markers.map((marker) => (
        <WorldAnchor key={marker.id} target={marker.gameObject} offset={HEAD_HEIGHT}>
          <div className="health" data-team={marker.team} title={`${marker.hp}/${MAX_HP}`}>
            <i style={{ width: `${(marker.hp / MAX_HP) * 100}%` }} />
          </div>
        </WorldAnchor>
      ))}
    </>
  );
}

function NetworkPanel() {
  const state = useObservable(network);
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);

  if (state.mode === 'connecting') {
    return (
      <div className="panel network" data-interactive>
        Connecting…
      </div>
    );
  }
  if (state.mode !== 'local') {
    return (
      <div className="panel network" data-interactive>
        <div className="row">
          <span className="muted">{state.mode === 'p2p' ? 'Peer-to-peer' : 'Convex'} room</span>
          <code>{state.roomCode}</code>
        </div>
        <div className="row">
          <span>
            {state.players} player{state.players === 1 ? '' : 's'}
            {state.players === 1 ? ' · share the code' : ''}
          </span>
          <button type="button" onClick={leaveOnlineGame}>
            Leave
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel network" data-interactive>
      <div className="row">
        <span>Local game</span>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Play online'}
        </button>
      </div>
      {state.error && <p className="error">{state.error}</p>}
      {open && (
        <>
          <div className="row">
            <button type="button" onClick={hostPeerGame}>
              Host
            </button>
            {convexUrl && (
              <button type="button" onClick={hostConvexGame} title="Stored on the server: survives reloads">
                Host (persistent)
              </button>
            )}
          </div>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim()) void joinPeerGame(code);
            }}
          >
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="Room code"
              maxLength={6}
              aria-label="Room code"
            />
            <button type="submit" disabled={!code.trim()}>
              Join
            </button>
            {convexUrl && (
              <button type="button" disabled={!code.trim()} onClick={() => joinConvexGame(code)}>
                Join (persistent)
              </button>
            )}
          </form>
        </>
      )}
    </div>
  );
}
