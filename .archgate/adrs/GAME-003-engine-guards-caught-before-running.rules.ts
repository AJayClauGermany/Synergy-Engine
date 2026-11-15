/// <reference path="../rules.d.ts" />

// Rule files cannot import helpers (archgate's sandbox), so the few they share are
// repeated in each file that needs them. Positions are kept: blanked text becomes spaces,
// so an offset into the result is an offset into the file.

/**
 * The source with comments and the contents of strings blanked, so that brackets and
 * operators found in the result are code. Regular-expression literals are not recognised.
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

/** Game code, not tests: the engine's own tests make these mistakes on purpose. */
async function gameSources(ctx: RuleContext): Promise<Source[]> {
  const files = (await ctx.glob('game/src/**/*.{ts,tsx}')).filter((file) => !/\.(test|spec)\.tsx?$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, code: codeOnly(await ctx.readFile(file)) })));
}

/** Calls that look up a component on the object the script is on. */
const LOOKUP =
  /=\s*this\.(?:gameObject\.)?(getComponents?(?:InChildren|InParent)?)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(\s*([A-Za-z_$][\w$]*)?/g;

/** What turns a number into a whole one, for a cell or an integer vector. */
const WHOLE = /\b(?:Math\.(?:trunc|floor|ceil|round)|Mathf\.(?:floorToInt|ceilToInt|roundToInt))\s*\(/;

export default {
  rules: {
    'no-component-lookups-in-field-initialisers': {
      description: 'A script looks up other components in awake() or start(), never in a field initialiser',
      async check(ctx) {
        for (const { file, code } of await gameSources(ctx)) {
          for (const cls of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{;]*?\bextends\b[^{;]*\{/g)) {
            const open = cls.index + cls[0].length - 1;
            const close = closing(code, open);
            if (close < 0) continue;
            const body = code.slice(open + 1, close);
            // A component the class requires is added before the script, so a field may look it up.
            const required =
              /\bstatic\s+(?:readonly\s+)?requireComponents\b[^=]*=\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '';
            const requiredNames = new Set(required.split(',').map((name) => name.trim()));
            // Depth inside the class body: 0 is where fields and method heads are.
            const depth: number[] = [];
            let level = 0;
            for (const ch of body) {
              if (ch === ')' || ch === ']' || ch === '}') level--;
              depth.push(level);
              if (ch === '(' || ch === '[' || ch === '{') level++;
            }
            for (const lookup of body.matchAll(LOOKUP)) {
              if (depth[lookup.index] !== 0) continue;
              const type = lookup[2] ?? '';
              if (requiredNames.has(type)) continue;
              ctx.report.violation({
                message:
                  `${cls[1]}: ${lookup[1]}(${type}) runs in a field initialiser, before the other components of the ` +
                  'GameObject exist. The engine throws when the script is added.',
                file,
                line: lineAt(code, open + 1 + lookup.index),
                fix: `Declare the field (private body: ${type || 'Component'} | null = null;) and set it in awake(): this.body = this.${lookup[1]}(${type});`,
              });
            }
          }
        }
      },
    },

    'prefabs-build-onto-their-instance': {
      description: "A Prefab's build function adds to the GameObject it is given; it does not make and return its own",
      async check(ctx) {
        for (const { file, code } of await gameSources(ctx)) {
          for (const prefab of code.matchAll(/\bnew\s+(?:Network)?Prefab\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(/g)) {
            const open = prefab.index + prefab[0].length - 1;
            const close = closing(code, open);
            if (close < 0) continue;
            const args = code.slice(open + 1, close);
            const noParameter = /,\s*(?:async\s+)?(?:\(\s*\)\s*=>|function\s*[\w$]*\s*\(\s*\))/.test(args);
            const made = /\bnew\s+GameObject\s*\(|\bGameObject\.createPrimitive\s*\(/.test(args);
            const returnsArrow = /=>\s*new\s+GameObject\s*\(/.test(args);
            const own = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+GameObject\s*\(/.exec(args)?.[1];
            const returnsOwn = own !== undefined && new RegExp(`\\breturn\\s+${own}\\b`).test(args);
            if (!(noParameter && made) && !returnsArrow && !returnsOwn) continue;
            ctx.report.violation({
              message:
                'This build function makes a GameObject of its own, as a Unity factory method would. instantiate() ' +
                'hands build the new instance to fill, and throws when build returns another object.',
              file,
              line: lineAt(code, prefab.index),
              fix: "new Prefab('Enemy', (go) => { go.addComponent(Enemy); }): add components and children to `go`.",
            });
          }
        }
      },
    },

    'integer-vectors-get-whole-numbers': {
      description:
        'A division inside new Vector2Int/Vector3Int(...) is made whole with Math.trunc, floor, ceil or round',
      async check(ctx) {
        for (const { file, code } of await gameSources(ctx)) {
          for (const vector of code.matchAll(/\bnew\s+(Vector[23]Int)\s*\(/g)) {
            const open = vector.index + vector[0].length - 1;
            const close = closing(code, open);
            if (close < 0) continue;
            // Take out every part already made whole, then look for a division in what is left.
            let args = code.slice(open + 1, close);
            for (let whole = WHOLE.exec(args); whole; whole = WHOLE.exec(args)) {
              const start = whole.index + whole[0].length - 1;
              const end = closing(args, start);
              args = args.slice(0, whole.index) + (end < 0 ? '' : args.slice(end + 1));
            }
            if (!args.includes('/')) continue;
            ctx.report.violation({
              message:
                `A division inside new ${vector[1]}(...): in C# 7 / 2 is 3, here it is 3.5, and an integer vector ` +
                'refuses a fraction when the game runs.',
              file,
              line: lineAt(code, vector.index),
              fix: "Say how to round: Math.trunc(a / b) is C#'s integer division; Math.floor rounds down for negatives too.",
            });
          }
        }
      },
    },
  },
} satisfies RuleSet;
