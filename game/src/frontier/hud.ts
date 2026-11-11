import { Observable } from '@synergy/engine';
import type { Phase } from './Match';

/** What Frontier's HUD shows. `FrontierPlayer` writes it; `FrontierHud` reads it with `useObservable`. */
export interface FrontierHudState {
  /** 'offline' until this machine has a match. */
  phase: Phase | 'offline';
  /** The team this player commands: 0 or 1, or -1 when watching. */
  team: number;
  winner: number;
  /** This team's resources. */
  resources: number;
  worldTick: number;
  /** How many of your units are alive, and how many enemy units you can see right now. */
  ownUnits: number;
  enemiesInSight: number;
  selected: { name: string; hp: number; maxHp: number; ready: boolean } | null;
  /** The last thing the host refused, or a hint. */
  message: string;
}

export interface FrontierOnlineState {
  mode: 'offline' | 'connecting' | 'hosting' | 'joined';
  /** The code other players type to join. */
  code: string | null;
  isHost: boolean;
  error: string | null;
}

export const frontierHud = new Observable<FrontierHudState>({
  phase: 'offline',
  team: -1,
  winner: -1,
  resources: 0,
  worldTick: 0,
  ownUnits: 0,
  enemiesInSight: 0,
  selected: null,
  message: '',
});

export const frontierOnline = new Observable<FrontierOnlineState>({ mode: 'offline', code: null, isHost: true, error: null });
