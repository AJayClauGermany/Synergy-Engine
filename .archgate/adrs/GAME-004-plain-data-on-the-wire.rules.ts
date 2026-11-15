/// <reference path="../rules.d.ts" />

// Rule files cannot import helpers (archgate's sandbox), so the few they share are
// repeated in each file that needs them. Positions are kept: blanked text becomes spaces,
// so an offset into the result is an offset into the file.

/**
 * The source with comments and the contents of strings blanked, so that brackets and
 * names found in the result are code. Regular-expression literals are not recognised.
 */
function codeOnly(source: string): string {
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
      out += ch + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + source.slice(j, j + 1);
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

/** The offset of the bracket that closes the one at `open`, or -1. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Source {
  file: string;
  code: string;
}

/** Game code, not tests: tests send refused values on purpose, to see them refused. */
async function gameSources(ctx: RuleContext): Promise<Source[]> {
  const files = (await ctx.glob('game/src/**/*.{ts,tsx}')).filter((file) => !/\.(test|spec)\.tsx?$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, code: codeOnly(await ctx.readFile(file)) })));
}

interface Declaration {
  name: string;
  file: string;
  line: number;
  /** The declaration's body: from its `{` or `=` to its end. */
  text: string;
}

/** `interface Name { ... }` and `type Name = ...;` declared anywhere in the game. */
function declarations(sources: readonly Source[]): Map<string, Declaration> {
  const found = new Map<string, Declaration>();
  for (const { file, code } of sources) {
    // At the start of a line, so that `import { type Cell }` is not taken for a declaration.
    for (const match of code.matchAll(
      /^[ \t]*(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)\b(?![ \t]*,)[^\n={;]*?([{=])/gm,
    )) {
      const keyword = match.index + match[0].indexOf(match[1] ?? '');
      const start = match.index + match[0].length - 1;
      let end = start;
      if (match[1] === 'interface') end = closing(code, start);
      else {
        // A type alias ends at the first `;` (or blank line) outside brackets.
        let depth = 0;
        for (end = start + 1; end < code.length; end++) {
          const ch = code[end];
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          else if (ch === ')' || ch === ']' || ch === '}') depth--;
          else if (depth === 0 && (ch === ';' || code.startsWith('\n\n', end))) break;
        }
      }
      const name = match[2] ?? '';
      if (end > start && !found.has(name)) {
        found.set(name, { name, file, line: lineAt(code, keyword), text: code.slice(start, end + 1) });
      }
    }
  }
  return found;
}

/** Types JSON does not carry as they are: a class arrives without its methods, a Map or Set empty. */
const NOT_PLAIN =
  /\b(Map|Set|WeakMap|WeakSet|ReadonlyMap|ReadonlySet|Date|RegExp|Vector2|Vector3|Vector4|Vector2Int|Vector3Int|Quaternion|Color|Bounds|BoundsInt|Rect|GameObject|Transform|Component|MonoBehaviour|bigint|symbol)\b|=>/;

/**
 * The first part of `text` (and of the game's own types it names, followed through) that
 * JSON would change, as a path such as `Command > Order > Vector3`; null when all of it is plain.
 */
function notPlain(
  text: string,
  types: ReadonlyMap<string, Declaration>,
  path: string[],
  seen = new Set<string>(),
): { path: string[]; declaration: Declaration | null } | null {
  const own = NOT_PLAIN.exec(text);
  if (own) return { path: [...path, own[1] ?? 'a function'], declaration: null };
  for (const name of text.matchAll(/\b[A-Z][\w$]*\b/g)) {
    const declaration = types.get(name[0]);
    if (!declaration || seen.has(declaration.name)) continue;
    seen.add(declaration.name);
    const inner = notPlain(declaration.text, types, [...path, declaration.name], seen);
    if (inner) return { path: inner.path, declaration: inner.declaration ?? declaration };
  }
  return null;
}

const SERIALIZERS =
  'pass a serializer (new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 })), or send the numbers';

export default {
  rules: {
    'commands-are-plain-data': {
      description:
        'The command type a session carries is made of numbers, strings, booleans, null, arrays and plain objects',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const types = declarations(sources);
        const reported = new Set<string>();
        for (const { code } of sources) {
          const sessions =
            /\b(?:CommandSession(?:\.(?:host|join|local))?|openSession|Session)\s*<\s*([A-Za-z_$][\w$]*)\s*>/g;
          for (const match of code.matchAll(sessions)) {
            const command = types.get(match[1] ?? '');
            if (!command || reported.has(command.name)) continue;
            reported.add(command.name);
            const found = notPlain(command.text, types, [command.name]);
            if (!found) continue;
            const at = found.declaration ?? command;
            ctx.report.violation({
              message:
                `${found.path.join(' > ')}: a command is sent to every player as JSON, and session.submit() refuses ` +
                `a value JSON would change, when the game runs.`,
              file: at.file,
              line: at.line,
              fix: 'Use plain data: a cell is { x: number; y: number }, an object is referred to by its id, a set is an array.',
            });
          }
        }
      },
    },

    'rpc-arguments-are-plain-data': {
      description:
        'serverRpc and clientRpc handlers take plain data: numbers, strings, booleans, arrays and plain objects',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const types = declarations(sources);
        for (const { file, code } of sources) {
          for (const match of code.matchAll(
            /\bthis\.(serverRpc|clientRpc)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(\s*(?:async\s+)?\(/g,
          )) {
            const open = match.index + match[0].length - 1;
            const close = closing(code, open);
            if (close < 0) continue;
            const found = notPlain(code.slice(open + 1, close), types, ['argument']);
            if (!found) continue;
            ctx.report.violation({
              message:
                `This ${match[1]} takes ${found.path.join(' > ')}. Arguments travel as JSON, so it would arrive as a ` +
                'plain object without its methods (or empty); the call is refused when the game runs.',
              file,
              line: lineAt(code, match.index),
              fix: 'Send the numbers: (x: number, y: number) for a cell, (targetId: number) for another object.',
            });
          }
        }
      },
    },

    'network-variables-are-plain-or-serialized': {
      description: 'A NetworkVariable or NetworkList without a serializer holds only values JSON keeps as they are',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const types = declarations(sources);
        for (const { file, code } of sources) {
          for (const match of code.matchAll(
            /\bnew\s+(NetworkVariable|NetworkList)\s*(<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(/g,
          )) {
            const open = match.index + match[0].length - 1;
            const close = closing(code, open);
            if (close < 0) continue;
            const args = code.slice(open + 1, close);
            if (/\bserializer\b/.test(args)) continue;
            const initial =
              /^\s*(?:new\s+)?(Vector[234](?:Int)?|Quaternion|Color|Map|Set|Date)\b|^\s*-?(Infinity|NaN)\b|^\s*Number\.(POSITIVE_INFINITY|NEGATIVE_INFINITY|NaN)\b/.exec(
                args,
              );
            const typed = match[2] ? notPlain(match[2].slice(1, -1), types, ['its type']) : null;
            if (!initial && !typed) continue;
            const what = initial
              ? `starts as ${initial[1] ?? initial[2] ?? initial[3]}`
              : `is declared to hold ${typed?.path.slice(1).join(' > ')}`;
            ctx.report.violation({
              message: `This ${match[1]} ${what}, which JSON would change on its way to the clients. The engine refuses it when the game runs.`,
              file,
              line: lineAt(code, match.index),
              fix: `Hold plain data, or ${SERIALIZERS}.`,
            });
          }
        }
      },
    },
  },
} satisfies RuleSet;
