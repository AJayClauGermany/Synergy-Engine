import { Camera, destroy, Input, instantiate, KeyCode, MonoBehaviour, Physics } from '@synergy/engine';
import { type CommandEntry, CommandSession, type Session } from '@synergy/net';
import { hud, network, unitMarkers } from '../hud';
import {
  apply,
  attackable,
  type Cell,
  check,
  type Command,
  createGame,
  type GameState,
  pathFor,
  reachable,
  type Team,
  teamOf,
  type Unit,
  unitAt,
  unitById,
} from '../rules/skirmish';
import type { BoardView } from './BoardView';
import { UnitPrefab, UnitView } from './UnitView';

/**
 * Connects the three parts of the game:
 *
 *   input  --submit(command)-->  session  --onCommand-->  rules.apply  -->  views + HUD
 *
 * State only ever changes in `receive`, when a command comes back from the session. That
 * one rule is what makes single-player, hot-seat and online play share the same code.
 */
export class GameController extends MonoBehaviour {
  /** The classic Unity singleton, so the HUD can reach the controller. */
  static instance: GameController | null = null;

  board: BoardView | null = null;

  private state: GameState = createGame();
  private session: Session<Command> = CommandSession.local<Command>();
  private detach: (() => void)[] = [];
  private readonly views = new Map<number, UnitView>();
  private selectedId: number | null = null;

  awake() {
    GameController.instance = this;
  }

  start() {
    this.useSession(this.session, 'local');
  }

  onDestroy() {
    for (const off of this.detach) off();
    this.session.close();
    if (GameController.instance === this) GameController.instance = null;
    unitMarkers.value = [];
  }

  // ---- Sessions -----------------------------------------------------------------------

  /** The current game state. Read-only for callers; change it by submitting commands. */
  get current(): GameState {
    return this.state;
  }

  /**
   * Switches to a new session (local, peer-to-peer or Convex) and restarts the board from
   * that session's history.
   */
  useSession(session: Session<Command>, mode: 'local' | 'p2p' | 'convex', roomCode: string | null = null) {
    for (const off of this.detach) off();
    if (session !== this.session) this.session.close();
    this.session = session;
    this.state = createGame();
    this.selectedId = null;

    let playerCount = session.players.length;
    const publish = () => {
      network.value = {
        mode,
        roomCode,
        players: session.players.length,
        isHost: session.isHost,
        error: null,
      };
      this.refresh();
    };
    this.detach = [
      session.onCommand.add((entry) => this.receive(entry)),
      session.onRejected.add((_command, reason) => this.say(reason)),
      session.onPlayersChanged.add((players) => {
        // A second player arriving starts a fresh game so both begin from the same position.
        if (session.isHost && playerCount === 1 && players.length === 2) session.submit({ type: 'restart' });
        playerCount = players.length;
        publish();
      }),
      session.onClosed.add((reason) => {
        if (this.session !== session || this.isDestroyed) return;
        this.useSession(CommandSession.local<Command>(), 'local');
        network.update((value) => ({ ...value, error: reason }));
      }),
    ];
    // Catch up on anything that already happened in this session.
    for (const entry of session.log) this.receive(entry);
    publish();
  }

  /** Host-side validation for peer-to-peer sessions: refuse illegal commands at the source. */
  validate = (candidate: { playerId: string; command: Command }): string | undefined => {
    return this.judge(candidate.playerId, candidate.command) ?? undefined;
  };

  private judge(playerId: string, command: Command): string | null {
    const players = this.session.players;
    // The host may always restart (used when a second player joins).
    if (command.type === 'restart' && playerId === players[0]) return null;
    const team = teamOf(playerId, players, this.state.turn);
    if (team === null) return 'You are watching this game.';
    return check(this.state, command, team);
  }

  private receive(entry: CommandEntry<Command>) {
    // Every machine runs the same check, so an illegal command is ignored everywhere.
    if (this.judge(entry.playerId, entry.command) !== null) return;
    const before = this.state;
    const command = entry.command;
    this.state = apply(before, command);
    // Animate from what the state was: the route walked, the blow struck.
    if (command.type === 'move') {
      const unit = unitById(before, command.unit);
      const path = unit ? pathFor(before, unit, command) : null;
      if (path) this.views.get(command.unit)?.moveAlong(path);
    } else if (command.type === 'attack') {
      const target = unitById(before, command.target);
      if (target) {
        this.views.get(command.unit)?.playAttack(target);
        this.views.get(command.target)?.playHit();
      }
    } else {
      this.selectedId = null;
    }
    this.refresh();
  }

