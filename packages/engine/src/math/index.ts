// Pure TypeScript math. Nothing in here imports PlayCanvas or touches the DOM, so it is
// safe to use from game rules, tests, and server-side code (e.g. Convex functions).
export { Mathf } from './Mathf';
export { Vector2 } from './Vector2';
export { Vector3, type Vector3Like } from './Vector3';
export { Quaternion, type QuaternionLike } from './Quaternion';
export { Color, type ColorLike } from './Color';
export { Ray, Plane, Bounds, intersectRayBox, intersectRaySphere } from './geometry';
export { Vector3Int, Vector2Int, BoundsInt, cellKey, type CellLike } from './Vector3Int';
export { Random } from './Random';
