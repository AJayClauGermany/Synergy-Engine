/// <reference path="../rules.d.ts" />

// Rule files cannot import helpers (archgate's sandbox), so the few they share are
// repeated in each file that needs them. Positions are kept: a blanked comment becomes
// spaces, so an offset into the result is an offset into the file.

/** The source with its comments blanked. String contents are kept: attribute values are strings. */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 2;
      const stop = end <= 1 || end < i ? source.length : end;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && (ch === '`' || source[j] !== '\n'))
        j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

interface Tag {
  name: string;
  /** The opening tag's attributes, as written: `type="text" onChange={...}`. */
  attributes: string;
  offset: number;
}

/**
 * Every opening tag of an HTML element (lower-case name) in a .tsx file. An attribute
 * value in braces may hold any code, `>` and `=>` included, so the tag ends at the first
 * `>` outside braces and quotes.
 */
function elements(code: string): Tag[] {
  const tags: Tag[] = [];
  for (const open of code.matchAll(/<([a-z][\w-]*)(?=[\s/>])/g)) {
    let depth = 0;
    let quote = '';
    let end = open.index + open[0].length;
    for (; end < code.length; end++) {
      const ch = code[end] ?? '';
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push({ name: open[1] ?? '', attributes: code.slice(open.index + open[0].length, end), offset: open.index });
  }
  return tags;
}

/** The value of a plain attribute (`type="text"`), or null when it is absent or computed. */
function attribute(attributes: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${name}=(['"])([^'"]*)\\1`).exec(attributes)?.[2] ?? null;
}

/**
 * What `mountUI` lets the pointer reach (packages/ui/src/mount.tsx): the overlay ignores
 * the pointer, so the game underneath stays clickable, and these opt back in.
 */
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'option']);
const POINTER =
  /(?:^|\s)(on(?:Click|DblClick|ContextMenu|MouseDown|MouseUp|PointerDown|PointerUp|Wheel|TouchStart|TouchEnd))\s*=/;
/** Inputs whose change event waits for the field to lose focus. */
const TEXT_TYPES = new Set(['text', 'search', 'email', 'password', 'number', 'tel', 'url']);

async function hudFiles(ctx: RuleContext): Promise<{ file: string; code: string }[]> {
  const files = (await ctx.glob('game/src/**/*.tsx')).filter((file) => !/\.(test|spec)\.tsx$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, code: withoutComments(await ctx.readFile(file)) })));
}

export default {
  rules: {
    'text-fields-update-on-input': {
      description: 'Text fields read what is typed with onInput; Preact onChange fires only when the field loses focus',
      async check(ctx) {
        for (const { file, code } of await hudFiles(ctx)) {
          for (const tag of elements(code)) {
            if (tag.name !== 'textarea' && tag.name !== 'input') continue;
            if (!/(?:^|\s)onChange\s*=/.test(tag.attributes)) continue;
            const type = tag.name === 'input' ? (attribute(tag.attributes, 'type') ?? 'text') : 'text';
            if (!TEXT_TYPES.has(type)) continue;
            ctx.report.violation({
              message:
                `onChange on a text <${tag.name}>: Preact passes it to the DOM's change event, which fires when the ` +
                "field loses focus, not on each key as React's does. The HUD lags one edit behind what is typed.",
              file,
              line: lineAt(code, tag.offset),
              fix: 'onInput={(event) => setValue(event.currentTarget.value)}',
            });
          }
        }
      },
    },

    'pointer-handlers-are-interactive': {
      description: 'An element other than a control that handles clicks or pointer events carries data-interactive',
      async check(ctx) {
        for (const { file, code } of await hudFiles(ctx)) {
          for (const tag of elements(code)) {
            if (INTERACTIVE.has(tag.name) || /(?:^|\s)data-interactive\b/.test(tag.attributes)) continue;
            const handler = POINTER.exec(tag.attributes)?.[1];
            if (!handler) continue;
            ctx.report.violation({
              message:
                `<${tag.name} ${handler}=...> without data-interactive: the HUD overlay lets the pointer through to the ` +
                'game, so this handler may never run and the click lands on the board underneath.',
              file,
              line: lineAt(code, tag.offset),
              fix: `Use a <button type="button">, or add data-interactive to this <${tag.name}>.`,
            });
          }
        }
      },
    },
  },
} satisfies RuleSet;