  // ---- Player actions (also called by the HUD) ------------------------------------------

  get localTeam(): Team | null {
    return teamOf(this.session.localId, this.session.players, this.state.turn);
  }

  submit(command: Command) {
    const reason = this.judge(this.session.localId, command);
    if (reason) this.say(reason);
    else this.session.submit(command);
  }

  endTurn() {
    this.submit({ type: 'endTurn' });
  }

  restart() {
    this.submit({ type: 'restart' });
  }

  /** What a click on a board cell means depends on what is selected and what is there. */
  clickCell(cell: Cell) {
    const state = this.state;
    const occupant = unitAt(state, cell.x, cell.y);
    const selected = this.selectedId === null ? undefined : unitById(state, this.selectedId);

    if (selected && occupant && attackable(state, selected).includes(occupant)) {
      this.submit({ type: 'attack', unit: selected.id, target: occupant.id });
    } else if (selected && !occupant && reachable(state, selected).some((c) => c.x === cell.x && c.y === cell.y)) {
      this.submit({ type: 'move', unit: selected.id, x: cell.x, y: cell.y });
    } else if (occupant && occupant.team === state.turn && occupant.team === this.localTeam) {
      this.selectedId = occupant.id;
    } else {
      this.selectedId = null;
    }
    this.refresh();
  }

  update() {
    if (Input.getKeyDown(KeyCode.Space)) this.endTurn();
    if (Input.getKeyDown(KeyCode.Escape)) {
      this.selectedId = null;
      this.refresh();
    }
    if (!Input.getMouseButtonDown(0)) return;
    const camera = Camera.main;
    if (!camera) return;
    const ray = camera.screenPointToRay(Input.mousePosition);
    // Units have colliders: clicking one means clicking the cell it stands on.
    // Anything else is resolved by the grid itself, which needs no colliders.
    const unit = Physics.raycast(ray)?.gameObject.getComponent(UnitView);
    const standing = unit ? unitById(this.state, unit.unitId) : undefined;
    const cell = standing ? { x: standing.x, y: standing.y } : this.board?.rayToCell(ray);
    if (cell) this.clickCell(cell);
  }

  // ---- Showing the state --------------------------------------------------------------

  private say(message: string) {
    hud.update((value) => ({ ...value, message }));
  }

  /** Brings the pieces, highlights and HUD in line with `this.state`. */
  private refresh() {
    const state = this.state;
    const alive = new Set(state.units.map((unit) => unit.id));

    for (const [id, view] of this.views) {
      if (alive.has(id)) continue;
      destroy(view.gameObject);
      this.views.delete(id);
    }
    if (!this.board) return;
    for (const unit of state.units) {
      let view = this.views.get(unit.id);
      if (!view) {
        view = instantiate(UnitPrefab, this.transform).getComponent(UnitView) as UnitView;
        view.setup(unit.id, unit.team, unit, this.board);
        this.views.set(unit.id, view);
      }
      // Moves are animated in `receive`; this only corrects a view that is out of place.
      view.snapTo(unit);
      view.selected = unit.id === this.selectedId;
    }

    let selected: Unit | null = null;
    if (this.selectedId !== null) selected = unitById(state, this.selectedId) ?? null;
    if (!selected) this.selectedId = null;

    this.board.clearHighlights();
    if (selected) {
      this.board.highlight([selected], 'selected');
      this.board.highlight(reachable(state, selected), 'move');
      this.board.highlight(attackable(state, selected), 'attack');
    }

    hud.value = {
      turn: state.turn,
      turnNumber: state.turnNumber,
      winner: state.winner,
      localTeam: this.localTeam,
      selected,
      message: hud.value.message,
    };
    unitMarkers.value = state.units.map((unit) => ({
      id: unit.id,
      team: unit.team,
      hp: unit.hp,
      gameObject: (this.views.get(unit.id) as UnitView).gameObject,
    }));
  }
}
