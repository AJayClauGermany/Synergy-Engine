import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OBJECT_SOURCES, SOURCE_ATTRIBUTE, stampJsxSource, stampObjectSource } from './jsxSource';

/** The transform that tells the feedback tool where each JSX element was written. */
describe('stampJsxSource', () => {
  test('writes file:line:column on elements and components, after their other attributes', () => {
    const code = [
      'export const Menu = () => (',
      '  <div class="menu">',
      '    <Title text="Hi" />',
      '  </div>',
      ');',
    ].join('\n');
    expect(stampJsxSource(code, 'game/src/ui/Menu.tsx')).toBe(
      [
        'export const Menu = () => (',
        '  <div class="menu" data-source="game/src/ui/Menu.tsx:2:3">',
        '    <Title text="Hi" data-source="game/src/ui/Menu.tsx:3:5" />',
        '  </div>',
        ');',
      ].join('\n'),
    );
  });

  test('a spread cannot replace it, and the result is still valid JSX', () => {
    const out = stampJsxSource('const a = <button {...rest}>x</button>;', 'a.tsx');
    expect(out).toBe('const a = <button {...rest} data-source="a.tsx:1:11">x</button>;');
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(out)).not.toThrow();
  });

  test('fragments are left alone, and so is an element that already says where it is from', () => {
    const code = 'const a = <><Fragment key="k"><p data-source="x">y</p></Fragment></>;';
    expect(stampJsxSource(code, 'a.tsx')).toBe(code);
  });

  test('generics and comparisons are not mistaken for elements; characters outside ASCII keep the count right', () => {
    const code = "const tick = '✓😀'; const f = <T,>(v: T) => (1 < 2 ? <b>{tick}</b> : null);";
    const out = stampJsxSource(code, 'a.tsx');
    expect(out).toContain(`<b ${SOURCE_ATTRIBUTE}="a.tsx:1:${code.indexOf('<b>') + 1}">`);
    expect(out.match(/data-source/g)?.length).toBe(1);
  });

  test('code that does not parse comes back unchanged, for the bundler to report', () => {
    const broken = 'const a = <div>;';
    expect(stampJsxSource(broken, 'a.tsx')).toBe(broken);
  });
});

/** The transform that tells the feedback tool which line of the game made a GameObject. */
describe('stampObjectSource', () => {
  // Stand-ins for the engine, written into the file under test so it runs by itself.
  const ENGINE = [
    'class GameObject { static createPrimitive() { return new this(); } }',
    'const instantiate = (original: object) => ({ gameObject: original });',
  ].join(' ');
  let folder: string;
  let files = 0;
  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'synergy-object-source-'));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });
  /** Runs the stamped code as a module and returns what it exports as `result`. */
  const run = async (code: string): Promise<Record<string, unknown>> => {
    const file = path.join(folder, `case-${files++}.ts`);
    await Bun.write(file, stampObjectSource(`${ENGINE}\n${code}`, 'game/src/scenes/Map.ts'));
    return ((await import(file)) as { result: Record<string, unknown> }).result;
  };
  const sources = () => (globalThis as Record<string, unknown>)[OBJECT_SOURCES] as WeakMap<object, string>;

  test('remembers the file, line and column of each way of making a GameObject, and changes no value', async () => {
    const made = await run(
      [
        'const board = new GameObject();',
        'const crate = GameObject.createPrimitive();',
        'export const result = { board, crate };',
      ].join('\n'),
    );
    expect(sources().get(made.board as object)).toBe('game/src/scenes/Map.ts:2:15');
    expect(sources().get(made.crate as object)).toBe('game/src/scenes/Map.ts:3:15');
  });

  test('what instantiate returns is remembered by its GameObject, and a nested call keeps both places', async () => {
    const made = await run('export const result = { copy: instantiate(new GameObject()) };');
    const copy = made.copy as { gameObject: object };
    // The inner object was made first and then named again by the outer call, which is where it entered the scene.
    expect(sources().get(copy.gameObject)).toBe('game/src/scenes/Map.ts:2:31');
  });

  test('no line moves, so an error still points at the line that threw', () => {
    const code = 'const a = 1;\nconst b = new GameObject();\nconst c = 3;';
    expect(
      stampObjectSource(code, 'a.ts')
        .split('\n')
        .slice(0, 3)
        .map((line) => line.slice(0, 9)),
    ).toEqual(['const a =', 'const b =', 'const c =']);
  });

  test('a file that makes nothing, or does not parse, comes back unchanged', () => {
    expect(stampObjectSource('export const speed = 2;', 'a.ts')).toBe('export const speed = 2;');
    expect(stampObjectSource('const GameObject = (;', 'a.ts')).toBe('const GameObject = (;');
  });
});
