import { type Engine, Gizmos, ScreenCapture } from '@synergy/engine';
import { render } from 'preact';
import { EditorApplication } from './EditorApplication';
import { EditorPrefs } from './EditorPrefs';
import { Editor, type EditorActions } from './editor/Editor';
import { EDITOR_STYLE } from './editor/styles';
import { DevServerLink } from './link';
import { LogCapture } from './logs';
import { buildReport } from './report';
import { Selection } from './Selection';

export interface AttachEditorOptions {
  /** The log to show and save. Default: a new capture, installed now. Start one earlier with `startLogCapture()`. */
  logs?: LogCapture;
  /** Open the editor straight away. Default: as it was left, or when the URL has `?editor`. */
  open?: boolean;
  /** Written at the top of `.logs/game.log`, e.g. the build id. */
  header?: string;
}

/** What `attachEditor` returns, also reachable from the browser console as `synergy.editor`. */
export interface EditorHandle {
  readonly logs: LogCapture;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Saves a report (`.reports/<time>/` and `.reports/latest/`) and resolves to its folder. */
  report(note?: string): Promise<string | null>;
  /** Saves the game view to `.screenshots/` and resolves to its path. */
  screenshot(name?: string): Promise<string | null>;
  /** Takes the editor away and gives the page back as it was. */
  detach(): void;
}

let early: LogCapture | null = null;

/**
 * Starts recording the console now, before the engine exists, so that a failure while the
 * game starts is in the log too. `attachEditor` picks this capture up.
 */
