/// <reference path="../rules.d.ts" />

/** Reads of an environment variable by name: `process.env.NAME`, `import.meta.env.NAME`, `Bun.env.NAME`. */
const READ =
  /\b(process\.env|import\.meta\.env|Bun\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

/**
 * Code that ends up in the browser bundle (scripts/build.ts bundles game/src and what it
 * imports). The build writes in `NODE_ENV` and the `PUBLIC_` variables; nothing else exists there.
 */
const BROWSER = ['game/src/**/*.{ts,tsx}', 'packages/{engine,ui,net,netcode,devtools}/src/**/*.{ts,tsx}'];
/** Everything that may read a public variable, browser or not. */
const ANYWHERE = [...BROWSER, 'scripts/**/*.ts', 'cloudflare/**/*.ts', 'convex/**/*.ts'];

interface Read {
  name: string;
  via: string;
  file: string;
  line: number;
}

async function reads(ctx: RuleContext, patterns: readonly string[]): Promise<Read[]> {
  const found: Read[] = [];
  const files = new Set<string>();
  for (const pattern of patterns) for (const file of await ctx.glob(pattern)) files.add(file);
  for (const file of [...files].toSorted()) {
    if (/\.(test|spec)\.tsx?$/.test(file) || file.includes('/_generated/')) continue;
    for (const match of await ctx.grep(file, /\b(?:process\.env|import\.meta\.env|Bun\.env)\b/)) {
      // Skip comments: a guide line in a doc comment names variables without reading them.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(match.content)) continue;
      for (const each of match.content.matchAll(READ)) {
        found.push({ name: each[2] ?? each[3] ?? '', via: each[1] ?? '', file, line: match.line });
      }
    }
  }
  return found;
}

interface Item {
  name: string;
  line: number;
  /** The comment lines right above the item: where its @decorators are. */
  decorators: string;
}

/** The items `.env.schema` declares (varlock's format: `NAME=value` under its comment block). */
function schemaItems(text: string): Item[] {
  const items: Item[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const item = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!item) return;
    const comments: string[] = [];
    for (let above = index - 1; above >= 0 && (lines[above] ?? '').startsWith('#'); above--) {
      comments.unshift(lines[above] ?? '');
    }
    items.push({ name: item[1] ?? '', line: index + 1, decorators: comments.join('\n') });
  });
  return items;
}

export default {
  rules: {
    'browser-code-reads-only-public-variables': {
      description: 'Code bundled for the browser reads only NODE_ENV and PUBLIC_ variables, through process.env',
      async check(ctx) {
        for (const read of await reads(ctx, BROWSER)) {
          if (read.via === 'process.env' && (read.name === 'NODE_ENV' || read.name.startsWith('PUBLIC_'))) continue;
          const wrongWay = read.via !== 'process.env';
          ctx.report.violation({
            message: wrongWay
              ? `${read.via}.${read.name} in code that runs in the browser: the build replaces only process.env.NODE_ENV and process.env.PUBLIC_*, and ${read.via} does not exist in a page.`
              : `process.env.${read.name} in code that runs in the browser: only NODE_ENV and PUBLIC_ variables are built into the page, so this is undefined there (and a secret must never be).`,
            file: read.file,
            line: read.line,
            fix: wrongWay
              ? `Read process.env.${read.name.startsWith('PUBLIC_') ? read.name : `PUBLIC_${read.name}`} (game/src/env.ts shows the guard), declared in .env.schema.`
              : `If the page may see it, name it PUBLIC_${read.name}, declare it in .env.schema and read it in game/src/env.ts; if it is a secret, read it in scripts/ or the Worker instead.`,
          });
        }
      },
    },

    'public-variables-are-declared': {
      description: 'Every PUBLIC_ variable the code reads is declared in .env.schema',
      async check(ctx) {
        let schema = '';
        try {
          schema = await ctx.readFile('.env.schema');
        } catch {
          schema = '';
        }
        const declared = new Set(schemaItems(schema).map((item) => item.name));
        for (const read of await reads(ctx, ANYWHERE)) {
          if (!read.name.startsWith('PUBLIC_') || declared.has(read.name)) continue;
          ctx.report.violation({
            message: `${read.name} is read here but .env.schema does not declare it, so varlock never checks or loads it and the build sees it unset.`,
            file: read.file,
            line: read.line,
            fix: `Add it to .env.schema with a comment saying what it turns on: ${read.name}= (docs/environment.md).`,
          });
        }
      },
    },

    'public-variables-are-not-secret': {
      description: 'No PUBLIC_ variable in .env.schema is marked @sensitive: everything PUBLIC_ is built into the page',
      async check(ctx) {
        let schema = '';
        try {
          schema = await ctx.readFile('.env.schema');
        } catch {
          return;
        }
        const sensitiveByDefault = /@defaultSensitive=true\b/.test(schema);
        for (const item of schemaItems(schema)) {
          if (!item.name.startsWith('PUBLIC_')) continue;
          const marked = /@sensitive(?!=false)\b/.test(item.decorators);
          const unmarked = /@sensitive=false\b/.test(item.decorators);
          if (!marked && !(sensitiveByDefault && !unmarked)) continue;
          ctx.report.violation({
            message: `${item.name} is marked secret, but every PUBLIC_ variable is written into the page for anyone to read.`,
            file: '.env.schema',
            line: item.line,
            fix: `If it is a secret, drop the PUBLIC_ prefix and read it outside the browser. If it is not, mark it @sensitive=false.`,
          });
        }
      },
    },
  },
} satisfies RuleSet;
