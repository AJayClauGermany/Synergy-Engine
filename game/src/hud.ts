import { type GameObject, Observable } from '@synergy/engine';
import type { Team, Unit } from './rules/skirmish';

/**
 * State the HUD shows. Game code writes these observables; Preact components read them
 * with `useObservable`. Keeping this in one small module is the whole "UI binding" layer.
 */
export interface HudState {
  turn: Team;
  turnNumber: number;
  winner: Team | null;
  /** The side this player controls right now, or `null` when only watching. */
  localTeam: Team | null;
  selected: Unit | null;
  /** A short line of feedback, e.g. why a move was refused. */
  message: string;
}

export interface NetworkState {
  /** 'windows': a local room between windows of this browser, for testing (`localPlay.ts`). */
  mode: 'local' | 'connecting' | 'p2p' | 'windows' | 'convex';
  /** Code other players type to join. */
  roomCode: string | null;
  players: number;
  isHost: boolean;
  error: string | null;
}

export interface UnitMarker {
  id: number;
  team: Team;
  hp: number;
  gameObject: GameObject;
}

export const hud = new Observable<HudState>({
  turn: 0,
  turnNumber: 1,
  winner: null,
  localTeam: 0,
  selected: null,
  message: '',
});

export const network = new Observable<NetworkState>({
  mode: 'local',
  roomCode: null,
  players: 1,
  isHost: true,
  error: null,
});

/** One entry per living unit, for health bars pinned above them. */
export const unitMarkers = new Observable<UnitMarker[]>([]);
