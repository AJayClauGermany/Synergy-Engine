// Synergy Engine: a Unity-style API for TypeScript, running on PlayCanvas.
// Import everything from '@synergy/engine'.

export * from './math';

export { Engine, type EngineOptions } from './core/Engine';
export { EngineObject, isAlive } from './core/EngineObject';
export { GameObject, gameObjectOf } from './core/GameObject';
export { Component, Behaviour, type ComponentClass, type ConcreteComponentClass } from './core/Component';
export { MonoBehaviour } from './core/MonoBehaviour';
export { Transform, Space } from './core/Transform';
export { PrimitiveType } from './core/hooks';
export {
  Coroutine,
  YieldInstruction,
  CustomYieldInstruction,
  WaitForSeconds,
  WaitForSecondsRealtime,
  WaitForEndOfFrame,
  WaitForFixedUpdate,
  WaitUntil,
  WaitWhile,
  type IEnumerator,
  type Yieldable,
} from './core/Coroutine';
export { Time } from './core/Time';
export { Input, KeyCode, Screen } from './core/Input';
export { Debug } from './core/Debug';
export { RenderSettings } from './core/RenderSettings';
export { UnityEvent, Observable } from './core/events';
export { Tween, Ease, LoopType, type EaseFunction } from './core/Tween';
export { Scene, SceneManager, LoadSceneMode, type SceneBuilder, type SceneDefinition } from './core/SceneManager';
export {
  Prefab,
  instantiate,
  destroy,
  destroyImmediate,
  dontDestroyOnLoad,
  findObjectOfType,
  findObjectsOfType,
} from './core/Object';

export { Camera, CameraClearFlags } from './components/Camera';
export { Light, LightType, LightShadows } from './components/Light';
export { Mesh, Material, MeshFilter, MeshRenderer, type Texture } from './components/rendering';
export { Sprite, type SpriteRect, type SpriteOptions } from './components/Sprite';
export { SpriteRenderer } from './components/SpriteRenderer';
import './components/primitives';

export { Collider, BoxCollider, SphereCollider, CapsuleCollider, type RaycastHit } from './physics/Collider';
export { Physics, LayerMask } from './physics/Physics';

export { Assets, Model } from './assets/Assets';

export { Canvas, CanvasScaler, RenderMode, ScaleMode } from './ui/Canvas';
export { RectTransform, type Rect } from './ui/RectTransform';
export { Image } from './ui/Image';

export {
  CellLayout,
  CellSwizzle,
  type GridShape,
  hexCellSize,
  Hex,
  Square,
  findPath,
  findReachable,
  Reachable,
  type PathfindingOptions,
  type PathResult,
} from './grid';
export { Grid, type GridHit } from './tilemap/Grid';
export { Tilemap, TileBase, Tile, type TileData } from './tilemap/Tilemap';
export { TilemapRenderer } from './tilemap/TilemapRenderer';
