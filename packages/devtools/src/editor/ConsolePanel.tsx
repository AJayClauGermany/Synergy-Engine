import { isAlive } from '@synergy/engine';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import { EditorPrefs } from '../EditorPrefs';
import { type LogCapture, type LogEntry, type LogLevel } from '../logs';
import { Selection } from '../Selection';

/** Unity's Console has three counters; debug and info count as messages. */
type Bucket = 'log' | 'warn' | 'error';
const bucketOf = (level: LogLevel): Bucket => (level === 'warn' || level === 'error' ? level : 'log');
const ICONS: Record<Bucket, string> = { log: 'ⓘ', warn: '⚠', error: '⛔' };
/** Rows drawn at most; the file and "Copy" still have every entry. */
const MAX_ROWS = 1000;

function when(entry: LogEntry): string {
  const seconds = (entry.time / 1000).toFixed(2);
  return entry.frame === undefined ? `${seconds}s` : `${seconds}s f${entry.frame}`;
}

/** Collapse: one row per distinct message, with how often it came. */
function collapse(entries: readonly LogEntry[]): LogEntry[] {
  const byKey = new Map<string, LogEntry>();
  for (const entry of entries) {
    const key = `${entry.level}\u0000${entry.message}`;
    const seen = byKey.get(key);
    byKey.set(key, seen ? { ...entry, id: seen.id, count: seen.count + entry.count } : entry);
  }
  return [...byKey.values()];
}

/**
 * Unity's Console window. Every console message and uncaught error since the page loaded,
 * newest at the bottom. The buttons are Unity's: Clear, Collapse (one row per distinct
 * message), Error Pause (pause the game when an error is logged), and the three counters,
 * which also filter. Clicking a row shows the whole message and its stack below, and
 * selects the GameObject it was logged with (`Debug.log('...', this.gameObject)`).
 */
export function ConsolePanel({ logs }: { logs: LogCapture }) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [, setPrefsVersion] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const show: Record<Bucket, boolean> = {
    log: EditorPrefs.getBool('console.showLog', true),
    warn: EditorPrefs.getBool('console.showWarn', true),
    error: EditorPrefs.getBool('console.showError', true),
  };
  const collapsed = EditorPrefs.getBool('console.collapse', false);
  const errorPause = EditorPrefs.getBool('console.errorPause', false);
  const flip = (key: string, current: boolean) => {
    EditorPrefs.setBool(key, !current);
    setPrefsVersion((version) => version + 1);
  };

  // New lines redraw the list, at most once per animation frame.
  useEffect(() => {
    let queued = 0;
    const unsubscribe = logs.subscribe(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        redraw(undefined);
      });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(queued);
    };
  }, [logs]);

  // Stay at the newest line, unless the reader has scrolled up to look at an older one.
  useLayoutEffect(() => {
    const node = list.current;
    if (node && atBottom.current) node.scrollTop = node.scrollHeight;
  });

  const counts: Record<Bucket, number> = { log: 0, warn: 0, error: 0 };
  for (const entry of logs.entries) counts[bucketOf(entry.level)] += entry.count;
  const query = search.trim().toLowerCase();
  const source = collapsed ? collapse(logs.entries) : logs.entries;
  const visible = source.filter(
    (entry) => show[bucketOf(entry.level)] && (!query || entry.message.toLowerCase().includes(query)),
  );
  const rows = visible.slice(-MAX_ROWS);
  const selected = source.find((entry) => entry.id === selectedId) ?? null;

  return (
    <section className="ed-panel ed-console" data-interactive>
      <div className="ed-tabs">
        <span className="ed-tab">Console</span>
        <button
          type="button"
          onClick={() => {
            logs.clear();
            setSelectedId(null);
          }}
        >
          Clear
        </button>
        <button type="button" className={collapsed ? 'ed-on' : ''} onClick={() => flip('console.collapse', collapsed)}>
          Collapse
        </button>
        <button
          type="button"
          className={errorPause ? 'ed-on' : ''}
          title="Pause the game when an error is logged"
          onClick={() => flip('console.errorPause', errorPause)}
        >
          Error Pause
        </button>
        <button
          type="button"
          title="Copy the whole log, as it is written to .logs/game.log"
          onClick={() => void navigator.clipboard?.writeText(logs.text()).catch(() => {})}
        >
          Copy
        </button>
        <span className="ed-spacer" />
        <input type="search" placeholder="Search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
        {(['log', 'warn', 'error'] as const).map((bucket) => (
          <button
            key={bucket}
            type="button"
            className={show[bucket] ? 'ed-on' : ''}
            onClick={() => flip(`console.show${bucket[0]?.toUpperCase()}${bucket.slice(1)}`, show[bucket])}
          >
            {ICONS[bucket]} {counts[bucket] > 999 ? '999+' : counts[bucket]}
          </button>
        ))}
      </div>
      <div className="ed-console-body">
        <div
          className="ed-entries"
          ref={list}
          onScroll={(event) => {
            const node = event.currentTarget;
            atBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
          }}
        >
          {visible.length > rows.length && (
            <div className="ed-empty">{visible.length - rows.length} older lines are in the log file.</div>
          )}
          {rows.map((entry) => (
            <div
              key={entry.id}
              className={`ed-entry ed-${bucketOf(entry.level)}${entry.id === selectedId ? ' ed-selected' : ''}`}
              onClick={() => {
                setSelectedId(entry.id);
                if (entry.context && isAlive(entry.context)) Selection.activeGameObject = entry.context;
              }}
            >
              <span className="ed-icon">{ICONS[bucketOf(entry.level)]}</span>
              <span className="ed-when">{when(entry)}</span>
              <span className="ed-text">{entry.message}</span>
              {entry.count > 1 && <span className="ed-count">{entry.count}</span>}
            </div>
          ))}
        </div>
        <div className="ed-detail">
          {selected
            ? `${selected.message}${selected.stack ? `\n${selected.stack}` : ''}${
                selected.context ? `\n(logged with ${selected.context.toString()})` : ''
              }`
            : ''}
        </div>
      </div>
    </section>
  );
}
