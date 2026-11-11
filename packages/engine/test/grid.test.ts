import { describe, expect, test } from 'bun:test';
import {
  BoundsInt,
  CellLayout,
  CellSwizzle,
  cellCenterToLocal,
  cellCorners,
  cellToLocal,
  defaultGridShape,
  findPath,
  findReachable,
  type GridShape,
  Hex,
  hexCellSize,
  inverseSwizzle,
  localToCell,
  planeNormal,
  Random,
  Square,
  swizzle,
  Vector3Int,
} from '../src/grid';
import { Vector3 } from '../src/math';

const shape = (overrides: Partial<GridShape>): GridShape => ({ ...defaultGridShape(), ...overrides });
const ALL_SWIZZLES = Object.values(CellSwizzle);

describe('Vector3Int and BoundsInt', () => {
  test('integer vectors compare exactly and accept plain cells', () => {
    const a = new Vector3Int(2, 3, 0);
    expect(a.equals({ x: 2, y: 3 })).toBe(true);
    expect(a.add({ x: 1, y: -1 }).equals(new Vector3Int(3, 2, 0))).toBe(true);
    expect(a.key).toBe('2,3,0');
    expect(Vector3Int.floorToInt(new Vector3(1.9, -0.1, 0)).equals({ x: 1, y: -1 })).toBe(true);
  });

  test('bounds use an exclusive maximum, as in Unity', () => {
    const bounds = BoundsInt.fromMinMax({ x: 0, y: 0, z: 0 }, { x: 3, y: 2, z: 1 });
    expect(bounds.contains({ x: 2, y: 1 })).toBe(true);
    expect(bounds.contains({ x: 3, y: 1 })).toBe(false);
    expect([...bounds.allPositionsWithin()].length).toBe(6);
  });
});

describe('rectangle layout', () => {
  test('the default grid is the XY plane with unit cells', () => {
    const grid = defaultGridShape();
    expect(cellToLocal(grid, { x: 2, y: 3 }).equals(new Vector3(2, 3, 0))).toBe(true);
    expect(cellCenterToLocal(grid, { x: 2, y: 3 }).equals(new Vector3(2.5, 3.5, 0))).toBe(true);
    expect(localToCell(grid, new Vector3(2.9, 3.1, 0)).equals({ x: 2, y: 3 })).toBe(true);
    expect(localToCell(grid, new Vector3(-0.1, -0.1, 0)).equals({ x: -1, y: -1 })).toBe(true);
    expect(planeNormal(grid).equals(Vector3.back)).toBe(true);
  });

  test('a ground grid (XZY) runs right and forward, with layers stacking up', () => {
    const ground = shape({ cellSwizzle: CellSwizzle.XZY, cellSize: new Vector3(2, 2, 1) });
    // One cell right, one cell forward: +X and -Z (forward) in this right-handed world.
    expect(cellToLocal(ground, { x: 1, y: 1 }).equals(new Vector3(2, 0, -2))).toBe(true);
    expect(cellToLocal(ground, { x: 0, y: 0, z: 3 }).equals(new Vector3(0, 3, 0))).toBe(true);
    expect(planeNormal(ground).equals(Vector3.up)).toBe(true);
    expect(localToCell(ground, new Vector3(3, 0, -3)).equals({ x: 1, y: 1 })).toBe(true);
  });

  test('cell size and gap', () => {
    const grid = shape({ cellSize: new Vector3(1, 1, 1), cellGap: new Vector3(0.5, 0, 0) });
    expect(cellToLocal(grid, { x: 2, y: 0 }).x).toBeCloseTo(3);
    const corners = cellCorners(grid, { x: 2, y: 0 });
    expect(corners.length).toBe(4);
    expect(corners[0]?.x).toBeCloseTo(3);
    expect(corners[1]?.x).toBeCloseTo(4); // the tile itself is still 1 wide
  });
});

