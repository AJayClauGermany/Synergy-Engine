import { type Engine, SceneManager, Time } from '@synergy/engine';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { EditorApplication } from '../EditorApplication';
import { EditorPrefs } from '../EditorPrefs';
import type { LogCapture } from '../logs';
import { Selection } from '../Selection';
import { ConsolePanel } from './ConsolePanel';
import { HierarchyPanel } from './HierarchyPanel';
import { InspectorPanel } from './InspectorPanel';

/** What the editor's buttons do; `attachEditor` supplies them. */
export interface EditorActions {
  /** Saves a report with the note and says where it went. */
  report(note: string): Promise<void>;
  /** Saves a screenshot of the game view. */
  screenshot(): Promise<void>;
  close(): void;
  /** The empty Game panel the canvas is laid over, or `null` when it goes away. */
  gameView(element: HTMLElement | null): void;
}

const TIME_SCALES = [0, 0.1, 0.25, 0.5, 1, 2, 4];

function Toolbar({ engine, actions }: { engine: Engine; actions: EditorActions }) {
  const [note, setNote] = useState('');
  const paused = EditorApplication.isPaused;
  const time = engine.time;
  const scene = engine.run(() => SceneManager.getActiveScene().name);
  return (
    <header className="ed-toolbar" data-interactive>
      <div>
        <span className="ed-title">Synergy</span>
        <span className="ed-dim">{scene}</span>
      </div>
      <div className="ed-play">
        <button
          type="button"
          className={paused ? '' : 'ed-on'}
          title="Play (Ctrl+P)"
          onClick={() => {
            EditorApplication.isPaused = false;
          }}
        >
          ▶
        </button>
        <button
          type="button"
          className={paused ? 'ed-on' : ''}
          title="Pause (Ctrl+Shift+P)"
          onClick={() => {
            EditorApplication.isPaused = !paused;
          }}
        >
          ❚❚
        </button>
        <button type="button" title="Step one frame (Ctrl+Alt+P)" onClick={() => EditorApplication.step()}>
          ▶❚
        </button>
      </div>
      <div>
        <label className="ed-dim" title="Time.timeScale">
          Time&nbsp;
          <select
            value={String(time.timeScale)}
            onChange={(event) => {
              const scale = Number(event.currentTarget.value);
              engine.run(() => {
                Time.timeScale = scale;
              });
            }}
          >
            {(TIME_SCALES.includes(time.timeScale) ? TIME_SCALES : [...TIME_SCALES, time.timeScale]).map((scale) => (
              <option key={scale} value={String(scale)}>
                {scale}×
              </option>
            ))}
          </select>
        </label>
        <input
          className="ed-note"
          placeholder="What went wrong? (note for the report)"
          value={note}
          onInput={(event) => setNote(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void actions.report(note).then(() => setNote(''));
          }}
        />
        <button
          type="button"
          title="Save screenshot, log, hierarchy and note to .reports/ (F8)"
          onClick={() => void actions.report(note).then(() => setNote(''))}
        >
          Report
        </button>
        <button
          type="button"
          title="Save the game view to .screenshots/ (F9)"
          onClick={() => void actions.screenshot()}
        >
          Screenshot
        </button>
        <button type="button" title="Close the editor (`)" onClick={actions.close}>
          ✕
        </button>
      </div>
    </header>
  );
}

/** The empty area the canvas is laid over; tells `attachEditor` where it is. */
function GameView({ onElement }: { onElement: (element: HTMLElement | null) => void }) {
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onElement(view.current);
    return () => onElement(null);
  }, [onElement]);
  return <div className="ed-game-view" ref={view} />;
}

function GamePanel({ engine, actions }: { engine: Engine; actions: EditorActions }) {
  const [gizmos, setGizmos] = useState(EditorPrefs.getBool('game.gizmos', true));
  const { width, height } = engine.canvasSize;
  const fps = engine.time.unscaledDeltaTime > 0 ? Math.round(1 / engine.time.unscaledDeltaTime) : 0;
  return (
    <section className="ed-game">
      <div className="ed-tabs">
        <span className="ed-tab">Game</span>
        <span className="ed-spacer" />
        <span className="ed-stat">
          {width}×{height} · {engine.isHeadless ? 'headless' : String(engine.app.graphicsDevice.deviceType)} ·{' '}
          {EditorApplication.isPaused ? 'paused' : `${fps} fps`} · frame {engine.time.frameCount}
        </span>
        <label title="Draw what scripts draw in onDrawGizmos()">
          <input
            type="checkbox"
            checked={gizmos}
            onChange={(event) => {
              EditorPrefs.setBool('game.gizmos', event.currentTarget.checked);
              setGizmos(event.currentTarget.checked);
            }}
          />
          Gizmos
        </label>
      </div>
      <GameView onElement={actions.gameView} />
    </section>
  );
}

/**
 * The editor: Unity's default layout with the game in the middle. The Hierarchy is on the
 * left, the Inspector on the right, the Console along the bottom, and Play, Pause and Step
 * in the toolbar. It redraws a few times a second while the game runs, so the Inspector
 * shows live values.
 */
export function Editor({ engine, logs, actions }: { engine: Engine; logs: LogCapture; actions: EditorActions }) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(() => redraw(undefined), 250);
    const offPause = EditorApplication.pauseStateChanged.addListener(() => redraw(undefined));
    const offSelect = Selection.selectionChanged.addListener(() => redraw(undefined));
    return () => {
      clearInterval(timer);
      offPause();
      offSelect();
    };
  }, []);
  return (
    <div className="synergy-editor">
      <Toolbar engine={engine} actions={actions} />
      <HierarchyPanel engine={engine} />
      <GamePanel engine={engine} actions={actions} />
      <InspectorPanel />
      <ConsolePanel logs={logs} />
    </div>
  );
}
