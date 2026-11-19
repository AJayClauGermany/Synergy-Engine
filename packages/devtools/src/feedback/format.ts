import type { ViewPoint, ViewRect } from './pick';

/**
 * Feedback as plain data and as the prompt a person pastes into an agent. Nothing here
 * touches the page or the engine, so the wording can be tested as text.
 */

/**
 * How much of what was captured goes into the prompt. Everything is captured either way
 * (`feedback.json` in the report has all of it); this decides what an agent reads first.
 *
 * - `brief`: what was clicked, where its code is, the comment.
 * - `standard`: plus how it is laid out and styled, the components around it, a
 *   GameObject's script fields.
 * - `full`: plus the element's HTML, its siblings and ancestors, a GameObject's whole subtree.
 */
export type FeedbackDetail = 'brief' | 'standard' | 'full';

export const FEEDBACK_DETAILS: readonly FeedbackDetail[] = ['brief', 'standard', 'full'];

const RANK: Record<FeedbackDetail, number> = { brief: 0, standard: 1, full: 2 };

/** One line about a target: `Source: game/src/ui/App.tsx:44:7`. */
export interface Fact {
  readonly label: string;
  readonly value: string;
  /** The least detail at which it is shown. */
  readonly level: FeedbackDetail;
}

/** Several lines about a target, shown as a code block: its HTML, its hierarchy. */
export interface Block {
  readonly title: string;
  readonly text: string;
  /** The language of the code fence: `html`, `text`. */
  readonly lang: string;
  readonly level: FeedbackDetail;
}

/** What was clicked, described well enough to find it in the code without the game open. */
export interface TargetDescription {
  /** `HUD element`, `GameObject`, `UI image`, `Map cell` or `Empty space`. */
  readonly kind: string;
  /** A short name: `<h1.title> "Synergy"`, `Scout (2)`. */
  readonly label: string;
  /** Where it is in the game view, or `null` when it has no place there. */
  readonly rect: ViewRect | null;
  readonly facts: readonly Fact[];
  readonly blocks: readonly Block[];
}

/** One thing a person pointed at and what they said about it. */
export interface FeedbackNote {
  readonly id: number;
  readonly comment: string;
  /** Where they clicked, in the game view. */
  readonly at: ViewPoint;
  readonly target: TargetDescription;
  /** Where they said it should be instead, in the game view, or `null`. */
  readonly expected: ViewPoint | null;
}

/** The state of the game when the feedback was written. */
export interface FeedbackContext {
  readonly page: string;
  readonly scenes: readonly string[];
  readonly activeScene: string;
  readonly frame: number;
  readonly time: number;
  readonly paused: boolean;
  readonly view: { readonly width: number; readonly height: number };
  /** What the game added: the screen it is on, the player whose turn it is. */
  readonly extra: Readonly<Record<string, string>>;
}

export interface FormatOptions {
  readonly detail: FeedbackDetail;
  /** The report folder the images and the rest are in, when it was saved. */
  readonly folder?: string | null;
  /** Whether the report holds `feedback.png` and a close-up per note. */
  readonly images?: boolean;
}

const n = (value: number): string => String(Math.round(value));

function direction(dx: number, dy: number): string {
  const parts: string[] = [];
  if (Math.round(dx) !== 0) parts.push(`${n(Math.abs(dx))} px ${dx > 0 ? 'right' : 'left'}`);
  if (Math.round(dy) !== 0) parts.push(`${n(Math.abs(dy))} px ${dy > 0 ? 'down' : 'up'}`);
  return parts.join(' and ') || 'the same place';
}

/** `(x, y), W×H` for a rectangle in the view. */
export function formatRect(rect: ViewRect): string {
  return `left ${n(rect.x)}, top ${n(rect.y)}, ${n(rect.width)}×${n(rect.height)}`;
}

function fence(text: string, lang: string): string {
  // A fence longer than any run of backticks inside, so the block cannot end early.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function formatNote(note: FeedbackNote, { detail, folder, images }: FormatOptions): string {
  const shown = (level: FeedbackDetail) => RANK[level] <= RANK[detail];
  const { target } = note;
  const lines = [`## Note ${note.id}: ${target.kind} ${target.label}`.trimEnd(), ''];
  const comment = note.comment.trim() || '(no comment: the person only pointed at it)';
  lines.push(...comment.split('\n').map((line) => `> ${line}`), '');
  for (const fact of target.facts) if (shown(fact.level)) lines.push(`- ${fact.label}: ${fact.value}`);
  if (target.rect) lines.push(`- On screen: ${formatRect(target.rect)}`);
  lines.push(`- Clicked at: (${n(note.at.x)}, ${n(note.at.y)})`);
  if (note.expected) {
    const from = target.rect
      ? { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 }
      : note.at;
    const what = target.rect ? 'its centre now' : 'the click';
    lines.push(
      `- **Expected at: (${n(note.expected.x)}, ${n(note.expected.y)})**, ` +
        `${direction(note.expected.x - from.x, note.expected.y - from.y)} of ${what}. ` +
        'The person pointed by hand: treat it as "about here", and prefer the layout rule that puts it there ' +
        '(alignment, padding, an anchor) over a hard-coded offset.',
    );
  }
  if (images && folder) lines.push(`- Close-up: \`${folder}/note-${note.id}.png\``);
  for (const block of target.blocks) {
    if (shown(block.level)) lines.push('', `${block.title}:`, '', fence(block.text, block.lang));
  }
  return lines.join('\n');
}

/**
 * The prompt: every note with what it points at, and the state of the game around them.
 * It is written for an agent that has the code and not the game: each note says where to
 * look before it says what to change.
 */
export function formatFeedback(
  notes: readonly FeedbackNote[],
  context: FeedbackContext,
  options: FormatOptions,
): string {
  const { folder, images } = options;
  const count = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
  const lines = [
    `# Feedback on the running game (${count})`,
    '',
    'A person made these notes by clicking things in the game while it ran. Each note names what was ' +
      'clicked and where its code is: start there, not with a search. Positions are CSS pixels from the ' +
      `top-left of the game view, which was ${context.view.width}×${context.view.height}.`,
    '',
    '## Where the game was',
    '',
    `- Page: ${context.page}`,
    ...Object.entries(context.extra).map(([key, value]) => `- ${key}: ${value}`),
    `- Scenes: ${context.scenes.join(', ') || '(none)'} (active: ${context.activeScene})`,
    `- Frame ${context.frame}, game time ${context.time.toFixed(2)} s${context.paused ? ' (paused)' : ''}`,
  ];
  if (folder) {
    lines.push(
      images
        ? `- Pictures: \`${folder}/feedback.png\` is the view with each note's target outlined and numbered` +
            ' (an arrow points to where it was expected); `note-N.png` is a close-up of each.'
        : `- Report: \`${folder}\``,
      `- Also in \`${folder}\`: \`feedback.json\` (everything captured, at full detail), \`log.txt\`, ` +
        '`hierarchy.txt`, `hud.txt`.',
    );
  }
  for (const note of notes) lines.push('', formatNote(note, options));
  lines.push(
    '',
    '## Working from these notes',
    '',
    '- A HUD element\'s "Source" is the JSX that draws it; its styles are in the CSS that names its classes.',
    '- A GameObject is found by its name and its scripts: search `game/src` for the name in quotes, and each ' +
      'script is a class in a file of the same name.',
    '- When done, check the result the way it was reported: `bun run screenshot` on the same scene.',
    '',
  );
  return lines.join('\n');
}
