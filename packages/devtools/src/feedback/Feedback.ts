import { type Engine, SceneManager, ScreenCapture, UnityEvent } from '@synergy/engine';
import { EditorApplication } from '../EditorApplication';
import { EditorPrefs } from '../EditorPrefs';
import { drawFeedbackImages } from './capture';
import { describeHud, describeWorld } from './describe';
import {
  FEEDBACK_DETAILS,
  type FeedbackContext,
  type FeedbackDetail,
  type FeedbackNote,
  formatFeedback,
  type TargetDescription,
} from './format';
import { hudElementAt } from './hud';
import { pickWorld, type ViewPoint, type ViewRect, viewRectOf, viewRectOfCell, type WorldPick } from './pick';

/** What a click landed on, still attached to the running game. */
export type LiveTarget = { readonly kind: 'hud'; readonly element: Element } | WorldPick;

/** What saving feedback made: the prompt, and the report folder when there is a dev server. */
export interface SavedFeedback {
  readonly prompt: string;
  readonly folder: string | null;
}

/** The files feedback adds to a report. */
export interface FeedbackFiles {
  readonly files: Readonly<Record<string, string>>;
  readonly images: Readonly<Record<string, string>>;
}

export interface FeedbackOptions {
  /** Saves a report holding these files and resolves to its folder, or `null` without a dev server. */
  saveReport(note: string, extra: FeedbackFiles): Promise<string | null>;
  /** What the game adds to "Where the game was": the screen, whose turn it is. */
  context?: () => Readonly<Record<string, unknown>>;
}

/**
 * The notes a person makes on the running game by clicking it, and the prompt they turn
 * into. This is the part without a face: `FeedbackOverlay` is the picker a person uses,
 * and `synergy.editor.feedback` reaches the same thing from the console or a script:
 *
 *   synergy.editor.feedback.note(640, 120, 'make the title gold')   // a point of the page
 *   await synergy.editor.feedback.save()                            // { prompt, folder }
 */
export class Feedback {
  /** Fires when the notes or the detail level change. */
  readonly changed = new UnityEvent<[]>();
  private list: FeedbackNote[] = [];
  private nextId = 1;

  constructor(
    private readonly engine: Engine,
    private readonly options: FeedbackOptions,
  ) {}

  get notes(): readonly FeedbackNote[] {
    return this.list;
  }

  /** How much of what was captured the prompt holds. Remembered between page loads. */
  get detail(): FeedbackDetail {
    const stored = EditorPrefs.getString('feedback.detail', 'standard');
    return FEEDBACK_DETAILS.find((detail) => detail === stored) ?? 'standard';
  }

  set detail(value: FeedbackDetail) {
    EditorPrefs.setString('feedback.detail', value);
    this.changed.invoke();
  }

  /** The game view's place in the page. */
  view(): DOMRect {
    return this.engine.canvas.getBoundingClientRect();
  }

  /** A point of the page (`clientX`, `clientY`) as a point of the game view. */
  toView(clientX: number, clientY: number): ViewPoint {
    const view = this.view();
    return { x: Math.round(clientX - view.left), y: Math.round(clientY - view.top) };
  }

  /** What is drawn at a point of the page: a HUD element first, then what the engine drew. */
  targetAt(clientX: number, clientY: number): LiveTarget {
    const element = hudElementAt(clientX, clientY, this.engine.canvas);
    if (element) return { kind: 'hud', element };
    const view = this.view();
    const inView = clientX >= view.left && clientX <= view.right && clientY >= view.top && clientY <= view.bottom;
    return inView ? pickWorld(this.engine, this.toView(clientX, clientY)) : { kind: 'empty' };
  }

  /** The thing that holds `target`: an element's parent, a GameObject's parent. `null` at the top. */
  parentOf(target: LiveTarget): LiveTarget | null {
    if (target.kind === 'hud') {
      const parent = target.element.parentElement;
      return parent && parent !== document.body ? { kind: 'hud', element: parent } : null;
    }
    if (target.kind !== 'gameObject') return null;
    const parent = this.engine.run(() => target.gameObject.transform.parent?.gameObject ?? null);
    return parent && { kind: 'gameObject', gameObject: parent, cell: null };
  }

