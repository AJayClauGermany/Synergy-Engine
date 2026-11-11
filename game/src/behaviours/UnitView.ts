import {
  CapsuleCollider,
  Color,
  GameObject,
  type IEnumerator,
  Material,
  Mesh,
  MeshFilter,
  MeshRenderer,
  MonoBehaviour,
  LoopType,
  Prefab,
  PrimitiveType,
  Time,
  Tween,
  Vector3,
} from '@synergy/engine';
import type { Cell, Team } from '../rules/skirmish';
import type { BoardView } from './BoardView';

const TEAM_COLORS = [Color.fromHex('#3d7dd8'), Color.fromHex('#d8503d')] as const;
const teamMaterials = new Map<Team, Material>();

function teamMaterial(team: Team): Material {
  let material = teamMaterials.get(team);
  if (!material) {
    material = new Material();
    material.color = TEAM_COLORS[team];
    material.smoothness = 0.4;
    teamMaterials.set(team, material);
  }
  return material;
}

/** The on-screen piece for one unit. The rules own the data; this only shows it. */
export class UnitView extends MonoBehaviour {
  unitId = -1;
  team: Team = 0;
  moveSpeed = 6;
  selected = false;

  private cell: Cell = { x: 0, y: 0 };
  private board: BoardView | null = null;
  private body: MeshRenderer | null = null;

  awake() {
    this.body = this.getComponentInChildren(MeshRenderer);
  }

  /** Call once right after instantiating. */
  setup(unitId: number, team: Team, cell: Cell, board: BoardView) {
    this.unitId = unitId;
    this.team = team;
    this.cell = { x: cell.x, y: cell.y };
    this.board = board;
    this.name = `Unit ${unitId}`;
    this.transform.position = board.cellToWorld(cell);
    // Face the opposing side.
    this.transform.forward = team === 0 ? Vector3.forward : Vector3.back;
    if (this.body) this.body.sharedMaterial = teamMaterial(team);
  }

  /** Walks cell by cell along `path` (which starts at the current cell). */
  moveAlong(path: readonly Cell[]) {
    const destination = path.at(-1);
    if (!destination || !this.board) return;
    this.cell = { x: destination.x, y: destination.y };
    this.stopAllCoroutines();
    this.startCoroutine(this.walk(path.slice(1).map((cell) => (this.board as BoardView).cellToWorld(cell))));
  }

  /** Jumps to a cell if the view is somewhere else (after a restart or when joining a game). */
  snapTo(cell: Cell) {
    if (!this.board || (cell.x === this.cell.x && cell.y === this.cell.y)) return;
    this.cell = { x: cell.x, y: cell.y };
    this.stopAllCoroutines();
    this.transform.position = this.board.cellToWorld(cell);
  }

  /** A quick lunge toward the target and back. */
  playAttack(target: Cell) {
    if (!this.board) return;
    this.stopAllCoroutines();
    this.startCoroutine(this.lunge(this.board.cellToWorld(this.cell), this.board.cellToWorld(target)));
  }

  /** A short squash when hit. Tweens suit one-off effects like this better than coroutines. */
  playHit() {
    if (!this.body) return;
    const body = this.body.transform;
    Tween.kill(body.gameObject);
    body.localScale = BODY_SCALE;
    Tween.scale(body, BODY_SCALE.scale(new Vector3(1.3, 0.7, 1.3)), 0.09).setLoops(2, LoopType.Yoyo);
  }

  update() {
    if (!this.body) return;
    // Selected units bob so the selection is readable without extra UI.
    const height = this.selected ? 0.12 + Math.sin(Time.time * 6) * 0.08 : 0;
    this.body.transform.localPosition = new Vector3(0, 0.6 + height, 0);
  }

  private *walk(waypoints: Vector3[]): IEnumerator {
    for (const waypoint of waypoints) yield* this.slide(waypoint);
  }

  private *slide(destination: Vector3): IEnumerator {
    while (Vector3.distance(this.transform.position, destination) > 0.001) {
      this.transform.position = Vector3.moveTowards(
        this.transform.position,
        destination,
        this.moveSpeed * Time.deltaTime,
      );
      yield null;
    }
    this.transform.position = destination;
  }

  private *lunge(home: Vector3, toward: Vector3): IEnumerator {
    yield* this.slide(Vector3.lerp(home, toward, 0.45));
    yield* this.slide(home);
  }
}

const BODY_SCALE = new Vector3(0.55, 0.55, 0.55);

/**
 * Unity would keep this as a prefab asset. Here a prefab is a function that fills in a
 * new GameObject; scripts on it wake up after the function returns.
 */
export const UnitPrefab = new Prefab('Unit', (unit) => {
  // The visible body is a child, so it can bob without moving the unit itself.
  const body = new GameObject('Body');
  body.transform.setParent(unit.transform, false);
  body.transform.localPosition = new Vector3(0, 0.6, 0);
  body.transform.localScale = BODY_SCALE;
  body.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Capsule);
  body.addComponent(MeshRenderer);

  // The collider is what makes the unit clickable.
  const collider = unit.addComponent(CapsuleCollider);
  collider.radius = 0.35;
  collider.height = 1.3;
  collider.center = new Vector3(0, 0.65, 0);
  unit.addComponent(UnitView);
});
