import type { Component } from './Component';
import { EngineObject } from './EngineObject';
import type { GameObject } from './GameObject';
import { currentEngine } from './runtime';
import { Transform } from './Transform';
import { typeNameOf } from './typeNames';

/** What `Debug.hierarchy()` prints. */
export interface HierarchyOptions {
  /** Print only this object and what is under it. Default: every loaded scene. */
  root?: GameObject;
  /** Show the public fields of scripts (what Unity's Inspector would show). Default true. */
  fields?: boolean;
  /** Levels of children to print below each root. Default: all of them. */
  depth?: number;
  /** Children printed per parent before the rest are counted instead. Default 20. */
  maxChildren?: number;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** One value as the Inspector would show it, or `null` for things that are not worth a line. */
function show(value: unknown, depth = 0): string | null {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return String(round(value));
    case 'boolean':
      return String(value);
    case 'string':
      return clip(JSON.stringify(value), 40);
    case 'object':
      break;
    default:
      return null; // undefined, functions, symbols
  }
  if (value instanceof EngineObject) return value.isDestroyed ? `${typeNameOf(value)} (destroyed)` : value.toString();
  if (Array.isArray(value)) {
    if (value.length > 6 || depth > 0) return `[${value.length} items]`;
    const items = value.map((item) => show(item, depth + 1));
    return items.includes(null) ? `[${value.length} items]` : `[${items.join(', ')}]`;
  }
  if (value instanceof Map || value instanceof Set) return `${value.constructor.name}(${value.size})`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    if (depth > 0) return '{…}';
    const entries = Object.entries(value).flatMap(([key, item]) => {
      const text = show(item, depth + 1);
      return text === null ? [] : [`${key}: ${text}`];
    });
    return clip(`{${entries.join(', ')}}`, 60);
  }
  // Vectors and quaternions, without the padding their own toString() adds.
  const { x, y, z, w } = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  if (typeof x === 'number' && typeof y === 'number') {
    const rest = [z, w].filter((part): part is number => typeof part === 'number');
    return `(${[x, y, ...rest].map(round).join(', ')})`;
  }
  // Colours and other classes that know how to describe themselves. Anything else
  // (materials, PlayCanvas objects) would only be noise.
  // (An object made with Object.create(null) has no toString at all.)
  const describe = (value as { toString?: () => string }).toString;
  return typeof describe !== 'function' || describe === Object.prototype.toString
    ? null
    : clip(describe.call(value), 60);
}

function fieldsOf(component: Component): string {
  // Built-in components keep their state in PlayCanvas and describe it themselves. For
  // scripts, the public fields are the Inspector's values (the same rule `instantiate`
  // uses to decide what a clone copies).
  const summary = component._summary?.();
  if (summary !== undefined) return summary;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(component)) {
    if (key.startsWith('_') || key === 'gameObject') continue;
    const text = show(value);
    if (text !== null) parts.push(`${key}=${text}`);
  }
  return parts.join(', ');
}

function describe(
  gameObject: GameObject,
  indent: string,
  levels: number,
  options: Required<Omit<HierarchyOptions, 'root'>>,
  out: string[],
): void {
  const transform = gameObject.transform;
  const components = gameObject._components.filter((component) => !(component instanceof Transform));
  let line = `${indent}${gameObject.name}`;
  if (components.length > 0) line += ` <${components.map(typeNameOf).join(', ')}>`;
  if (!gameObject.activeSelf) line += ' (inactive)';
  if (gameObject.tag !== 'Untagged') line += ` tag=${gameObject.tag}`;
  if (gameObject.layer !== 0) line += ` layer=${gameObject.layer}`;
  const { position, eulerAngles, lossyScale } = transform;
  if (position.sqrMagnitude > 1e-10) line += ` at ${show(position)}`;
  if (eulerAngles.sqrMagnitude > 1e-6) line += ` rot ${show(eulerAngles)}`;
  if (Math.abs(lossyScale.x - 1) + Math.abs(lossyScale.y - 1) + Math.abs(lossyScale.z - 1) > 1e-4)
    line += ` scale ${show(lossyScale)}`;
  out.push(line);

  if (options.fields) {
    for (const component of components) {
      const fields = fieldsOf(component);
      const disabled = 'enabled' in component && component.enabled === false ? ' (disabled)' : '';
      if (fields || disabled)
        out.push(`${indent}  | ${typeNameOf(component)}${disabled}${fields ? `: ${fields}` : ''}`);
    }
  }

  const children: GameObject[] = [];
  for (let i = 0; i < transform.childCount; i++) children.push(transform.getChild(i).gameObject);
  if (children.length === 0) return;
  if (levels <= 0) {
    out.push(`${indent}  … ${children.length} ${children.length === 1 ? 'child' : 'children'}`);
    return;
  }
  for (const child of children.slice(0, options.maxChildren)) describe(child, `${indent}  `, levels - 1, options, out);
  const rest = children.slice(options.maxChildren);
  if (rest.length > 0) {
    // A map with a thousand spawned trees should cost one line, not a thousand.
    const counts = new Map<string, number>();
    for (const child of rest) counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
    out.push(`${indent}  … ${rest.length} more: ${clip(names.join(', '), 100)}`);
  }
}

/** @internal The text behind `Debug.hierarchy()`. */
export function describeHierarchy(options: HierarchyOptions = {}): string {
  const settings = {
    fields: options.fields ?? true,
    depth: options.depth ?? Number.POSITIVE_INFINITY,
    maxChildren: options.maxChildren ?? 20,
  };
  const out: string[] = [];
  if (options.root) {
    describe(options.root, '', settings.depth, settings, out);
    return out.join('\n');
  }
  const scenes = currentEngine().scenes;
  for (const scene of scenes.allScenes()) {
    const roots = scene.getRootGameObjects();
    // The DontDestroyOnLoad scene is always there; only mention it when it holds something.
    if (scene === scenes.persistent && roots.length === 0) continue;
    const active = scene === scenes.activeScene ? ' (active)' : '';
    out.push(`Scene "${scene.name}"${active}`);
    if (roots.length === 0) out.push('  (empty)');
    for (const root of roots.slice(0, settings.maxChildren)) describe(root, '  ', settings.depth, settings, out);
    if (roots.length > settings.maxChildren) out.push(`  … ${roots.length - settings.maxChildren} more root objects`);
  }
  return out.join('\n');
}
