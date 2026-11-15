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

/** A quoted literal's value, or null for anything else. */
function literal(expression: string): string | null {
  return /^(['"`])([^'"`]*)\1$/.exec(expression.trim())?.[2] ?? null;
}

interface Source {
  file: string;
  code: string;
}

/** Game code, not tests: tests register throwaway scenes of their own on purpose. */
async function gameSources(ctx: RuleContext): Promise<Source[]> {
  const files = (await ctx.glob('game/src/**/*.{ts,tsx}')).filter((file) => !/\.(test|spec)\.tsx?$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, code: withoutComments(await ctx.readFile(file)) })));
}

/** `const NAME = 'Value'` anywhere in the game, so `loadScene(FRONTIER_SCENE)` is read as 'Frontier'. */
function constants(sources: readonly Source[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { code } of sources) {
    for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])([^'"`\n]*)\2/g)) {
      found.set(match[1] ?? '', match[3] ?? '');
    }
  }
  return found;
}

/** The scene name an argument stands for: a literal, a known constant, or null (a variable). */
function sceneName(argument: string, names: ReadonlyMap<string, string>): string | null {
  return literal(argument) ?? names.get(argument.trim()) ?? null;
}

interface Registration {
  name: string;
  builder: string | null;
  file: string;
  line: number;
}

function registrations(sources: readonly Source[], names: ReadonlyMap<string, string>): Registration[] {
  const found: Registration[] = [];
  for (const { file, code } of sources) {
    for (const match of code.matchAll(/\bSceneManager\.register\(\s*([^,()]+?)\s*,\s*([A-Za-z_$][\w$]*)?/g)) {
      const name = sceneName(match[1] ?? '', names);
      if (name === null) continue;
      found.push({ name, builder: match[2] ?? null, file, line: lineAt(code, match.index) });
    }
  }
  return found;
}

/** Relative imports of a file, as repository paths (with the extension the file has). */
function relativeImports(file: string, code: string, existing: ReadonlySet<string>): string[] {
  const folder = file.split('/').slice(0, -1);
  const found: string[] = [];
  for (const match of code.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
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

const MAIN_CAMERA = /\.tag\s*=\s*(['"`])MainCamera\1/;
const LIGHT = /\baddComponent\(\s*Light\s*\)/;

export default {
  rules: {
    'loaded-scenes-are-registered': {
      description: 'Every scene name the game loads is registered with SceneManager.register under that exact name',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const names = constants(sources);
        const registered = new Set(registrations(sources, names).map((registration) => registration.name));
        for (const { file, code } of sources) {
          for (const match of code.matchAll(/\bloadScene\(\s*([^,()]+?)\s*[,)]/g)) {
            const name = sceneName(match[1] ?? '', names);
            if (name === null || registered.has(name)) continue;
            const known = [...registered].map((each) => `"${each}"`).join(', ') || 'none';
            ctx.report.violation({
              message:
                `Scene "${name}" is loaded here but nothing in game/src registers it, so the load fails when the game runs. ` +
                `Registered scenes: ${known}.`,
              file,
              line: lineAt(code, match.index),
              fix: `Register it at boot (game/src/main.tsx): SceneManager.register('${name}', buildScene), or load one of the names above.`,
            });
          }
        }
      },
    },

    'scenes-have-a-main-camera-and-a-light': {
      description:
        'The file that builds each registered scene (or a file it imports) tags a camera MainCamera and adds a Light',
      async check(ctx) {
        const sources = await gameSources(ctx);
        const byFile = new Map(sources.map((source) => [source.file, source.code]));
        const existing = new Set(byFile.keys());
        for (const registration of registrations(sources, constants(sources))) {
          // The file that defines the builder; an inline builder is defined where it is registered.
          const definition = registration.builder
            ? new RegExp(`\\b(?:const|let|var|function)\\s+${registration.builder}\\b`)
            : null;
          const home = definition
            ? sources.find((source) => definition.test(source.code))
            : sources.find((source) => source.file === registration.file);
          if (!home) continue;
          // The camera or the light may come from a helper the scene file imports.
          const reachable = [
            home.code,
            ...relativeImports(home.file, home.code, existing).map((f) => byFile.get(f) ?? ''),
          ];
          const missing = [
            reachable.some((code) => MAIN_CAMERA.test(code))
              ? null
              : "a camera tagged 'MainCamera' (Camera.main is null without it: mouse picking, onMouseDown() and WorldAnchor stop working)",
            reachable.some((code) => LIGHT.test(code))
              ? null
              : 'a Light (without one, objects show only the ambient light)',
          ].filter((part): part is string => part !== null);
          if (missing.length === 0) continue;
          ctx.report.violation({
            message: `Scene "${registration.name}" (built in ${home.file}) has no ${missing.join(', and no ')}. The game only warns about this when it runs.`,
            file: home.file,
            fix: "const camera = new GameObject('Main Camera'); camera.tag = 'MainCamera'; camera.addComponent(Camera); new GameObject('Sun').addComponent(Light);",
          });
        }
      },
    },
  },
} satisfies RuleSet;