describe('hexagon layout', () => {
  const hex = shape({ cellLayout: CellLayout.Hexagon, cellSize: hexCellSize(1) });

  test('odd rows are shifted half a cell to the right, rows are 3/4 of a cell apart', () => {
    expect(cellToLocal(hex, { x: 0, y: 0 }).equals(Vector3.zero)).toBe(true);
    expect(cellToLocal(hex, { x: 1, y: 0 }).x).toBeCloseTo(1);
    const odd = cellToLocal(hex, { x: 0, y: 1 });
    expect(odd.x).toBeCloseTo(0.5);
    expect(odd.y).toBeCloseTo(hex.cellSize.y * 0.75);
    expect(cellToLocal(hex, { x: 0, y: -1 }).x).toBeCloseTo(0.5);
    // For hexagons the cell position is already its centre.
    expect(cellCenterToLocal(hex, { x: 3, y: 2 }).equals(cellToLocal(hex, { x: 3, y: 2 }))).toBe(true);
  });

  test('regular hexagons: every neighbour centre is exactly one width away', () => {
    const centre = cellCenterToLocal(hex, { x: 4, y: 3 });
    for (const neighbour of Hex.neighbors({ x: 4, y: 3 })) {
      expect(Vector3.distance(centre, cellCenterToLocal(hex, neighbour))).toBeCloseTo(1, 5);
    }
    expect(cellCorners(hex, { x: 0, y: 0 }).length).toBe(6);
  });

  test('every point of a hexagon maps back to its cell', () => {
    for (const cell of [new Vector3Int(0, 0), new Vector3Int(3, 2), new Vector3Int(-2, -3), new Vector3Int(5, 7)]) {
      const centre = cellCenterToLocal(hex, cell);
      expect(localToCell(hex, centre).equals(cell)).toBe(true);
      for (const corner of cellCorners(hex, cell)) {
        // Just inside each corner still belongs to the cell.
        expect(localToCell(hex, Vector3.lerp(centre, corner, 0.9)).equals(cell)).toBe(true);
      }
    }
  });
});

describe('swizzles', () => {
  test('inverseSwizzle undoes swizzle for every order', () => {
    const v = new Vector3(1, 2, 3);
    for (const order of ALL_SWIZZLES) {
      expect(inverseSwizzle(order, swizzle(order, v)).equals(v)).toBe(true);
    }
  });

  test('cells round-trip through local space in every layout and orientation', () => {
    for (const cellLayout of Object.values(CellLayout)) {
      for (const cellSwizzle of ALL_SWIZZLES) {
        const grid = shape({ cellLayout, cellSwizzle, cellSize: new Vector3(1.2, 0.9, 0.5) });
        for (const cell of [new Vector3Int(0, 0, 0), new Vector3Int(4, -3, 0), new Vector3Int(-5, 6, 2)]) {
          expect(localToCell(grid, cellCenterToLocal(grid, cell)).equals(cell)).toBe(true);
        }
      }
    }
  });
});

