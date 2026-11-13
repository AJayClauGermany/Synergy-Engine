import { Component, Engine, EngineObject, GameObject } from '@synergy/engine';

/** How serious a log entry is. The names are the `console` methods that make them. */
export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

/** One line in the Console. */
export interface LogEntry {
  /** Increases by one per entry, so a reader can ask for "everything after 41". */
  readonly id: number;
  readonly level: LogLevel;
  /** The message, with its arguments written out as text. */
  readonly message: string;
  /** Where an error came from, when there was an `Error` to ask. */
  readonly stack?: string;
  /** Milliseconds since the capture started (wall clock, not game time). */
  readonly time: number;
  /** `Time.frameCount` and `Time.time` when it was logged, if an engine was running. */
  readonly frame?: number;
  readonly gameTime?: number;
  /** How many times in a row the same message arrived (Unity's "Collapse"). */
  readonly count: number;
  /**
   * The GameObject the message was about, when one was passed (Unity's `context`
   * argument: `Debug.log('Out of range', this.gameObject)`). The Console selects it on click.
   */
  readonly context?: GameObject;
}

function contextOf(args: readonly unknown[]): GameObject | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (arg instanceof GameObject) return arg;
    if (arg instanceof Component) return arg.gameObject;
  }
  return undefined;
}

export interface LogCaptureOptions {
  /** Entries kept; older ones are dropped. Default 5000. */
  limit?: number;
  /** The clock, in milliseconds. Default `performance.now()`. */
  now?: () => number;
}

type ConsoleMethod = (...args: unknown[]) => void;
const METHODS: readonly LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** One argument of a `console` call as text, the way a reader of a log file wants it. */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof EngineObject) return value.isDestroyed ? `${value.name} (destroyed)` : value.toString();
  if (value === null || typeof value !== 'object') return String(value);
  // Vectors, colours and other classes that describe themselves.
  const describe = (value as { toString?: () => string }).toString;
  if (typeof describe === 'function' && describe !== Object.prototype.toString && !Array.isArray(value)) {
    return clip(describe.call(value), 500);
  }
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof EngineObject) return item.toString();
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
    return clip(json ?? Object.prototype.toString.call(value), 500);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Joins a `console` call's arguments the way the browser does, including the `%s`, `%d`,
 * `%o` and `%c` placeholders (styles from `%c` are dropped).
 */
export function formatArguments(args: readonly unknown[]): string {
  const rest = [...args];
  let head = '';
  if (typeof rest[0] === 'string' && rest[0].includes('%')) {
    const template = rest.shift() as string;
    head = template.replace(/%([sdifoOc%])/g, (match, kind: string) => {
      if (kind === '%') return '%';
      if (rest.length === 0) return match;
      const value = rest.shift();
      if (kind === 'c') return '';
      if (kind === 'd' || kind === 'i') return String(Math.trunc(Number(value)));
      if (kind === 'f') return String(Number(value));
      return formatValue(value);
    });
  }
  return [head, ...rest.map(formatValue)].filter((part, index) => index > 0 || part !== '').join(' ');
}

function stackOf(args: readonly unknown[]): string | undefined {
  const error = args.find((arg): arg is Error => arg instanceof Error);
  if (!error?.stack) return undefined;
  // V8 starts the stack with "Name: message", which the message already says.
  const lines = error.stack.split('\n');
  return (
    (lines[0]?.includes(error.message) ? lines.slice(1) : lines).map((line) => line.trim()).join('\n') || undefined
  );
}

const pad = (value: number, width: number) => String(value).padStart(width, ' ');

/**
 * One entry as a line of the log file:
 *
 *   [  12.345s f742 t11.20] WARN  Camera.main is null: no camera is tagged MainCamera
 *
 * The wall-clock time comes first, then the frame and game time when an engine was
 * running. A stack follows on indented lines.
 */
export function formatEntry(entry: LogEntry): string {
  const clock = `${pad(Math.floor(entry.time / 1000), 5)}.${String(Math.floor(entry.time % 1000)).padStart(3, '0')}s`;
  const frame = entry.frame === undefined ? '' : ` f${entry.frame}`;
  const game = entry.gameTime === undefined ? '' : ` t${entry.gameTime.toFixed(2)}`;
  const repeat = entry.count > 1 ? ` (×${entry.count})` : '';
  // A message that spans lines keeps them, indented under the first, and so does a stack.
  const [first = '', ...more] = entry.message.split('\n');
  const out = [`[${clock}${frame}${game}] ${entry.level.toUpperCase().padEnd(5)} ${first}${repeat}`];
  for (const line of [...more, ...(entry.stack?.split('\n') ?? [])]) out.push(`    ${line}`);
  return out.join('\n');
}

