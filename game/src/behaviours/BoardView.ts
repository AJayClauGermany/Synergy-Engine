import {
  BoxCollider,
  Color,
  GameObject,
  Material,
  MeshRenderer,
  MonoBehaviour,
  PrimitiveType,
  Vector3,
} from '@synergy/engine';
import { BOARD_SIZE, type Cell } from '../rules/skirmish';

export type Highlight = 'move' | 'attack' | 'selected';

const HALF = (BOARD_SIZE - 1) / 2;

/** Board cell -> world position of its centre (on the ground). Blue's home row is nearest the camera. */
export function cellToWorld(cell: Cell): Vector3 {
  return new Vector3(cell.x - HALF, 0, HALF - cell.y);
}

/** World position -> the board cell containing it, or `null` when off the board. */
export function worldToCell(point: Vector3): Cell | null {
  const x = Math.round(point.x + HALF);
  const y = Math.round(HALF - point.z);
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE ? { x, y } : null;
}

/** Draws the board and shows which cells are highlighted. It knows nothing about the rules. */
export class BoardView extends MonoBehaviour {
  private readonly tiles: MeshRenderer[] = [];
  private base: [Material, Material] | null = null;
  private highlights: Record<Highlight, Material> | null = null;

  awake() {
    const material = (hex: string) => {
      const created = new Material();
      created.color = Color.fromHex(hex);
      created.smoothness = 0.15;
      return created;
    };
    this.base = [material('#5c7a55'), material('#6f9166')];
    this.highlights = { move: material('#5aa7e8'), attack: material('#e8695a'), selected: material('#f2d264') };

    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const tile = GameObject.createPrimitive(PrimitiveType.Cube);
        tile.name = `Tile ${x},${y}`;
        tile.transform.parent = this.transform;
        tile.transform.localPosition = cellToWorld({ x, y }).add(new Vector3(0, -0.1, 0));
        tile.transform.localScale = new Vector3(0.96, 0.2, 0.96);
        // One collider for the whole board (below) is cheaper to raycast than 64 small ones.
        const collider = tile.getComponent(BoxCollider);
        if (collider) collider.enabled = false;
        const renderer = tile.getComponent(MeshRenderer) as MeshRenderer;
        renderer.castShadows = false;
        this.tiles.push(renderer);
      }
    }
    const collider = this.gameObject.addComponent(BoxCollider);
    collider.size = new Vector3(BOARD_SIZE, 0.2, BOARD_SIZE);
    collider.center = new Vector3(0, -0.1, 0);
    this.clearHighlights();
  }

  clearHighlights() {
    if (!this.base) return;
    this.tiles.forEach((tile, index) => {
      const x = index % BOARD_SIZE;
      const y = Math.floor(index / BOARD_SIZE);
      tile.sharedMaterial = this.base?.[(x + y) % 2] as Material;
    });
  }

  highlight(cells: readonly Cell[], kind: Highlight) {
    if (!this.highlights) return;
    for (const cell of cells) {
      const tile = this.tiles[cell.y * BOARD_SIZE + cell.x];
      if (tile) tile.sharedMaterial = this.highlights[kind];
    }
  }
}
