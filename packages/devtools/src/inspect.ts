import {
  Behaviour,
  Color,
  Component,
  type Engine,
  EngineObject,
  GameObject,
  type Scene,
  Transform,
  Vector2,
  Vector3,
} from '@synergy/engine';

/**
 * What the Hierarchy and Inspector panels read, kept apart from the panels so that it can
 * be tested on a headless engine. Everything here goes through the live objects: there is
 * no copy of the scene to fall out of date.
 */

/** One loaded scene and its root objects, in the order Unity's Hierarchy lists them. */
export interface SceneRoots {
  readonly scene: Scene;
  readonly active: boolean;
  readonly roots: readonly GameObject[];
}

/** The loaded scenes, active first as in Unity, then DontDestroyOnLoad when it holds anything. */
export function sceneRoots(engine: Engine): SceneRoots[] {
  const { scenes } = engine;
  return scenes
    .allScenes()
    .filter((scene) => scene !== scenes.persistent || scene.rootCount > 0)
    .map((scene) => ({ scene, active: scene === scenes.activeScene, roots: scene.getRootGameObjects() }));
}

/** The children of a GameObject, in order. */
export function childrenOf(gameObject: GameObject): GameObject[] {
  const children: GameObject[] = [];
  const { transform } = gameObject;
  for (let i = 0; i < transform.childCount; i++) children.push(transform.getChild(i).gameObject);
  return children;
}

/** How an Inspector row shows and edits a value. */
export type FieldKind = 'number' | 'boolean' | 'string' | 'vector2' | 'vector3' | 'color' | 'reference' | 'readonly';

export interface Field {
  readonly key: string;
  readonly kind: FieldKind;
  readonly value: unknown;
  /** The value as one line of text, for the read-only kinds. */
  readonly text: string;
}

function kindOf(value: unknown): FieldKind | null {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof Vector3) return 'vector3';
  if (value instanceof Vector2) return 'vector2';
  if (value instanceof Color) return 'color';
  if (value instanceof EngineObject) return 'reference';
  if (value === null || typeof value === 'object') return 'readonly';
  return null; // undefined, functions, symbols: not something the Inspector shows
}

function textOf(value: unknown): string {
  if (value === null) return 'None';
  if (value instanceof EngineObject) return value.isDestroyed ? 'Missing (destroyed)' : value.toString();
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Map || value instanceof Set) return `${value.constructor.name}(${value.size})`;
  if (typeof value === 'object') {
    const describe = (value as { toString?: () => string }).toString;
    if (typeof describe === 'function' && describe !== Object.prototype.toString) return describe.call(value);
    try {
      const json = JSON.stringify(value) ?? '';
      return json.length > 80 ? `${json.slice(0, 79)}…` : json;
    } catch {
      return '{…}';
    }
  }
  // Numbers and booleans; the other kinds never reach here.
  return JSON.stringify(value) ?? typeof value;
}

/**
 * The Inspector's rows for a script: its public fields (names not starting with `_`), the
 * same rule `instantiate` uses to decide what a clone copies. Built-in components keep
 * their state in PlayCanvas and are described by `summaryOf` instead.
 */
export function fieldsOf(component: Component): Field[] {
  if (component instanceof Transform) return [];
  const fields: Field[] = [];
  for (const [key, value] of Object.entries(component)) {
    if (key.startsWith('_') || key === 'gameObject') continue;
    const kind = kindOf(value);
    if (kind) fields.push({ key, kind, value, text: textOf(value) });
  }
  return fields;
}

/** A built-in component's own description (a Camera's field of view, a Light's colour), or `''`. */
export function summaryOf(component: Component): string {
  return component._summary?.() ?? '';
}

/** Whether the component has an enabled checkbox in Unity's Inspector. */
export function canDisable(component: Component): component is Behaviour {
  return component instanceof Behaviour;
}

/**
 * Sets a field from what was typed in the Inspector. Text is converted to the field's
 * current type; anything that does not convert is refused with an error that says why,
 * and the field keeps its value.
 */
export function setField(component: Component, key: string, input: string | boolean | readonly number[]): void {
  const target = component as unknown as Record<string, unknown>;
  const current = target[key];
  target[key] = convert(key, current, input);
}

function convert(key: string, current: unknown, input: string | boolean | readonly number[]): unknown {
  const numbers = (count: number): number[] => {
    const values = Array.isArray(input)
      ? input
      : String(input)
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
    if (values.length !== count || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`${key} needs ${count} numbers, got "${String(input)}".`);
    }
    return values;
  };
  if (typeof current === 'number') {
    const [value] = numbers(1);
    return value;
  }
  if (typeof current === 'boolean') return input === true || input === 'true';
  if (typeof current === 'string') return String(input);
  if (current instanceof Vector3) {
    const [x = 0, y = 0, z = 0] = numbers(3);
    return new Vector3(x, y, z);
  }
  if (current instanceof Vector2) {
    const [x = 0, y = 0] = numbers(2);
    return new Vector2(x, y);
  }
  if (current instanceof Color) {
    if (typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input)) {
      const channel = (offset: number) => Number.parseInt(input.slice(offset, offset + 2), 16) / 255;
      return new Color(channel(1), channel(3), channel(5), current.a);
    }
    const [r = 0, g = 0, b = 0, a = 1] = numbers(4);
    return new Color(r, g, b, a);
  }
  throw new Error(`${key} cannot be edited in the Inspector.`);
}

/** A colour as `#rrggbb`, for an `<input type="color">`. */
export function colorToHex(color: Color): string {
  const channel = (value: number) =>
    Math.round(Math.min(Math.max(value, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** The GameObject a reference field points at, so clicking it can select it. */
export function gameObjectOfReference(value: unknown): GameObject | null {
  if (value instanceof GameObject) return value.isDestroyed ? null : value;
  if (value instanceof Component) return value.isDestroyed ? null : value.gameObject;
  return null;
}

/** Every GameObject in the loaded scenes, depth first: what the Hierarchy's search looks through. */
export function allGameObjects(engine: Engine): GameObject[] {
  const out: GameObject[] = [];
  const visit = (gameObject: GameObject) => {
    out.push(gameObject);
    for (const child of childrenOf(gameObject)) visit(child);
  };
  for (const { roots } of sceneRoots(engine)) for (const root of roots) visit(root);
  return out;
}