/**
 * Records everything the page writes to the console, and every uncaught error, so it can
 * be shown in the editor's Console, written to `.logs/game.log` and put in a report.
 * `Debug.log`, `Debug.logWarning` and `Debug.logError` go through the console, so they
 * arrive here too, as do the engine's "Exception in ..." messages and PlayCanvas's own.
 *
 * Unity: the Console window, and `Application.logMessageReceived`.
 *
 *   const logs = new LogCapture();
 *   logs.install();
 *   logs.subscribe((entry) => send(formatEntry(entry)));
 */
export class LogCapture {
  private readonly items: LogEntry[] = [];
  private readonly listeners = new Set<(entry: LogEntry, replaced: boolean) => void>();
  private readonly limit: number;
  private readonly now: () => number;
  private readonly started: number;
  private nextId = 1;
  private restore: (() => void) | null = null;

  constructor(options: LogCaptureOptions = {}) {
    this.limit = options.limit ?? 5000;
    this.now = options.now ?? (() => performance.now());
    this.started = this.now();
  }

  /** Every entry still kept, oldest first. */
  get entries(): readonly LogEntry[] {
    return this.items;
  }

  /** How many entries of each level are kept. */
  get counts(): Record<LogLevel, number> {
    const counts: Record<LogLevel, number> = { debug: 0, log: 0, info: 0, warn: 0, error: 0 };
    for (const entry of this.items) counts[entry.level] += entry.count;
    return counts;
  }

  /** Adds an entry. `install()` calls this for each console call; tools may call it too. */
  add(level: LogLevel, args: readonly unknown[]): LogEntry {
    const message = formatArguments(args);
    const stack = stackOf(args);
    const engine = Engine.current;
    const frame = engine && !engine.isDisposed ? engine.time.frameCount : undefined;
    const gameTime = engine && !engine.isDisposed ? engine.time.time : undefined;
    const last = this.items.at(-1);
    // A message repeated every frame should cost one line with a count, not thousands.
    if (last && last.level === level && last.message === message && last.stack === stack) {
      const merged: LogEntry = { ...last, count: last.count + 1, time: this.now() - this.started, frame, gameTime };
      this.items[this.items.length - 1] = merged;
      for (const listener of this.listeners) listener(merged, true);
      return merged;
    }
    const entry: LogEntry = {
      id: this.nextId++,
      level,
      message,
      stack,
      time: this.now() - this.started,
      frame,
      gameTime,
      count: 1,
      context: contextOf(args),
    };
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    for (const listener of this.listeners) listener(entry, false);
    return entry;
  }

  /**
   * Calls `listener` for each new entry. `replaced` is true when the entry is the last one
   * again with a higher `count` (the same message, repeated). Returns the unsubscribe.
   */
  subscribe(listener: (entry: LogEntry, replaced: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forgets every entry (the Console's "Clear"). The log file keeps them. */
  clear(): void {
    this.items.length = 0;
  }

  /** The entries as the log file's text, optionally only those at or above `minimum`. */
  text(minimum: LogLevel = 'debug'): string {
    const floor = METHODS.indexOf(minimum);
    return this.items
      .filter((entry) => METHODS.indexOf(entry.level) >= floor)
      .map(formatEntry)
      .join('\n');
  }

  /**
   * Starts recording: wraps the console methods (they still print as before) and listens
   * for uncaught errors and rejected promises. Call it as early as possible, so that a
   * failure while the game starts is recorded too.
   */
  install(target: typeof globalThis = globalThis): void {
    if (this.restore) return;
    const console = target.console as unknown as Record<LogLevel, ConsoleMethod>;
    const originals = new Map<LogLevel, ConsoleMethod>();
    let inside = false;
    for (const level of METHODS) {
      const original = console[level];
      originals.set(level, original);
      console[level] = (...args: unknown[]) => {
        original.apply(target.console, args);
        // A listener that logs would otherwise call itself forever.
        if (inside) return;
        inside = true;
        try {
          this.add(level, args);
        } finally {
          inside = false;
        }
      };
    }
    const onError = (event: Event) => {
      const { error, message } = event as ErrorEvent;
      this.add('error', error instanceof Error ? ['Uncaught', error] : [`Uncaught ${message}`]);
    };
    const onRejection = (event: Event) => {
      const { reason } = event as PromiseRejectionEvent;
      this.add('error', ['Unhandled promise rejection:', reason]);
    };
    const events = typeof target.addEventListener === 'function';
    if (events) {
      target.addEventListener('error', onError);
      target.addEventListener('unhandledrejection', onRejection);
    }
    this.restore = () => {
      for (const [level, original] of originals) console[level] = original;
      if (events) {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
      }
    };
  }

  /** Stops recording and puts the console back as it was. */
  uninstall(): void {
    this.restore?.();
    this.restore = null;
  }
}
