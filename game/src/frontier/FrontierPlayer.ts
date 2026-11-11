import { Camera, Input, MonoBehaviour } from '@synergy/engine';
import { cellKey, Hex } from '@synergy/engine/grid';
import { NetworkManager } from '@synergy/netcode';
import type { FrontierBoard } from './FrontierBoard';
import { type FrontierHudState, frontierHud } from './hud';
import { Match } from './Match';
import { type Cell, reachableFrom, visibleCells } from './rules';
import { Soldier } from './Soldier';

/**
 * The person at this machine: what they have selected, what they can see, and their
 * clicks. It runs on every machine, for that machine's own player, and owns no game
 * state: a click becomes an order (`soldier.moveRpc(...)`) that the host decides on.
 *
 * Unity: a local "player controller" MonoBehaviour, not a NetworkBehaviour.
 */
export class FrontierPlayer extends MonoBehaviour {
  board: FrontierBoard | null = null;

  private _selected: Soldier | null = null;
  /** What the fog and the highlights were last drawn from, to redraw only on a change. */
  private _seen = '';
  private _orders = '';

  /** The team this machine's player commands (-1 when watching or before the match arrives). */
  get team(): number {
    const manager = NetworkManager.singleton;
    return Match.of(manager)?.teamOf(manager?.localClientId ?? -1) ?? -1;
  }

  update() {
    const manager = NetworkManager.singleton;
    const match = Match.of(manager);
    if (!manager || !match || !this.board) {
      this.publish({ phase: 'offline', selected: null });
      return;
    }
    const team = match.teamOf(manager.localClientId);
    const soldiers = [...match.units].filter((unit): unit is Soldier => unit instanceof Soldier);
    const own = soldiers.filter((soldier) => soldier.team.value === team);
    if (this._selected && !soldiers.includes(this._selected)) this._selected = null; // it died, or went out of sight

    // ---- What this player sees. A watcher (team -1) sees the whole map. ----
    const viewers = match.viewersOf(team);
    const visible = team < 0 ? null : visibleCells(viewers);
    const seen = team < 0 ? 'all' : viewers.map((viewer) => `${viewer.cell.x},${viewer.cell.y},${viewer.sight}`).join(' ');
    if (seen !== this._seen) {
      this._seen = seen;
      this.board.showFog(visible);
    }
    // A client is only sent the enemies its team sees. The host holds every unit, so on
    // the host's machine the same rule is applied by not drawing the others.
    let enemiesInSight = 0;
    for (const soldier of soldiers) {
      const shown = visible === null || soldier.team.value === team || visible.has(cellKey(soldier.cell.value));
      soldier.setShown(shown);
      if (shown && soldier.team.value !== team) enemiesInSight++;
    }

    // ---- Orders ----
    const now = manager.serverTime.time;
    const playing = match.phase.value === 'playing';
    if (playing && Input.getMouseButtonDown(0)) this.click(match, own);
    if (Input.getMouseButtonDown(1)) this._selected = null;
    this.drawOrders(match, playing ? this._selected : null, now);

    const selected = this._selected;
    this.publish({
      phase: match.phase.value,
      team,
      winner: match.winner.value,
      resources: match.resources.value[team] ?? 0,
      worldTick: match.worldTick.value,
      ownUnits: own.length,
      enemiesInSight,
      selected: selected && {
        name: selected.unitType.id,
        hp: selected.hp.value,
        maxHp: selected.unitType.maxHp,
        ready: selected.isReady(now),
      },
    });
  }

  private click(match: Match, own: Soldier[]) {
    const camera = Camera.main;
    const cell = camera && this.board?.rayToCell(camera.screenPointToRay(Input.mousePosition));
    if (!cell) return;
    const there = match.unitAt(cell);
    const selected = this._selected;

    if (there instanceof Soldier && own.includes(there)) {
      this._selected = there;
      frontierHud.update((state) => ({ ...state, message: '' }));
    } else if (selected && there instanceof Soldier) {
      // An enemy this machine can see. Ask the host; it checks range, readiness and the rest.
      selected.attackRpc(there.networkObjectId);
    } else if (selected) {
      selected.moveRpc(cell.x, cell.y);
    }
  }

  /** Highlights what the selected unit could do. Only a preview: the host decides when the order arrives. */
  private drawOrders(match: Match, selected: Soldier | null, now: number) {
    const board = this.board;
    if (!board) return;
    if (!selected) {
      if (this._orders !== '') board.showOrders();
      this._orders = '';
      return;
    }
    const at = selected.cell.value;
    const ready = selected.isReady(now);
    const occupied = [...match.units].map((unit) => cellKey(unit.cell.value)).sort().join(' ');
    const orders = `${selected.networkObjectId}:${at.x},${at.y}:${ready}:${occupied}`;
    if (orders === this._orders) return;
    this._orders = orders;

    let reach: Cell[] = [];
    let targets: Cell[] = [];
    if (ready) {
      reach = reachableFrom(at, selected.unitType.moveRange, (cell) => match.unitAt(cell) !== null)
        .cells.map(({ cell }) => ({ x: cell.x, y: cell.y }))
        .filter((cell) => cell.x !== at.x || cell.y !== at.y);
      targets = [...match.units]
        .filter((unit) => unit.team.value !== selected.team.value && Hex.distance(unit.cell.value, at) === 1)
        .map((unit) => unit.cell.value);
    }
    board.showOrders(at, reach, targets);
  }

  /** Updates the HUD, but only when something it shows has changed. */
  private publish(next: Partial<FrontierHudState>) {
    const merged = { ...frontierHud.value, ...next };
    if (JSON.stringify(merged) !== JSON.stringify(frontierHud.value)) frontierHud.value = merged;
  }
}