export function startLogCapture(): LogCapture {
  if (!early) {
    early = new LogCapture();
    early.install();
  }
  return early;
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Attaches the editor to a running engine: Unity's editor windows over the game, for
 * development builds. Nothing shows until it is opened, so the game looks as it ships.
 *
 *   `            open or close the editor (Hierarchy, Inspector, Console, Game)
 *   F8           save a report: screenshot, log, hierarchy, HUD text, your note
 *   F9           save a screenshot
 *   Ctrl+P       play / pause          Ctrl+Shift+P  pause          Ctrl+Alt+P  step
 *
 * It also streams the log to `.logs/game.log` through the dev server, lets
 * `bun run report` ask this page for a report, and makes `Debug.break()`,
 * `Application.isEditor`, gizmos and `ScreenCapture.captureScreenshot` work.
 */
export function attachEditor(engine: Engine, options: AttachEditorOptions = {}): EditorHandle {
  const logs = options.logs ?? startLogCapture();
  const style = document.createElement('style');
  style.textContent = EDITOR_STYLE;
  document.head.append(style);
  const root = document.createElement('div');
  root.id = 'synergy-editor';
  document.body.append(root);

  const container = engine.canvas.parentElement;
  const originalStyle = container?.getAttribute('style') ?? null;
  let isOpen = false;
  let viewObserver: ResizeObserver | null = null;
  let toast: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const say = (text: string) => {
    if (toast) clearTimeout(toast.timer);
    toast = { text, timer: setTimeout(() => ((toast = null), draw()), 5000) };
    draw();
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  const handle: EditorHandle = {
    logs,
    get isOpen() {
      return isOpen;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
    async report(note = '') {
      const report = await buildReport(engine, logs, note);
      const folder = await link.saveReport(report);
      if (folder) {
        copy(folder);
        say(`Report saved to ${folder} (also .reports/latest). Its path is on the clipboard.`);
      } else {
        copy(`${report.files['summary.md'] ?? ''}\n\n## Log\n\n${report.files['log.txt'] ?? ''}`);
        say('No dev server to save to: the summary and log are on the clipboard instead.');
      }
      return folder;
    },
    async screenshot(name) {
      const saved = await engine.run(() => ScreenCapture.captureScreenshot(name ?? ''));
      say(saved ? `Screenshot saved: ${saved}` : 'The game view could not be read.');
      return saved;
    },
    detach() {
      setOpen(false);
      stopLink();
      engine.editor = null;
      removeEventListener('keydown', onKey, true);
      engine.app.systems.off('postUpdate', drawGizmos);
      offSelect();
      offErrors();
      render(null, root);
      root.remove();
      style.remove();
    },
  };

  const link = new DevServerLink(logs, (note) => handle.report(note));
  const stopLink = link.start(
    `=== Synergy log ${new Date().toISOString()} ${location.href}${options.header ? ` ${options.header}` : ''} ===`,
  );

  engine.editor = {
    pause: () => {
      EditorApplication.isPaused = true;
      if (!isOpen) setOpen(true);
    },
    saveScreenshot: (name, dataUrl) => link.saveScreenshot(dataUrl, name || undefined),
  };

  // Gizmos are drawn after every lateUpdate, and once more when the selection changes
  // while paused, since nothing else would draw the frame.
  const drawGizmos = () => {
    if (isOpen && EditorPrefs.getBool('game.gizmos', true)) Gizmos._drawAll(Selection.activeGameObject);
  };
  engine.app.systems.on('postUpdate', drawGizmos);
  const offSelect = Selection.selectionChanged.addListener(() => {
    if (EditorApplication.isPaused && !engine.isHeadless) {
      engine.run(drawGizmos);
      engine.app.render();
    }
  });

  // Unity's Error Pause: stop on the frame an error is logged, with the editor open on it.
  const offErrors = logs.subscribe((entry, repeated) => {
    if (repeated || entry.level !== 'error' || !EditorPrefs.getBool('console.errorPause', false)) return;
    if (!EditorApplication.isPaused) engine.editor?.pause();
  });

  const actions: EditorActions = {
    report: async (note) => {
      await handle.report(note);
    },
    screenshot: async () => {
      await handle.screenshot();
    },
    close: () => setOpen(false),
    gameView(element) {
      viewObserver?.disconnect();
      viewObserver = null;
      if (!element || !container) return;
      // The canvas stays where it is in the page; it is laid over the Game panel, so the
      // HUD (which sits on the same parent) and the mouse position follow it.
      const place = () => {
        const rect = element.getBoundingClientRect();
        Object.assign(container.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      };
      viewObserver = new ResizeObserver(place);
      viewObserver.observe(element);
      place();
    },
  };

  function draw(): void {
    const errors = logs.counts.error;
    render(
      <>
        {isOpen && <Editor engine={engine} logs={logs} actions={actions} />}
        {!isOpen && errors > 0 && (
          <button
            type="button"
            className="synergy-editor-badge"
            title="Open the editor (`)"
            onClick={() => setOpen(true)}
          >
            ⛔ {errors} {errors === 1 ? 'error' : 'errors'} · press ` to see
          </button>
        )}
        {toast && <div className="synergy-editor-toast">{toast.text}</div>}
      </>,
      root,
    );
  }

  function setOpen(value: boolean): void {
    if (isOpen === value) return;
    isOpen = value;
    EditorPrefs.setBool('open', value);
    if (!value && container) {
      viewObserver?.disconnect();
      viewObserver = null;
      if (originalStyle === null) container.removeAttribute('style');
      else container.setAttribute('style', originalStyle);
    }
    draw();
  }

  // The badge only has to change when an error arrives.
  logs.subscribe((entry, repeated) => {
    if (!isOpen && !repeated && entry.level === 'error') draw();
  });

  function onKey(event: KeyboardEvent): void {
    const typing = editable(event.target);
    const ctrl = event.ctrlKey || event.metaKey;
    let handled = true;
    if (event.code === 'F8') void handle.report();
    else if (event.code === 'F9') void handle.screenshot();
    else if (typing) handled = false;
    else if (event.code === 'Backquote' && !ctrl) handle.toggle();
    else if (ctrl && event.code === 'KeyP' && event.altKey) EditorApplication.step();
    else if (ctrl && event.code === 'KeyP' && event.shiftKey) EditorApplication.isPaused = !EditorApplication.isPaused;
    else if (ctrl && event.code === 'KeyP') EditorApplication.isPaused = !EditorApplication.isPaused;
    else handled = false;
    if (handled) {
      // Keep the browser's own meaning of the key (print, devtools) and the game's out of it.
      event.preventDefault();
      event.stopPropagation();
    }
  }
  addEventListener('keydown', onKey, true);

  const fromUrl = new URLSearchParams(location.search).has('editor');
  setOpen(options.open ?? (fromUrl || EditorPrefs.getBool('open', false)));
  draw();
  return handle;
}