describe('Hex helpers', () => {
  test('neighbours, distance and axial conversion agree', () => {
    for (const cell of [new Vector3Int(0, 0), new Vector3Int(2, 3), new Vector3Int(-1, -2)]) {
      const neighbours = Hex.neighbors(cell);
      expect(new Set(neighbours.map((n) => n.key)).size).toBe(6);
      for (const n of neighbours) expect(Hex.distance(cell, n)).toBe(1);
      const { q, r } = Hex.toAxial(cell);
      expect(Hex.fromAxial(q, r).equals(cell)).toBe(true);
    }
    // Even row: the up-right neighbour keeps its x. Odd row: it gains one.
    expect(Hex.neighbors({ x: 2, y: 2 }).some((n) => n.equals({ x: 2, y: 3 }))).toBe(true);
    expect(Hex.neighbors({ x: 2, y: 2 }).some((n) => n.equals({ x: 3, y: 3 }))).toBe(false);
    expect(Hex.neighbors({ x: 2, y: 3 }).some((n) => n.equals({ x: 3, y: 4 }))).toBe(true);
    expect(Hex.distance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
    expect(Hex.distance({ x: 0, y: 0 }, { x: 0, y: 4 })).toBe(4);
  });

  test('range, ring and line', () => {
    const centre = { x: 3, y: 3 };
    expect(Hex.range(centre, 0).length).toBe(1);
    expect(Hex.range(centre, 2).length).toBe(19);
    expect(Hex.ring(centre, 2).length).toBe(12);
    for (const cell of Hex.ring(centre, 2)) expect(Hex.distance(centre, cell)).toBe(2);
    for (const cell of Hex.range(centre, 2)) expect(Hex.distance(centre, cell)).toBeLessThanOrEqual(2);

    const line = Hex.line({ x: 0, y: 0 }, { x: 4, y: 3 });
    expect(line[0]?.equals({ x: 0, y: 0 })).toBe(true);
    expect(line.at(-1)?.equals({ x: 4, y: 3 })).toBe(true);
    expect(line.length).toBe(Hex.distance({ x: 0, y: 0 }, { x: 4, y: 3 }) + 1);
    for (let i = 1; i < line.length; i++) {
      expect(Hex.distance(line[i - 1] as Vector3Int, line[i] as Vector3Int)).toBe(1);
    }
  });

  test('square helpers', () => {
    expect(Square.neighbors4({ x: 0, y: 0 }).length).toBe(4);
    expect(Square.neighbors8({ x: 0, y: 0 }).length).toBe(8);
    expect(Square.manhattan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
    expect(Square.chebyshev({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4);
  });
});

describe('pathfinding', () => {
  const inBounds = (cell: { x: number; y: number }) => cell.x >= 0 && cell.y >= 0 && cell.x < 6 && cell.y < 6;
  const neighbors = (cell: Vector3Int) => Square.neighbors4(cell).filter(inBounds);

  test('finds the shortest route and reports its cost', () => {
    const result = findPath({ x: 0, y: 0 }, { x: 3, y: 2 }, { neighbors, heuristic: Square.manhattan });
    expect(result?.cost).toBe(5);
    expect(result?.path.length).toBe(6);
    expect(result?.path[0]?.equals({ x: 0, y: 0 })).toBe(true);
    expect(result?.path.at(-1)?.equals({ x: 3, y: 2 })).toBe(true);
  });

  test('routes around walls, prefers cheap terrain, and gives up when sealed in', () => {
    // A wall across x = 2 with one gap at the top.
    const wall = (cell: Vector3Int) => cell.x === 2 && cell.y < 5;
    const around = findPath(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { neighbors, cost: (_from, to) => (wall(to) ? Infinity : 1) },
    );
    expect(around?.cost).toBe(14);
    expect(around?.path.some((cell) => cell.equals({ x: 2, y: 5 }))).toBe(true);

    // A swamp on row 0 costs 5 per step: going round through row 1 is cheaper.
    const swamp = (cell: Vector3Int) => (cell.y === 0 && cell.x > 0 && cell.x < 5 ? 5 : 1);
    const cheap = findPath({ x: 0, y: 0 }, { x: 5, y: 0 }, { neighbors, cost: (_from, to) => swamp(to) });
    expect(cheap?.cost).toBe(7);
    expect(cheap?.path.some((cell) => cell.y === 1)).toBe(true);

    const sealed = findPath(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { neighbors, cost: (_f, to) => (to.x === 2 ? Infinity : 1) },
    );
    expect(sealed).toBeNull();
    expect(findPath({ x: 0, y: 0 }, { x: 5, y: 5 }, { neighbors, maxCost: 4 })).toBeNull();
    expect(findPath({ x: 1, y: 1 }, { x: 1, y: 1 }, { neighbors })?.path.length).toBe(1);
  });

  test('findReachable gives a movement range with routes', () => {
    const forest = (cell: Vector3Int) => (cell.x === 1 ? 2 : 1);
    const reach = findReachable({ x: 0, y: 0 }, 3, { neighbors, cost: (_from, to) => forest(to) });
    expect(reach.has({ x: 0, y: 3 })).toBe(true);
    expect(reach.has({ x: 0, y: 4 })).toBe(false);
    // Entering the forest column costs 2, so (2, 0) costs 3 and (2, 1) is out of range.
    expect(reach.costTo({ x: 1, y: 0 })).toBe(2);
    expect(reach.costTo({ x: 2, y: 0 })).toBe(3);
    expect(reach.has({ x: 2, y: 1 })).toBe(false);
    expect(reach.has({ x: 0, y: 0 })).toBe(false); // the start is not a destination
    expect(reach.pathTo({ x: 2, y: 0 })?.map((cell) => cell.key)).toEqual(['0,0,0', '1,0,0', '2,0,0']);
    expect(reach.pathTo({ x: 5, y: 5 })).toBeNull();
    expect(reach.cells[0]?.cost).toBe(1);
  });

  test('hex pathfinding is deterministic', () => {
    const hexNeighbors = (cell: Vector3Int) => Hex.neighbors(cell).filter(inBounds);
    const options = { neighbors: hexNeighbors, heuristic: Hex.distance };
    const first = findPath({ x: 0, y: 0 }, { x: 5, y: 4 }, options);
    const second = findPath({ x: 0, y: 0 }, { x: 5, y: 4 }, options);
    expect(first?.cost).toBe(Hex.distance({ x: 0, y: 0 }, { x: 5, y: 4 }));
    expect(first?.path.map((cell) => cell.key)).toEqual(second?.path.map((cell) => cell.key) as string[]);
  });
});

describe('Random', () => {
  test('the same seed gives the same sequence, and state can be carried forward', () => {
    const a = new Random(42);
    const b = new Random(42);
    const first = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(first);
    expect(new Random(43).next()).not.toBe(first[0] as number);

    const resumed = new Random(a.state);
    expect(resumed.next()).toBe(b.next());
  });

  test('ranges, picks and shuffles stay in bounds', () => {
    const random = new Random(7);
    for (let i = 0; i < 500; i++) {
      const f = random.range(2, 5);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThan(5);
      const n = random.rangeInt(0, 3);
      expect([0, 1, 2]).toContain(n);
    }
    const items = [1, 2, 3, 4, 5];
    expect(random.shuffle(items).toSorted((a, b) => a - b)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(items).toContain(random.pick(items));
    expect(() => random.pick([])).toThrow();
  });
});
