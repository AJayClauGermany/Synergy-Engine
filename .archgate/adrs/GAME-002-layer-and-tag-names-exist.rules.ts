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

/** Game code, not tests: a test may look up a name on purpose to see it fail. */
async function gameSources(ctx: RuleContext): Promise<Source[]> {
  const files = (await ctx.glob('game/src/**/*.{ts,tsx}')).filter((file) => !/\.(test|spec)\.tsx?$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, code: withoutComments(await ctx.readFile(file)) })));
}

interface Use {
  name: string;
  file: string;
  line: number;
}

/** The quoted names in each call matching `call`, which must end at the opening parenthesis. */
function namesIn(sources: readonly Source[], call: RegExp): Use[] {
  const found: Use[] = [];
  for (const { file, code } of sources) {
    for (const match of code.matchAll(call)) {
      const close = code.indexOf(')', match.index + match[0].length);
      const args = code.slice(match.index + match[0].length, close < 0 ? undefined : close);
      for (const name of args.matchAll(/(['"`])([^'"`\n]*)\1/g)) {
        found.push({ name: name[2] ?? '', file, line: lineAt(code, match.index) });
      }
    }
  }
  return found;
}

/** Unity's built-in layers, which the engine names too (packages/engine/src/physics/Physics.ts). */
const BUILT_IN_LAYERS = ['Default', 'TransparentFX', 'Ignore Raycast', 'Water', 'UI'];
/** Unity's built-in tags. `Untagged` is every GameObject's tag until one is set. */
const BUILT_IN_TAGS = ['Untagged', 'MainCamera', 'Player', 'Respawn', 'Finish', 'EditorOnly', 'GameController'];

export default {
  rules: {
    'layers-are-defined': {
      description:
        'Every layer named in LayerMask.nameToLayer or LayerMask.getMask is given an index with LayerMask.define',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const defined = new Map<string, Use>();
        for (const { file, code } of sources) {
          for (const match of code.matchAll(/\bLayerMask\.define\(\s*(\d+)\s*,\s*(['"`])([^'"`\n]*)\2/g)) {
            const index = Number(match[1]);
            const line = lineAt(code, match.index);
            if (index > 31) {
              ctx.report.violation({
                message: `Layer index ${index} is out of range: there are 32 layers, 0 to 31. LayerMask.define throws for it when the game runs.`,
                file,
                line,
                fix: 'Use a free index from 6 to 31; 0, 1, 2, 4 and 5 are the built-in layers.',
              });
            }
            defined.set(match[3] ?? '', { name: match[3] ?? '', file, line });
          }
        }
        const known = [...BUILT_IN_LAYERS, ...defined.keys()];
        for (const use of namesIn(sources, /\bLayerMask\.(?:nameToLayer|getMask)\(/g)) {
          if (known.includes(use.name)) continue;
          ctx.report.violation({
            message:
              `Layer "${use.name}" is never defined. nameToLayer gives -1 for it and getMask throws, when the game runs. ` +
              `Known layers: ${known.map((name) => `"${name}"`).join(', ')}.`,
            file: use.file,
            line: use.line,
            fix: `Define it once where the game starts: LayerMask.define(8, '${use.name}').`,
          });
        }
      },
    },

    'looked-up-tags-are-assigned': {
      description: 'Every tag the game looks up is assigned to some GameObject, and no two tags differ only in case',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const assigned: Use[] = [];
        for (const { file, code } of sources) {
          for (const match of code.matchAll(/\.tag\s*=\s*(['"`])([^'"`\n]*)\1/g)) {
            assigned.push({ name: match[2] ?? '', file, line: lineAt(code, match.index) });
          }
        }
        const looked = namesIn(sources, /\b(?:findWithTag|findGameObjectsWithTag|compareTag)\(/g);
        const lower = new Set(assigned.map((use) => use.name.toLowerCase()));

        for (const use of looked) {
          // A spelling that differs only in case is reported once, below.
          if (use.name === 'Untagged' || lower.has(use.name.toLowerCase())) continue;
          ctx.report.violation({
            message: `Tag "${use.name}" is looked up here but no code in game/src sets it, so the lookup always finds nothing.`,
            file: use.file,
            line: use.line,
            fix: `Set it where the object is made: go.tag = '${use.name}' (in its Prefab or scene builder).`,
          });
        }

        // 'mainCamera' next to 'MainCamera': one of them is a typo the game cannot see. The
        // built-in spelling wins, then the first one in the code.
        const spelled = new Map<string, string>();
        for (const name of [...BUILT_IN_TAGS, ...assigned.map((a) => a.name), ...looked.map((l) => l.name)]) {
          if (!spelled.has(name.toLowerCase())) spelled.set(name.toLowerCase(), name);
        }
        for (const use of [...assigned, ...looked]) {
          const first = spelled.get(use.name.toLowerCase());
          if (first === undefined || first === use.name) continue;
          ctx.report.violation({
            message: `Tag "${use.name}" differs from "${first}" only in case. Tags are compared exactly, so these are two different tags.`,
            file: use.file,
            line: use.line,
            fix: `Write "${first}".`,
          });
        }
      },
    },
  },
} satisfies RuleSet;
