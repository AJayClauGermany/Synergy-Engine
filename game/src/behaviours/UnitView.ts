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
  Prefab,
  PrimitiveType,
  Time,
  Vector3,
} from '@synergy/engine';
import type { Cell, Team } from '../rules/skirmish';
import { cellToWorld } from './BoardView';

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
  private body: MeshRenderer | null = null;

  awake() {
    this.body = this.getComponentInChildren(MeshRenderer);
  }

  /** Call once right after instantiating. */
  setup(unitId: number, team: Team, cell: Cell) {
    this.unitId = unitId;
    this.team = team;
    this.cell = cell;
    this.name = `Unit ${unitId}`;
    this.transform.position = cellToWorld(cell);
    // Face the opposing side.
    this.transform.forward = team === 0 ? Vector3.forward : Vector3.back;
    if (this.body) this.body.sharedMaterial = teamMaterial(team);
  }

  /** Slides to a new cell. */
  moveTo(cell: Cell) {
    if (cell.x === this.cell.x && cell.y === this.cell.y) return;
    this.cell = cell;
    this.stopAllCoroutines();
    this.startCoroutine(this.slide(cellToWorld(cell)));
  }

  /** A quick lunge toward the target and back. */
  playAttack(target: Cell) {
    this.stopAllCoroutines();
    this.startCoroutine(this.lunge(cellToWorld(target)));
  }

  update() {
    if (!this.body) return;
    // Selected units bob so the selection is readable without extra UI.
    const height = this.selected ? 0.12 + Math.sin(Time.time * 6) * 0.08 : 0;
    this.body.transform.localPosition = new Vector3(0, 0.6 + height, 0);
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

  private *lunge(toward: Vector3): IEnumerator {
    const home = cellToWorld(this.cell);
    const reach = Vector3.lerp(home, toward, 0.45);
    yield* this.slide(reach);
    yield* this.slide(home);
  }
}

/**
 * Unity would keep this as a prefab asset. Here a prefab is a function that fills in a
 * new GameObject; scripts on it wake up after the function returns.
 */
export const UnitPrefab = new Prefab('Unit', (unit) => {
  // The visible body is a child, so it can bob without moving the unit itself.
  const body = new GameObject('Body');
  body.transform.setParent(unit.transform, false);
  body.transform.localPosition = new Vector3(0, 0.6, 0);
  body.transform.localScale = new Vector3(0.55, 0.55, 0.55);
  body.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Capsule);
  body.addComponent(MeshRenderer);

  // The collider is what makes the unit clickable.
  const collider = unit.addComponent(CapsuleCollider);
  collider.radius = 0.35;
  collider.height = 1.3;
  collider.center = new Vector3(0, 0.65, 0);
  unit.addComponent(UnitView);
});
