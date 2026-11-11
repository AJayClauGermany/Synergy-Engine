import type { NetworkManager } from '@synergy/netcode';
import { useObservable } from '@synergy/ui';
import { useState } from 'react';
import { frontierHud, frontierOnline } from './hud';
import { TEAM_NAMES } from './rules';
import { hostOnline, joinOnline, playOffline, rematch } from './session';

/** Frontier's heads-up display. It reads the observables in hud.ts; its buttons call session.ts. */
export function FrontierHud({ manager }: { manager: NetworkManager }) {
  return (
    <>
      <Banner manager={manager} />
      <OnlinePanel manager={manager} />
      <OrderBar />
      <p className="hint">Click one of your units, then a blue cell to move or a red one to attack · right-click clears · WASD pan · Q/E rotate · wheel zoom</p>
    </>
  );
}

function Banner({ manager }: { manager: NetworkManager }) {
  const state = useObservable(frontierHud);
  const online = useObservable(frontierOnline);
  const team = state.team >= 0 ? state.team : undefined;
  if (state.phase === 'over') {
    return (
      <div className="banner" data-team={state.winner} data-interactive>
        <strong>{TEAM_NAMES[state.winner] ?? 'Nobody'} wins</strong>
        {online.isHost ? (
          <button type="button" onClick={() => void rematch(manager)}>
            Play again
          </button>
        ) : (
          <span>waiting for the host</span>
        )}
      </div>
    );
  }
  if (state.phase !== 'playing') {
    return (
      <div className="banner">
        <strong>{state.phase === 'waiting' ? 'Waiting for every player to load…' : 'Starting…'}</strong>
      </div>
    );
  }
  return (
    <div className="banner" data-team={team}>
      <strong>{team === undefined ? 'Watching' : `You command ${TEAM_NAMES[team]}`}</strong>
      <span>
        {team === undefined ? '' : `${state.resources} supplies · ${state.ownUnits} units · `}
        {state.enemiesInSight} {state.enemiesInSight === 1 ? 'enemy' : 'enemies'} in sight · tick {state.worldTick}
      </span>
    </div>
  );
}

function OrderBar() {
  const state = useObservable(frontierHud);
  const unit = state.selected;
  return (
    <div className="action-bar">
      <div className="selection">
        {unit ? (
          <>
            <span className="swatch" data-team={state.team} />
            <span>
              {unit.name} · {unit.hp}/{unit.maxHp} HP
            </span>
            <span className="muted">{state.message || (unit.ready ? 'ready for orders' : 'recovering…')}</span>
          </>
        ) : (
          <span className="muted">{state.message || 'Select one of your units'}</span>
        )}
      </div>
    </div>
  );
}

function OnlinePanel({ manager }: { manager: NetworkManager }) {
  const state = useObservable(frontierOnline);
  const [code, setCode] = useState('');

  if (state.mode === 'connecting') {
    return (
      <div className="panel network" data-interactive>
        Connecting…
      </div>
    );
  }
  if (state.mode !== 'offline') {
    return (
      <div className="panel network" data-interactive>
        <div className="row">
          <span className="muted">{state.mode === 'hosting' ? 'Hosting · share the code' : 'Joined'}</span>
          <code>{state.code}</code>
        </div>
        <div className="row">
          <span />
          <button type="button" onClick={() => void playOffline(manager)}>
            Leave
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel network" data-interactive>
      <div className="row">
        <span>Playing alone</span>
        <button type="button" onClick={() => void hostOnline(manager)}>
          Host online
        </button>
      </div>
      {state.error && <p className="error">{state.error}</p>}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void joinOnline(manager, code);
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
      </form>
    </div>
  );
}
