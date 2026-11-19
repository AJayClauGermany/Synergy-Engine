/**
 * Writes where each JSX element was written into the element, for development builds:
 *
 *   <h1 class="title">Skirmish</h1>
 *   <h1 class="title" data-source="game/src/ui/Menu.tsx:42:7">Skirmish</h1>
 *
 * The feedback tool of the devtools (F7, `docs/devtools.md`) reads it back from the
 * element someone clicked, so a note about "the title" names the file and line that draw
 * it. Bun's own JSX transform leaves the source position out, so this does it as a
 * bundler plugin: `bunfig.toml` loads it for `bun run dev`, `scripts/build.ts` for a
 * build with `--devtools`. A release build never runs it.
 *
 * Elements (`<div>`) get the attribute in the page. Components (`<Button>`) get it as a
 * prop, which the tool reads from Preact's tree: that is the place a component is used,
 * where the element inside it says where it is defined.
 */
import path from 'node:path';
import type { BunPlugin } from 'bun';
import { parseSync } from 'oxc-parser';

/** The attribute and prop that hold `file:line:column` (1-based, as editors count). */
export const SOURCE_ATTRIBUTE = 'data-source';

const root = path.resolve(import.meta.dir, '..');

interface OpeningElement {
  readonly type: 'JSXOpeningElement';
  readonly start: number;
  readonly end: number;
  readonly name: { readonly type: string; readonly name?: string };
  readonly attributes: readonly { readonly type: string; readonly name?: { readonly name?: unknown } }[];
}

function isOpeningElement(node: object): node is OpeningElement {
  return (node as { type?: unknown }).type === 'JSXOpeningElement';
}

function collect(node: unknown, found: OpeningElement[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (isOpeningElement(node)) found.push(node);
  for (const value of Object.values(node)) collect(value, found);
}

/**
 * Returns `code` with a `data-source` attribute on every JSX element. `file` is the path
 * written into it (relative to the project, so an agent can open it as it is). Code that
 * does not parse is returned unchanged: the bundler then reports the error on the real file.
 */
export function stampJsxSource(code: string, file: string): string {
  if (!code.includes('<')) return code;
  const parsed = parseSync(file, code);
  if (parsed.errors.length > 0) return code;
  const elements: OpeningElement[] = [];
  collect(parsed.program, elements);

  // Line starts, to turn an offset into line:column.
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const position = (offset: number): string => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return `${low + 1}:${offset - (lineStarts[low] ?? 0) + 1}`;
  };

  const insertions: { at: number; text: string }[] = [];
  for (const element of elements) {
    // A Fragment takes only `key`; one written by hand keeps what it was given.
    if (element.name.type === 'JSXIdentifier' && element.name.name === 'Fragment') continue;
    if (element.attributes.some((attribute) => attribute.name?.name === SOURCE_ATTRIBUTE)) continue;
    // After the last attribute, so `{...props}` cannot replace it: before `>` or `/>`.
    let at = element.end - 1;
    while (at > element.start && /\s/.test(code[at - 1] ?? '')) at--;
    if (code[at - 1] === '/') at--;
    while (at > element.start && /\s/.test(code[at - 1] ?? '')) at--;
    insertions.push({ at, text: ` ${SOURCE_ATTRIBUTE}="${file}:${position(element.start)}"` });
  }
  if (insertions.length === 0) return code;
  insertions.sort((a, b) => a.at - b.at);
  let out = '';
  let from = 0;
  for (const { at, text } of insertions) {
    out += code.slice(from, at) + text;
    from = at;
  }
  return out + code.slice(from);
}

/**
 * The plugin: the game's and the HUD helpers' `.tsx` files. The editor's own panels are
 * left alone, since nobody gives feedback on those through the tool.
 */
const jsxSource: BunPlugin = {
  name: 'synergy-jsx-source',
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const file = path.relative(root, args.path).split(path.sep).join('/');
      const code = await Bun.file(args.path).text();
      const skip = file.startsWith('..') || file.includes('node_modules/') || file.startsWith('packages/devtools/');
      return { contents: skip ? code : stampJsxSource(code, file), loader: 'tsx' };
    });
  },
};

export default jsxSource;
