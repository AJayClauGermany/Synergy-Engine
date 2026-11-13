import {
  CapsuleCollider,
  Color,
  Ease,
  findAnyObjectByType,
  GameObject,
  Material,
  Mesh,
  MeshFilter,
  MeshRenderer,
  PrimitiveType,
  Tween,
  Vector3,
} from '@synergy/engine';
import { Hex } from '@synergy/engine/grid';
import { NetworkBehaviour, NetworkPrefab, NetworkVariable } from '@synergy/netcode';
import { FrontierBoard } from './FrontierBoard';
import { frontierHud } from './hud';
import { type Combatant, Match } from './Match';
import { type Cell, damageTo, reachableFrom, sightFrom, type UnitType, unitTypes } from './rules';

const TEAM_COLORS = [Color.fromHex('#3d7dd8'), Color.fromHex('#d8503d')] as const;

/**
 * One unit. Its state (type, team, cell, health, when it may act again) is in
 * NetworkVariables, which only the host changes; every machine shows what they say.
 *
 * A player gives an order by calling `moveRpc` or `attackRpc`. Those run on the host,
 * which checks the order against the rules and either changes the variables or refuses.
 * Nothing else changes a Soldier.
 *
 * Units are owned by the server, not by the player who commands them: which team a unit
 * fights for is game state (`team`), and which client commands a team is decided by the
 * Match (`teamOf`). So the RPCs accept a call from any client, and check the team.
 *
 * Unity: a NetworkBehaviour with NetworkVariables and [ServerRpc(RequireOwnership = false)].
 */
export class Soldier extends NetworkBehaviour implements Combatant {
  /** A unit type id from the `unitTypes` catalog. */
  readonly type = new NetworkVariable('scout');
  readonly team = new NetworkVariable(0);
  readonly cell = new NetworkVariable<Cell>({ x: 0, y: 0 });
  readonly hp = new NetworkVariable(1);
  /** The network time (seconds) from which this unit may be given another order. */
  readonly readyAt = new NetworkVariable(0);

  // ---- Orders: called by a player, run on the host -------------------------------------

  readonly moveRpc = this.serverRpc((x: number, y: number) => this.move(x, y), { requireOwnership: false });
  readonly attackRpc = this.serverRpc((targetId: number) => this.attack(targetId), { requireOwnership: false });
  /**
   * The host's answer to a refused order, sent only to the player who gave it. A
   * `clientRpc` can be called by the host alone, so a player cannot put words in another
   * player's HUD; and what arrives is still checked, because it came over the network.
   */
  readonly refusedRpc = this.clientRpc((reason: string) => {
    if (typeof reason === 'string') frontierHud.update((state) => ({ ...state, message: reason.slice(0, 200) }));
  });

  private _match: Match | null = null;
  private _board: FrontierBoard | null = null;
  private _body: MeshRenderer | null = null;

  get unitType(): UnitType {
    return unitTypes.get(this.type.value);
  }

  get sight(): number {
    return sightFrom(this.unitType, this.cell.value);
  }

  /** Whether it can take an order at network time `now`. */
  isReady(now: number): boolean {
    return now >= this.readyAt.value;
  }

  // ---- Every machine: show the state ----------------------------------------------------

  onNetworkSpawn() {
    // The variables hold their current values here, for a late joiner too: read them now
    // and subscribe for what changes later.
    this._match = Match.of(this.networkManager);
    this._match?.units.add(this);
    this._board = findAnyObjectByType(FrontierBoard);
    this._body = this.getComponentInChildren(MeshRenderer);

    this.name = `${this.team.value === 0 ? 'Blue' : 'Red'} ${this.type.value} ${this.networkObjectId}`;
    const material = new Material();
    material.color = TEAM_COLORS[this.team.value] ?? Color.gray;
    material.smoothness = 0.4;
    if (this._body) this._body.material = material;
    this.transform.localScale = Vector3.one.mul(this.type.value === 'guard' ? 1.2 : 0.9);
    if (this._board) this.transform.position = this._board.cellToWorld(this.cell.value);

    this.cell.onValueChanged.add((_before, now) => {
      if (this._board) Tween.move(this.transform, this._board.cellToWorld(now), 0.3).setEase(Ease.OutCubic);
    });
  }

  onNetworkDespawn() {
    this._match?.units.delete(this);
    Tween.kill(this.transform);
  }

  /** Shows or hides the unit on this machine only. The host has every unit, and hides the ones its own player has not found. */
  setShown(shown: boolean) {
    if (this._body) this._body.enabled = shown;
  }

  // ---- Host only: check an order, then carry it out ---------------------------------------

  /** Who is asking, and are they allowed to order this unit right now? Answers with the reason when not. */
  private refusal(): string | null {
    const match = this._match;
    if (!match || match.phase.value !== 'playing') return 'The match is not being played.';
    if (match.teamOf(this.rpcSenderClientId) !== this.team.value) return 'That unit is not yours to command.';
    if (!this.isReady(this.networkManager.serverTime.time)) return 'That unit is not ready yet.';
    return null;
  }

  private refuse(reason: string) {
    this.refusedRpc.sendTo([this.rpcSenderClientId], reason);
  }

  private move(x: number, y: number) {
    // Arguments come from another machine: check their shape before their meaning.
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const problem = this.refusal();
    if (problem) return this.refuse(problem);
    const match = this._match as Match;
    const target = { x, y };
    const reach = reachableFrom(this.cell.value, this.unitType.moveRange, (cell) => match.unitAt(cell) !== null);
    if (!reach.has(target) || (target.x === this.cell.value.x && target.y === this.cell.value.y)) {
      return this.refuse('That cell is out of reach.');
    }

    this.cell.value = target;
    this.readyAt.value = this.networkManager.serverTime.time + this.unitType.cooldown;
    match.refreshVisibility(); // moving changes what both sides can see
  }

  private attack(targetId: number) {
    if (!Number.isInteger(targetId)) return;
    const problem = this.refusal();
    if (problem) return this.refuse(problem);
    const match = this._match as Match;
    // Another object is named by its NetworkObjectId, and looked up here: it may be gone.
    const target = this.networkManager.spawnManager.spawnedObjects.get(targetId)?.getComponent(Soldier) ?? null;
    if (!target || target.team.value === this.team.value) return this.refuse('There is no enemy there.');
    if (Hex.distance(this.cell.value, target.cell.value) !== 1)
      return this.refuse('That enemy is not next to this unit.');

    this.readyAt.value = this.networkManager.serverTime.time + this.unitType.cooldown;
    target.hp.value -= damageTo(this.unitType, target.cell.value);
    if (target.hp.value <= 0) {
      target.networkObject.despawn(); // removes it on every machine that had it
      match.refreshVisibility();
      match.checkVictory();
    }
  }
}

let bodyMesh: Mesh | null = null;

export const SoldierPrefab = new NetworkPrefab('Soldier', (go) => {
  const collider = go.addComponent(CapsuleCollider);
  collider.center = new Vector3(0, 0.6, 0);
  collider.radius = 0.32;
  collider.height = 1.2;

  // The body is a child, so the unit's own transform stays at the cell centre on the ground.
  const body = new GameObject('Body');
  body.transform.setParent(go.transform, false);
  body.transform.localPosition = new Vector3(0, 0.55, 0);
  body.transform.localScale = new Vector3(0.5, 0.5, 0.5);
  bodyMesh ??= Mesh.primitive(PrimitiveType.Capsule);
  body.addComponent(MeshFilter).mesh = bodyMesh;
  body.addComponent(MeshRenderer);

  go.addComponent(Soldier);
});
