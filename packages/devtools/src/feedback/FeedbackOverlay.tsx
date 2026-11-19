import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { EditorPrefs } from '../EditorPrefs';
import type { Feedback, LiveTarget } from './Feedback';
import { FEEDBACK_DETAILS, type FeedbackDetail } from './format';
import { sourceOf, tagOf } from './hud';
import type { ViewPoint, ViewRect } from './pick';

/** What the picker's buttons do besides keeping notes; `attachEditor` supplies them. */
export interface FeedbackActions {
  /** Saves the notes and puts the prompt on the clipboard. */
  copy(): Promise<void>;
  close(): void;
}

interface Draft {
  readonly target: LiveTarget;
  readonly at: ViewPoint;
  readonly comment: string;
  readonly expected: ViewPoint | null;
  /** The next click says where the target should be. */
  readonly pointing: boolean;
}

const DETAIL_HINT: Record<FeedbackDetail, string> = {
  brief: 'What was clicked, where its code is, your comment',
  standard: 'Plus layout, styles, components, script fields',
  full: 'Plus HTML, siblings, ancestors, whole subtrees',
};

function nameOf(target: LiveTarget): string {
  if (target.kind === 'hud') {
    const text = (target.element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const source = sourceOf(target.element);
    return `HUD · <${tagOf(target.element)}>${text ? ` "${text}"` : ''}${source ? ` · ${source}` : ''}`;
  }
  if (target.kind === 'gameObject') {
    const cell = target.cell ? ` · cell (${target.cell.cell.x}, ${target.cell.cell.y})` : '';
    return `GameObject · "${target.gameObject.name}"${cell}`;
  }
  if (target.kind === 'tile') return `Map cell · (${target.cell.cell.x}, ${target.cell.cell.y})`;
  return 'Empty space';
}

/** A view rectangle as page styles. */
function place(rect: ViewRect, view: DOMRect) {
  return {
    left: `${rect.x + view.left}px`,
    top: `${rect.y + view.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

/**
 * The picker: while it is open every click on the game is a note, not a move. Hovering
 * outlines what a click would pick (a HUD element, a GameObject, a map cell); clicking
 * opens a box for the comment. The game keeps running underneath: pause it first
 * (Ctrl+P) to point at something that will not hold still.
 */
export function FeedbackOverlay({ feedback, actions }: { feedback: Feedback; actions: FeedbackActions }) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [hover, setHover] = useState<LiveTarget | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [onTop, setOnTop] = useState(EditorPrefs.getBool('feedback.barOnTop', false));
  const field = useRef<HTMLTextAreaElement>(null);
  const frame = useRef(0);

  useEffect(() => feedback.changed.addListener(() => redraw(undefined)), [feedback]);
  // What moves under the outline (a walking unit, a resized window) moves the outline.
  useEffect(() => {
    const timer = setInterval(() => redraw(undefined), 200);
    return () => clearInterval(timer);
  }, []);
  const editing = draft !== null && !draft.pointing;
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing, draft?.target]);

  const view = feedback.view();
  const keep = () => {
    if (!draft) return;
    feedback.add(draft.target, draft.at, draft.comment, draft.expected);
    setDraft(null);
  };

  const onMove = (event: MouseEvent) => {
    const { clientX, clientY } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setHover(feedback.targetAt(clientX, clientY)));
  };
  const onClick = (event: MouseEvent) => {
    const at = feedback.toView(event.clientX, event.clientY);
    if (draft?.pointing) {
      setDraft({ ...draft, expected: at, pointing: false });
      return;
    }
    // A click elsewhere while writing picks again and keeps what was written.
    setDraft({
      target: feedback.targetAt(event.clientX, event.clientY),
      at,
      comment: draft?.comment ?? '',
      expected: null,
      pointing: false,
    });
  };

  const shown = draft?.pointing ? null : (draft?.target ?? hover);
  const shownRect = shown ? feedback.rectOf(shown) : null;
  const draftRect = draft ? feedback.rectOf(draft.target) : null;
  const anchor = draftRect ?? (draft ? { x: draft.at.x, y: draft.at.y, width: 0, height: 0 } : null);
  // Under the target, or over it when there is no room below.
  const boxTop = anchor ? anchor.y + view.top + anchor.height + 10 : 0;
  const boxStyle = anchor && {
    left: `${Math.max(8, Math.min(anchor.x + view.left, innerWidth - 348))}px`,
    ...(boxTop + 190 > innerHeight
      ? { bottom: `${Math.max(8, innerHeight - (anchor.y + view.top) + 10)}px` }
      : { top: `${boxTop}px` }),
  };
  const parent = draft ? feedback.parentOf(draft.target) : null;
  const count = feedback.notes.length;

  return (
    <div className="synergy-feedback">
      <div
        className={`fb-shield${draft?.pointing ? ' fb-pointing' : ''}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      />
      {feedback.notes.map((note) =>
        note.target.rect ? (
          <div key={note.id} className="fb-mark" style={place(note.target.rect, view)}>
            <span>{note.id}</span>
          </div>
        ) : (
          <div
            key={note.id}
            className="fb-mark fb-dot"
            style={{ left: `${note.at.x + view.left - 9}px`, top: `${note.at.y + view.top - 9}px` }}
          >
            <span>{note.id}</span>
          </div>
        ),
      )}
      {[...feedback.notes, ...(draft ? [draft] : [])].map((note, index) =>
        note.expected ? (
          <div
            key={`expected-${index}`}
            className="fb-expected"
            style={{ left: `${note.expected.x + view.left}px`, top: `${note.expected.y + view.top}px` }}
            title="Where it was expected"
          />
        ) : null,
      )}
      {shown && shownRect && <div className="fb-outline" style={place(shownRect, view)} />}
      {shown && !draft && (
        <div
          className="fb-chip"
          style={{
            left: `${Math.max(4, (shownRect?.x ?? 0) + view.left)}px`,
            top: `${Math.max(4, (shownRect ? shownRect.y - 24 : 4) + view.top)}px`,
          }}
        >
          {nameOf(shown)}
        </div>
      )}
      {draft?.pointing && <div className="fb-chip fb-hint">Click where it should be · Esc to cancel</div>}
      {draft && !draft.pointing && boxStyle && (
        <div className="fb-box" style={boxStyle}>
          <div className="fb-target" title={nameOf(draft.target)}>
            {nameOf(draft.target)}
          </div>
          <textarea
            ref={field}
            rows={3}
            placeholder="What should change? (Enter keeps the note, Shift+Enter for a new line)"
            value={draft.comment}
            onInput={(event) => setDraft({ ...draft, comment: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                keep();
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <div className="fb-row">
            <button
              type="button"
              title="Then click the place where this should be instead"
              onClick={() => setDraft({ ...draft, pointing: true })}
            >
              {draft.expected ? '⌖ Move the expected spot' : '⌖ Expected here…'}
            </button>
            {draft.expected && (
              <button
                type="button"
                title="Forget the expected spot"
                onClick={() => setDraft({ ...draft, expected: null })}
              >
                ✕ spot
              </button>
            )}
            {parent && (
              <button
                type="button"
                title="Pick what holds this instead: the element or GameObject around it"
                onClick={() => setDraft({ ...draft, target: parent })}
              >
                ↑ Parent
              </button>
            )}
            <span className="fb-spacer" />
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="fb-primary" onClick={keep}>
              Keep note
            </button>
          </div>
        </div>
      )}
      <div className={`fb-bar${onTop ? ' fb-top' : ''}`}>
        <strong>Feedback</strong>
        <span className="fb-dim">
          {count === 0 ? 'Click anything in the game to comment on it' : `${count} ${count === 1 ? 'note' : 'notes'}`}
        </span>
        <label title={`How much the prompt says about each thing. ${DETAIL_HINT[feedback.detail]}.`}>
          Context&nbsp;
          <select
            value={feedback.detail}
            onChange={(event) => {
              const chosen = FEEDBACK_DETAILS.find((detail) => detail === event.currentTarget.value);
              if (chosen) feedback.detail = chosen;
            }}
          >
            {FEEDBACK_DETAILS.map((detail) => (
              <option key={detail} value={detail}>
                {detail}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="fb-primary"
          disabled={count === 0 || busy}
          title="Save the notes with pictures to .reports/ and copy the prompt for your agent"
          onClick={() => {
            setBusy(true);
            void actions.copy().finally(() => setBusy(false));
          }}
        >
          {busy ? 'Saving…' : 'Copy prompt'}
        </button>
        <button type="button" disabled={count === 0} title="Forget every note" onClick={() => feedback.clear()}>
          Clear
        </button>
        <button
          type="button"
          title="Move this bar to the other edge, off what you want to click"
          onClick={() => {
            EditorPrefs.setBool('feedback.barOnTop', !onTop);
            setOnTop(!onTop);
          }}
        >
          {onTop ? '↓' : '↑'}
        </button>
        <button type="button" title="Back to the game; the notes are kept (F7)" onClick={actions.close}>
          Done
        </button>
      </div>
    </div>
  );
}
