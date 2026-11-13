import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Debug, Engine, GameObject, Vector3 } from '@synergy/engine';
import { formatArguments, formatEntry, LogCapture } from '../src/logs';

/** A console that records instead of printing, so the capture can be installed on it. */
function fakeConsole() {
  const printed: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      printed.push(`${level}:${args.map(String).join(' ')}`);
  const console = {
    debug: record('debug'),
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  const listeners = new Map<string, (event: Event) => void>();
  const target = {
    console,
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as typeof globalThis;
  return { target, console, printed, listeners };
}

let clock = 0;
const now = () => clock;

describe('LogCapture', () => {
  test('records each console call with its level, and the console still prints it', () => {
    const fake = fakeConsole();
    const logs = new LogCapture({ now });
    logs.install(fake.target);
    fake.console.log('hello', 42);
    fake.console.warn('careful');
    fake.console.error('broken', new Error('it broke'));
    expect(fake.printed).toEqual(['log:hello 42', 'warn:careful', 'error:broken Error: it broke']);
    expect(logs.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['log', 'hello 42'],
      ['warn', 'careful'],
      ['error', 'broken Error: it broke'],
    ]);
    expect(logs.entries[2]?.stack).toContain('logs.test.ts');
    expect(logs.counts).toEqual({ debug: 0, log: 1, info: 0, warn: 1, error: 1 });
    logs.uninstall();
    fake.console.log('after');
    expect(logs.entries).toHaveLength(3);
    expect(fake.printed.at(-1)).toBe('log:after');
  });

  test('uncaught errors and rejected promises are recorded as errors', () => {
    const fake = fakeConsole();
    const logs = new LogCapture({ now });
    logs.install(fake.target);
    fake.listeners.get('error')?.({ error: new TypeError('x is undefined'), message: '' } as unknown as Event);
    fake.listeners.get('unhandledrejection')?.({ reason: 'timeout' } as unknown as Event);
    expect(logs.entries.map((entry) => entry.message)).toEqual([
      'Uncaught TypeError: x is undefined',
      'Unhandled promise rejection: timeout',
    ]);
    logs.uninstall();
    expect(fake.listeners.size).toBe(0);
  });

  test('the same message in a row becomes one entry with a count', () => {
    const logs = new LogCapture({ now });
    for (let i = 0; i < 5; i++) logs.add('warn', ['again']);
    logs.add('log', ['different']);
    expect(logs.entries.map((entry) => [entry.message, entry.count])).toEqual([
      ['again', 5],
      ['different', 1],
    ]);
    expect(logs.counts.warn).toBe(5);
  });

  test('keeps at most `limit` entries, dropping the oldest', () => {
    const logs = new LogCapture({ now, limit: 3 });
    for (let i = 0; i < 5; i++) logs.add('log', [`line ${i}`]);
    expect(logs.entries.map((entry) => entry.message)).toEqual(['line 2', 'line 3', 'line 4']);
    expect(logs.entries[0]?.id).toBe(3);
  });

  test('a listener that logs does not log forever', () => {
    const fake = fakeConsole();
    const logs = new LogCapture({ now });
    logs.install(fake.target);
    logs.subscribe(() => fake.console.log('heard it'));
    fake.console.log('first');
    expect(logs.entries.map((entry) => entry.message)).toEqual(['first']);
    logs.uninstall();
  });
});

describe('with an engine running', () => {
  let engine: Engine;
  beforeEach(() => {
    engine = Engine.createHeadless();
  });
  afterEach(() => {
    engine.dispose();
  });

  test('an entry carries the frame and game time, and the GameObject it was logged with', () => {
    const fake = fakeConsole();
    const logs = new LogCapture({ now });
    logs.install(fake.target);
    engine.stepFrames(3);
    const board = new GameObject('Board');
    fake.console.log('picked', board.transform);
    const [entry] = logs.entries;
    expect(entry?.frame).toBe(3);
    expect(entry?.gameTime).toBeCloseTo(3 / 60);
    expect(entry?.context).toBe(board);
    expect(entry?.message).toBe('picked Board (Transform)');
    logs.uninstall();
  });

  test('Debug.log reaches the capture, because it goes through the console', () => {
    // Quiet the real console first; the capture then wraps the quiet one.
    const quiet = spyOn(console, 'log').mockImplementation(() => {});
    const logs = new LogCapture({ now });
    logs.install();
    try {
      Debug.log('from a script', new GameObject('Unit'));
    } finally {
      logs.uninstall();
      quiet.mockRestore();
    }
    expect(logs.entries.map((entry) => entry.message)).toEqual(['from a script Unit (GameObject)']);
    expect(logs.entries[0]?.context?.name).toBe('Unit');
  });
});

describe('formatting', () => {
  test('arguments are joined as the browser does, placeholders included', () => {
    expect(formatArguments(['%s has %d hp', 'Scout', 7.9])).toBe('Scout has 7 hp');
    expect(formatArguments(['%cstyled', 'color: red', 'tail'])).toBe('styled tail');
    expect(formatArguments(['at', new Vector3(1, 0, -2)])).toBe(`at ${new Vector3(1, 0, -2).toString()}`);
    expect(formatArguments([{ hp: 3, tags: ['a'] }])).toBe('{"hp":3,"tags":["a"]}');
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(formatArguments([loop])).toBe('{"self":"[circular]"}');
  });

  test('a log line has the time, frame, game time, level and message; a stack is indented under it', () => {
    clock = 12_345;
    const logs = new LogCapture({ now: () => 0 });
    const entry = {
      ...logs.add('error', ['two\nlines']),
      time: 12_345,
      frame: 742,
      gameTime: 11.2,
      stack: 'at a\nat b',
    };
    expect(formatEntry(entry)).toBe('[   12.345s f742 t11.20] ERROR two\n    lines\n    at a\n    at b');
    expect(formatEntry({ ...entry, frame: undefined, gameTime: undefined, stack: undefined, count: 3 })).toBe(
      '[   12.345s] ERROR two (×3)\n    lines',
    );
  });

  test('text() can leave out the levels below a minimum', () => {
    const logs = new LogCapture({ now: () => 0 });
    logs.add('log', ['quiet']);
    logs.add('warn', ['loud']);
    expect(logs.text('warn')).toBe('[    0.000s] WARN  loud');
  });
});
