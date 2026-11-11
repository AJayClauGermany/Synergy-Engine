import { type CellLike, cellKey, Vector3Int } from '../math/Vector3Int';

export interface PathfindingOptions {
  /** The cells one step away from `cell`, e.g. `Hex.neighbors` or `Square.neighbors4`. Filter out-of-bounds cells here or in `cost`. */
  neighbors: (cell: Vector3Int) => Iterable<CellLike>;
  /**
   * Cost of stepping from `from` into `to`. Return `Infinity` for a cell that cannot be
   * entered. Defaults to 1 for every step. Costs must not be negative.
   */
  cost?: (from: Vector3Int, to: Vector3Int) => number;
  /**
   * `findPath` only: a guess of the remaining cost that never overestimates, such as
   * `Hex.distance` times the cheapest step. It makes the search faster, not different.
   */
  heuristic?: (cell: Vector3Int, goal: Vector3Int) => number;
  /** Ignore routes that cost more than this. */
  maxCost?: number;
}

export interface PathResult {
  /** Every cell on the route, starting with `start` and ending with `goal`. */
  path: Vector3Int[];
  cost: number;
}

interface Node {
  cell: Vector3Int;
  cost: number;
  previous: Node | null;
}

/** A binary min-heap. Ties are broken by insertion order, which keeps searches deterministic. */
class Queue {
  private items: { node: Node; priority: number; order: number }[] = [];
  private counter = 0;

  get size(): number {
    return this.items.length;
  }

  push(node: Node, priority: number): void {
    const items = this.items;
    items.push({ node, priority, order: this.counter++ });
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(index, parent)) break;
      [items[index], items[parent]] = [items[parent] as (typeof items)[0], items[index] as (typeof items)[0]];
      index = parent;
    }
  }

  pop(): Node | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.before(left, smallest)) smallest = left;
        if (right < items.length && this.before(right, smallest)) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest] as (typeof items)[0], items[index] as (typeof items)[0]];
        index = smallest;
      }
    }
    return top?.node;
  }

  private before(a: number, b: number): boolean {
    const x = this.items[a] as (typeof this.items)[0];
    const y = this.items[b] as (typeof this.items)[0];
    return x.priority < y.priority || (x.priority === y.priority && x.order < y.order);
  }
}

function trace(node: Node): Vector3Int[] {
  const path: Vector3Int[] = [];
  for (let current: Node | null = node; current; current = current.previous) path.push(current.cell);
  return path.reverse();
}

function search(
  start: Vector3Int,
  options: PathfindingOptions,
  goal: Vector3Int | null,
): { best: Map<string, Node>; found: Node | null } {
  const stepCost = options.cost ?? (() => 1);
  const estimate = goal && options.heuristic ? options.heuristic : null;
  const limit = options.maxCost ?? Number.POSITIVE_INFINITY;
  const best = new Map<string, Node>();
  const settled = new Set<string>();
  const queue = new Queue();
  const first: Node = { cell: start, cost: 0, previous: null };
  best.set(start.key, first);
  queue.push(first, 0);

  while (queue.size > 0) {
    const node = queue.pop() as Node;
    const key = node.cell.key;
    if (settled.has(key)) continue;
    settled.add(key);
    if (goal && node.cell.equals(goal)) return { best, found: node };

    for (const next of options.neighbors(node.cell)) {
      const cell = Vector3Int.from(next);
      const nextKey = cellKey(cell);
      if (settled.has(nextKey)) continue;
      const step = stepCost(node.cell, cell);
      if (!(step >= 0) || !Number.isFinite(step)) continue;
      const cost = node.cost + step;
      if (cost > limit) continue;
      const known = best.get(nextKey);
      if (known && known.cost <= cost) continue;
      const candidate: Node = { cell, cost, previous: node };
      best.set(nextKey, candidate);
      queue.push(candidate, cost + (estimate && goal ? estimate(cell, goal) : 0));
    }
  }
  return { best, found: null };
}

/**
 * The cheapest route from `start` to `goal` (A*, or Dijkstra without a heuristic), or
 * `null` when there is none. Works on any grid: you supply the neighbours and the costs.
 *
 *   const route = findPath(unit, target, {
 *     neighbors: (cell) => Hex.neighbors(cell).filter(inBounds),
 *     cost: (_from, to) => (isBlocked(to) ? Infinity : terrainCost(to)),
 *     heuristic: Hex.distance,
 *   });
 */
export function findPath(start: CellLike, goal: CellLike, options: PathfindingOptions): PathResult | null {
  const { found } = search(Vector3Int.from(start), options, Vector3Int.from(goal));
  return found ? { path: trace(found), cost: found.cost } : null;
}

/** The result of `findReachable`: everywhere that can be reached, and how. */
export class Reachable {
  /** @internal */
  constructor(private readonly nodes: Map<string, Node>) {}

  /** Reachable cells with their cost, cheapest first. The start cell (cost 0) is not included. */
  get cells(): { cell: Vector3Int; cost: number }[] {
    return [...this.nodes.values()]
      .filter((node) => node.previous !== null)
      .map(({ cell, cost }) => ({ cell, cost }))
      .sort((a, b) => a.cost - b.cost);
  }

  has(cell: CellLike): boolean {
    return this.nodes.get(cellKey(cell))?.previous != null;
  }

  /** Cost of the cheapest route to `cell`, or `null` if it cannot be reached. */
  costTo(cell: CellLike): number | null {
    return this.nodes.get(cellKey(cell))?.cost ?? null;
  }

  /** The cheapest route to `cell`, from the start cell to `cell` inclusive, or `null`. */
  pathTo(cell: CellLike): Vector3Int[] | null {
    const node = this.nodes.get(cellKey(cell));
    return node ? trace(node) : null;
  }
}

/**
 * Everywhere that can be reached from `start` for at most `budget` total cost: a unit's
 * movement range. Use `pathTo(cell)` on the result to get the route for the move itself.
 */
export function findReachable(start: CellLike, budget: number, options: PathfindingOptions): Reachable {
  const { best } = search(Vector3Int.from(start), { ...options, maxCost: budget, heuristic: undefined }, null);
  return new Reachable(best);
}