  /** Where `target` is in the game view right now, or `null`. */
  rectOf(target: LiveTarget): ViewRect | null {
    if (target.kind === 'hud') {
      const rect = target.element.getBoundingClientRect();
      const view = this.view();
      return { x: rect.left - view.left, y: rect.top - view.top, width: rect.width, height: rect.height };
    }
    if (target.kind === 'gameObject') return this.engine.run(() => viewRectOf(this.engine, target.gameObject));
    return target.kind === 'tile' ? this.engine.run(() => viewRectOfCell(this.engine, target.cell)) : null;
  }

  describe(target: LiveTarget): TargetDescription {
    return target.kind === 'hud' ? describeHud(target.element, this.view()) : describeWorld(this.engine, target);
  }

  /** Keeps a note about `target`. `at` and `expected` are points of the game view. */
  add(target: LiveTarget, at: ViewPoint, comment: string, expected: ViewPoint | null = null): FeedbackNote {
    const note: FeedbackNote = {
      id: this.nextId++,
      comment: comment.trim(),
      at,
      target: this.describe(target),
      expected,
    };
    this.list = [...this.list, note];
    this.changed.invoke();
    return note;
  }

  /**
   * A note about whatever is at a point of the page, for the console and for scripts.
   * `expected` is a point of the page too.
   */
  note(clientX: number, clientY: number, comment: string, expected?: { x: number; y: number }): FeedbackNote {
    return this.add(
      this.targetAt(clientX, clientY),
      this.toView(clientX, clientY),
      comment,
      expected ? this.toView(expected.x, expected.y) : null,
    );
  }

  remove(id: number): void {
    this.list = this.list.filter((note) => note.id !== id);
    this.changed.invoke();
  }

  clear(): void {
    this.list = [];
    this.nextId = 1;
    this.changed.invoke();
  }

  private context(): FeedbackContext {
    const { engine } = this;
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.context?.() ?? {})) {
      if (value !== null && value !== undefined) extra[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return engine.run(() => {
      const scenes: string[] = [];
      for (let i = 0; i < SceneManager.sceneCount; i++) scenes.push(SceneManager.getSceneAt(i).name);
      return {
        page: location.href,
        scenes,
        activeScene: SceneManager.getActiveScene().name,
        frame: engine.time.frameCount,
        time: engine.time.time,
        paused: EditorApplication.isPaused,
        view: engine.canvasSize,
        extra,
      };
    });
  }

  /** The prompt for the notes so far, at the chosen detail. */
  prompt(folder: string | null = null, images = false): string {
    return formatFeedback(this.list, this.context(), { detail: this.detail, folder, images });
  }

  /**
   * Saves the notes as a report (`feedback.md`, `feedback.json`, `feedback.png` and a
   * close-up per note, beside the log and the hierarchy) and returns the prompt, which
   * names that folder. Without a dev server there is no folder and the prompt stands alone.
   */
  async save(): Promise<SavedFeedback> {
    const { engine } = this;
    const game = await engine.run(() => ScreenCapture.captureScreenshotAsDataUrl());
    const roots = [...document.querySelectorAll('.synergy-ui')];
    const pictures = await drawFeedbackImages(game, this.view(), roots, this.list);
    const drawn = Object.keys(pictures.images).length > 0;
    const context = this.context();
    const files = {
      // In the folder itself the files are neighbours.
      'feedback.md': formatFeedback(this.list, context, { detail: 'full', folder: '.', images: drawn }),
      'feedback.json': JSON.stringify({ context, hudInPictures: pictures.hud, notes: this.list }, null, 2),
    };
    const summary = this.list.map((note) => `${note.id}. ${note.target.kind} ${note.target.label}: ${note.comment}`);
    const folder = await this.options.saveReport(summary.join('\n'), { files, images: pictures.images });
    return { prompt: this.prompt(folder, drawn && folder !== null), folder };
  }
}
