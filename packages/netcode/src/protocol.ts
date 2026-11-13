/** Unity's `NetworkManager.ServerClientId`: the host or server is always client 0. */
export const SERVER_CLIENT_ID = 0;

/** Bumped when the wire format changes, so mismatched builds refuse to connect. */
export const PROTOCOL_VERSION = 1;

export type Vec3 = [x: number, y: number, z: number];
export type Quat = [x: number, y: number, z: number, w: number];

/** Everything a client needs to create its copy of a spawned object. */
export interface SpawnData {
  /** NetworkObjectId. */
  o: number;
  /** Prefab name. */
  p: string;
  /** Owner client id. */
  w: number;
  /** Is the owner's player object. */
  pl: boolean;
  /** Survives its owner leaving. */
  k: boolean;
  pos: Vec3;
  rot: Quat;
  sc: Vec3;
  /** Dies with the scene it is in when the server loads another (see `NetworkSceneManager`). */
  ds?: 1;
  /** What the object is made of on the server, to compare with the client's own copy: see `layoutOf`. */
  sig: string;
  /** Full variable state the receiving client may read: `[behaviour, name, state]`. */
  vars: [behaviour: number, name: string, state: unknown][];
}

/** One changed variable: `[object, behaviour, name, data, full?]`. `full` marks a complete state rather than a delta. */
export type VarUpdate = [object: number, behaviour: number, name: string, data: unknown, full?: 1];

/** A scene the server has loaded for everyone, and the number of the load that did it. */
export interface SceneRef {
  n: string;
  e: number;
}

/** Client to server. */
export type ClientMessage =
  | { t: 'connect'; proto: number; cfg: string; ver?: string; payload?: unknown }
  | { t: 'sceneLoaded'; e: number }
  | { t: 'vars'; u: VarUpdate[] }
  | { t: 'rpc'; o: number; b: number; n: string; ids?: number[]; a: unknown[] }
  | { t: 'msg'; n: string; d: unknown };

/** Server to client. */
export type ServerMessage =
  | { t: 'approved'; id: number; tick: number; rate: number; objs: SpawnData[]; scene?: SceneRef }
  | { t: 'scene'; n: string; e: number }
  | { t: 'sceneDone'; n: string; ok: number[]; late: number[] }
  | { t: 'disconnect'; reason: string }
  | { t: 'spawn'; obj: SpawnData }
  | { t: 'despawn'; o: number }
  | { t: 'owner'; o: number; w: number }
  /** `mid`: sent between ticks (before an RPC, a despawn), so it does not say when the tick began. */
  | { t: 'sync'; tick: number; u: VarUpdate[]; mid?: true }
  | { t: 'rpc'; o: number; b: number; n: string; a: unknown[]; from: number }
  | { t: 'msg'; n: string; d: unknown; from: number };
