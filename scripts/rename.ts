/**
 * Gives the project its name in every file that carries one:
 *
 *   bun run rename my-game              the name; the title becomes "My Game"
 *   bun run rename my-game "My Game!"   the name and the title players see
 *
 * The name (lowercase letters, digits, dashes) is what the cloud resources are called: the
 * Cloudflare Worker, its R2 bucket, the Access application. The first deploy creates them
 * under it, so run this before deploying. docs/setup.md, step 3, lists what changes.
 */
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');

/** One place a name lives: the text around it, and what goes between. */
interface Place {
  file: string;
  /** Matches `before`, the current value and `after` as three groups. */
  pattern: RegExp;
  value: (names: Names) => string;
}

export interface Names {
  /** `my-game`: Worker, bucket, room codes, package. */
  name: string;
  /** `My Game`: the page and the desktop window. */
  title: string;
}

const PLACES: readonly Place[] = [
  { file: 'wrangler.jsonc', pattern: /("name":\s*")([^"]*)(")/, value: ({ name }) => name },
  // Twice: the main deployment and the previews, which inherit nothing.
  { file: 'wrangler.jsonc', pattern: /("bucket_name":\s*")([^"]*)(")/g, value: ({ name }) => `${name}-assets` },
  { file: 'package.json', pattern: /(^\s*"name":\s*")([^"]*)(")/m, value: ({ name }) => name },
  // Keeps this game's room codes apart from other games on PeerJS's shared server.
  { file: 'game/src/online.ts', pattern: /(const PEER_PREFIX = ')([^']*)(')/, value: ({ name }) => name },
  {
    file: 'game/src/frontier/session.ts',
    pattern: /(const PEER_PREFIX = ')([^']*)(')/,
    value: ({ name }) => `${name}-frontier`,
  },
  { file: 'game/index.html', pattern: /(<title>)([^<]*)(<\/title>)/, value: ({ title }) => escapeHtml(title) },
  {
    file: 'desktop/electrobun.config.ts',
    pattern: /(\bname: ')((?:[^'\\]|\\.)*)(')/,
    value: ({ title }) => escapeQuote(title),
  },
  {
    file: 'desktop/electrobun.config.ts',
    pattern: /(\bidentifier: ')([^']*)(')/,
    // Keeps the part before the last dot (`dev.synergy`), which is yours to change by hand.
    value: ({ name }) => name.replaceAll('-', ''),
  },
];

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const escapeQuote = (text: string) => text.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

/** `my-game` becomes `My Game`. */
export function titleOf(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** What is wrong with a name, or null. Cloudflare's rules for a Worker, which are the strictest. */
export function checkName(name: string): string | null {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return `"${name}" will not do: use lowercase letters, digits and single dashes, such as my-game.`;
  }
  // The bucket is "<name>-assets" (at most 63 characters) and a preview address is
  // "pr-<number>-<name>", one DNS label of at most 63.
  if (name.length > 40) return `"${name}" is ${name.length} characters; keep it to 40 so preview addresses fit.`;
  return null;
}

/** The files with the names written in. Throws when a file no longer has the place a name goes. */
export function rename(files: Readonly<Record<string, string>>, names: Names): Record<string, string> {
  const renamed: Record<string, string> = { ...files };
  for (const place of PLACES) {
    const text = renamed[place.file];
    if (text === undefined) throw new Error(`${place.file} is missing.`);
    let found = false;
    renamed[place.file] = text.replace(place.pattern, (_match, before: string, current: string, after: string) => {
      found = true;
      // The identifier keeps its prefix: dev.synergy.skirmish -> dev.synergy.mygame.
      const prefix = place.pattern.source.includes('identifier') ? current.slice(0, current.lastIndexOf('.') + 1) : '';
      return before + prefix + place.value(names) + after;
    });
    if (!found) {
      throw new Error(`${place.file}: found nothing matching ${place.pattern.source}. Change this name by hand.`);
    }
  }
  return renamed;
}

async function main(): Promise<number> {
  const [name, title] = Bun.argv.slice(2);
  if (!name || name.startsWith('-')) {
    console.error('Usage: bun run rename <name> ["Title"]     for example: bun run rename my-game "My Game"');
    return 1;
  }
  const problem = checkName(name);
  if (problem) {
    console.error(problem);
    return 1;
  }

  const files: Record<string, string> = {};
  for (const file of new Set(PLACES.map((place) => place.file))) {
    files[file] = await Bun.file(path.join(root, file)).text();
  }
  const renamed = rename(files, { name, title: title ?? titleOf(name) });
  for (const [file, text] of Object.entries(renamed)) {
    if (text === files[file]) continue;
    await Bun.write(path.join(root, file), text);
    console.log(`changed  ${file}`);
  }
  console.log(
    `\nThe project is "${name}" ("${title ?? titleOf(name)}"). Run \`bun run check\`, then commit.\n` +
      'Cloud resources made under the old name stay until you delete them (docs/setup.md, "Clearing what the test run created").',
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
