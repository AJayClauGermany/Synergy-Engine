import {
  NetworkBehaviour,
  NetworkList,
  type NetworkManager,
  type NetworkObject,
  NetworkPrefab,
  NetworkVariable,
} from '@synergy/netcode';
import { canSee, type Cell, INCOME, type Viewer, WORLD_TICK_SECONDS } from './rules';

export type Phase = 'waiting' | 'playing' | 'over';

/** Which team a connected client commands. Team -1 watches. */
export interface Seat {
  client: number;
  team: number;
}

/** What the match needs to know about a unit. `Soldier` is one. */
export interface Combatant {
  readonly team: NetworkVariable<number>;
  readonly cell: NetworkVariable<Cell>;
  /** How far it sees from where it stands. */
  readonly sight: number;
  readonly networkObject: NetworkObject;
}

// One match per NetworkManager. Not a `static instance`: tests run several simulated
// machines in one process, and a static would be shared between them.
const matches = new WeakMap<NetworkManager, Match>();

/**
 * The match itself: its phase, who plays which team, each team's resources, the world's
 * clock. One is spawned by the host when the match scene has loaded; every machine gets
 * a copy and finds it with `Match.of(networkManager)`.
 *
 * Unity: a NetworkBehaviour "game manager" in the match scene. Everything a player must
 * agree on is a NetworkVariable here or on a Soldier, so a player who joins late is sent
 * the current values and needs no history.
 */
export class Match extends NetworkBehaviour {
  /** This machine's copy of the match, or `null` before it has arrived (or after it ended). */
  static of(manager: NetworkManager | null): Match | null {
    return (manager && matches.get(manager)) ?? null;
  }

  /** 'waiting' until every machine has the scene, then 'playing', then 'over'. Orders are refused unless 'playing'. */
  readonly phase = new NetworkVariable<Phase>('waiting');
  /** The winning team once the phase is 'over'. */
  readonly winner = new NetworkVariable(-1);
  readonly seats = new NetworkList<Seat>();
  /** Resources per team: [team 0, team 1]. */
  readonly resources = new NetworkVariable<number[]>([0, 0]);
  /** How many times the world has advanced. */
  readonly worldTick = new NetworkVariable(0);

  /** Every unit this machine has. On the host that is all of them; on a client, only those it may see. */
  readonly units = new Set<Combatant>();

  private _manager: NetworkManager | null = null;
  private _nextWorldTickAt = 0;
  private _offs: (() => void)[] = [];

  onNetworkSpawn() {
    const manager = this.networkManager;
    this._manager = manager;
    matches.set(manager, this);
    if (!this.isServer) return;

    for (const clientId of manager.connectedClientsIds) this.seat(clientId);
    this._offs.push(
      manager.onClientConnectedCallback.add((clientId) => {
        this.seat(clientId);
        this.refreshVisibility(); // the newcomer now has a team, which decides what it may see
      }),
      manager.onClientDisconnectCallback.add((clientId) => this.unseat(clientId)),
    );
  }

  onNetworkDespawn() {
    for (const off of this._offs.splice(0)) off();
    if (this._manager && matches.get(this._manager) === this) matches.delete(this._manager);
  }

  /** The host advances the world on the network clock, which every machine shares. */
  update() {
    if (!this.isServer || this.phase.value !== 'playing') return;
    const now = this.networkManager.serverTime.time;
    while (now >= this._nextWorldTickAt) {
      this._nextWorldTickAt += WORLD_TICK_SECONDS;
      this.worldTick.value += 1;
      // Replace the array: a NetworkVariable notices a new value, not a change inside the old one.
      this.resources.value = this.resources.value.map((amount) => amount + INCOME);
    }
  }

  // ---- Questions any machine can ask --------------------------------------------------------

  /** The team a client commands, or -1 if it is watching. */
  teamOf(clientId: number): number {
    for (const seat of this.seats) if (seat.client === clientId) return seat.team;
    return -1;
  }

  /** The unit standing on a cell, among those this machine has. */
  unitAt(cell: Cell): Combatant | null {
    for (const unit of this.units) if (unit.cell.value.x === cell.x && unit.cell.value.y === cell.y) return unit;
    return null;
  }

  /** The eyes of a team: where its units are and how far each sees. */
  viewersOf(team: number): Viewer[] {
    return [...this.units]
      .filter((unit) => unit.team.value === team)
      .map((unit) => ({ cell: unit.cell.value, sight: unit.sight }));
  }

  // ---- Host only ----------------------------------------------------------------------------

  /** Lets play begin. The host calls it once every machine has loaded the match scene. */
  begin() {
    this._nextWorldTickAt = this.networkManager.serverTime.time + WORLD_TICK_SECONDS;
    this.phase.value = 'playing';
    this.refreshVisibility();
  }

  /**
   * Whether a client may know about a unit: its own team's always, an enemy only while
   * one of its units sees it. Watchers see everything. Units ask this through
   * `checkObjectVisibility`, so a hidden enemy is not sent to that client at all.
   *
   * A client that has no seat yet is sent nothing. That moment exists: the host builds a
   * newcomer's first picture of the world before `onClientConnectedCallback` gives it a
   * seat, and "not seated" must not be read as "watching", or every joining player would
   * be handed the enemy's positions. Once seated, `refreshVisibility` sends what it may see.
   */
  canClientSee(clientId: number, unit: Combatant): boolean {
    const seat = [...this.seats].find((candidate) => candidate.client === clientId);
    if (!seat) return false;
    if (seat.team < 0) return true;
    return unit.team.value === seat.team || canSee(this.viewersOf(seat.team), unit.cell.value);
  }

  /** Call after anything that changes who sees whom: a move, a death, a new player. */
  refreshVisibility() {
    for (const unit of this.units) unit.networkObject.updateVisibility();
  }

  /** Ends the match when only one team has units left. */
  checkVictory() {
    if (this.phase.value !== 'playing') return;
    const alive = new Set([...this.units].map((unit) => unit.team.value));
    if (alive.size > 1) return;
    this.winner.value = [...alive][0] ?? -1;
    this.phase.value = 'over';
  }

  private seat(clientId: number) {
    if (this.teamOf(clientId) >= 0 || [...this.seats].some((seat) => seat.client === clientId)) return;
    const taken = new Set([...this.seats].map((seat) => seat.team));
    const team = [0, 1].find((candidate) => !taken.has(candidate)) ?? -1;
    this.seats.add({ client: clientId, team });
  }

  private unseat(clientId: number) {
    const index = [...this.seats].findIndex((seat) => seat.client === clientId);
    if (index >= 0) this.seats.removeAt(index);
  }
}

export const MatchPrefab = new NetworkPrefab('Match', (go) => {
  go.addComponent(Match);
});
