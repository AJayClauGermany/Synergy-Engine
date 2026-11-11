import type * as pc from 'playcanvas';
import type { GameObject } from './GameObject';

/**
 * Extension points that built-in components plug into at import time. This module has no
 * runtime imports on purpose: it lets `GameObject` stay unaware of Camera, MeshRenderer,
 * etc. without creating import cycles.
 */

/** Shapes available from `GameObject.createPrimitive`. Sizes match Unity's primitives. */
export enum PrimitiveType {
  /** Radius 0.5. */
  Sphere = 'sphere',
  /** Height 2, radius 0.5, along Y. */
  Capsule = 'capsule',
  /** Height 2, radius 0.5, along Y. */
  Cylinder = 'cylinder',
  /** 1 x 1 x 1. */
  Cube = 'cube',
  /** 10 x 10 on the XZ plane, facing up. */
  Plane = 'plane',
  /** 1 x 1 on the XY plane, facing back (+Z), i.e. toward a default camera. */
  Quad = 'quad',
}

type Adopter = (gameObject: GameObject, entity: pc.Entity) => void;

/** Called when a raw PlayCanvas entity (e.g. from a glTF file) gets wrapped in a GameObject. */
export const adopters: Adopter[] = [];

export const factories: {
  createPrimitive?: (type: PrimitiveType) => GameObject;
} = {};
