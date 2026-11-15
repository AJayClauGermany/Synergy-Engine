/// <reference path="../rules.d.ts" />

// Rule files cannot import helpers (archgate's sandbox), so the few they share are
// repeated in each file that needs them. Positions are kept: a blanked comment becomes
// spaces, so an offset into the result is an offset into the file.

/** The source with its comments blanked. String contents are kept: they hold the names. */
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

interface Source {
  file: string;
  code: string;
}

async function read(ctx: RuleContext, pattern: string): Promise<Source[]> {
  const files = await ctx.glob(pattern);
  return Promise.all(files.map(async (file) => ({ file, code: withoutComments(await ctx.readFile(file)) })));
}

const isTest = (file: string) => /\.(test|spec)\.tsx?$/.test(file);

/** The repository paths a file imports by relative path, with the extension each has. */
function imports(file: string, code: string, existing: ReadonlySet<string>): string[] {
  const folder = file.split('/').slice(0, -1);
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const parts = [...folder];
    for (const part of (match[1] ?? '').split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    const base = parts.join('/');
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => existing.has(candidate));
    if (hit) found.push(hit);
  }
  return found;
}

type Kind = 'palette' | 'map';

/** What a JSON file is, by its shape (docs/tilemaps.md): a tile palette, a tile map, or neither. */
function kindOf(data: unknown): Kind | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const all = (list: unknown, key: string) =>
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((item) => typeof item === 'object' && item !== null && key in item);
  if (all(record.tiles, 'id')) return 'palette';
  if (all(record.layers, 'tiles')) return 'map';
  return null;
}

const CHECKER: Record<Kind, string> = { palette: 'checkTilePaletteData', map: 'checkTilemapData' };

export default {
  rules: {
    'shipped-content-is-checked': {
      description: 'Every tile palette and tile map the game ships is run through its check by a test',
      async check(ctx) {
        const json = (await ctx.glob('game/**/*.json')).filter(
          (file) => !/(^|\/)(package|tsconfig[^/]*)\.json$/.test(file),
        );
        const sources = await read(ctx, 'game/**/*.{ts,tsx}');
        const existing = new Set([...sources.map((source) => source.file), ...json]);
        const importsOf = new Map(sources.map((source) => [source.file, imports(source.file, source.code, existing)]));
        const tests = sources.filter((source) => isTest(source.file));

        for (const file of json) {
          let kind: Kind | null = null;
          try {
            kind = kindOf(await ctx.readJSON(file));
          } catch {
            continue; // Not JSON that parses: a test of its own reports that better.
          }
          if (!kind) continue;
          // The file itself, and the modules that import it (frontier/rules.ts imports map.json).
          const carriers = new Set([
            file,
            ...sources.filter((s) => importsOf.get(s.file)?.includes(file)).map((s) => s.file),
          ]);
          const checked = tests.some(
            (test) =>
              new RegExp(`\\b${CHECKER[kind]}\\(`).test(test.code) &&
              (importsOf.get(test.file) ?? []).some((target) => carriers.has(target)),
          );
          if (checked) continue;
          ctx.report.violation({
            message:
              `${file} is a tile ${kind} the game ships, and no test runs ${CHECKER[kind]} over it. A wrong tile id ` +
              'or a miscounted row would show up as a blank tile instead of a failing test.',
            file,
            fix: `In game/test/content.test.ts: import it (or the module that loads it) and expect(${CHECKER[kind]}(...)).toEqual([]).`,
          });
        }
      },
    },

    'command-variants-are-tested': {
      description: "Every variant of the command type a session carries is named in a test (type: '...')",
      async check(ctx) {
        const sources = await read(ctx, 'game/**/*.{ts,tsx}');
        const game = sources.filter((source) => !isTest(source.file));
        const testText = sources
          .filter((source) => isTest(source.file))
          .map((source) => source.code)
          .join('\n');

        const commands = new Set<string>();
        for (const { code } of game) {
          const sessions =
            /\b(?:CommandSession(?:\.(?:host|join|local))?|openSession|Session)\s*<\s*([A-Za-z_$][\w$]*)\s*>/g;
          for (const match of code.matchAll(sessions)) commands.add(match[1] ?? '');
        }
        for (const name of commands) {
          // `type Command = | { type: 'move'; ... } | MoveCommand ...`: the variants written in the
          // union, and those of the interfaces it names.
          const declaration = new RegExp(`^[ \\t]*(?:export\\s+)?type\\s+${name}\\b(?![ \\t]*,)[^\\n=]*=`, 'm');
          const home = game.find((source) => declaration.test(source.code));
          if (!home) continue;
          const start = home.code.search(declaration);
          // The union ends at the first `;` outside its object types: `{ type: 'move'; unit: number }`.
          let end = start;
          for (let depth = 0; end < home.code.length; end++) {
            const ch = home.code[end];
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
            else if (ch === ';' && depth === 0) break;
          }
          const union = home.code.slice(start, end);
          const parts = [{ file: home.file, code: home.code, offset: start, text: union }];
          for (const member of union.matchAll(/\|\s*([A-Z][\w$]*)\b/g)) {
            const named = new RegExp(
              `^[ \\t]*(?:export\\s+)?interface\\s+${member[1]}\\b(?![ \\t]*,)[^\\n{]*\\{[^}]*\\}`,
              'm',
            );
            for (const source of game) {
              const found = named.exec(source.code);
              if (found) parts.push({ file: source.file, code: source.code, offset: found.index, text: found[0] });
            }
          }
          for (const part of parts) {
            for (const variant of part.text.matchAll(/\btype\s*[?]?:\s*(['"])([^'"]+)\1/g)) {
              const type = variant[2] ?? '';
              if (new RegExp(`\\btype\\s*:\\s*['"]${type}['"]`).test(testText)) continue;
              ctx.report.violation({
                message:
                  `Command '${type}' (${name}) is not named in any test under game/. The type check makes sure check() ` +
                  'and apply() handle it, not that they handle it right: a wrong rule plays wrong for every player, and nothing fails.',
                file: part.file,
                line: lineAt(part.code, part.offset + (variant.index ?? 0)),
                fix: `Add a rule test (game/test/): expect(check(state, { type: '${type}', ... }, player)).toBeNull(), then what apply() changes.`,
              });
            }
          }
        }
      },
    },
  },
} satisfies RuleSet;
