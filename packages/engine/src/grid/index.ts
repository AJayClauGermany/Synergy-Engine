// Grid maths with no engine dependency: layouts (rectangle, hexagon), hex helpers and
// pathfinding. Import from '@synergy/engine/grid' in game rules and server code; the
// `Grid` and `Tilemap` components in '@synergy/engine' are built on the same functions.
export { Vector3Int, Vector2Int, BoundsInt, cellKey, type CellLike } from '../math/Vector3Int';
export { Random } from '../math/Random';
export {
  CellLayout,
  CellSwizzle,
  type GridShape,
  defaultGridShape,
  hexCellSize,
  swizzle,
  inverseSwizzle,
  planeNormal,
  cellToLocal,
  cellCenterToLocal,
  localToCell,
  cellCorners,
} from './layout';
export { Hex, Square } from './hex';
export { findPath, findReachable, Reachable, type PathfindingOptions, type PathResult } from './pathfinding';
