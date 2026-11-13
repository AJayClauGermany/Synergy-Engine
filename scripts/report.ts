/**
 * Asks the game open in a browser under `bun run dev` for a report, and prints where it
 * went and its summary. This is how an agent sees what a person is looking at, without
 * the person doing anything:
 *
 *   bun run report                          # .reports/<time>/ and .reports/latest/
 *   bun run report --note "after clicking End turn"
 *   bun run report --url http://localhost:3001
 *
 * The report holds summary.md (read it first), screenshot.png (the game view), log.txt,
 * hierarchy.txt and hud.txt. Without an open page it says so and exits with code 1;
 * `bun run screenshot` starts its own browser instead (docs/devtools.md).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEV_ENDPOINTS } from '../packages/devtools/src/protocol';

const root = path.resolve(import.meta.dir, '..');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    note: { type: 'string', default: '' },
    url: { type: 'string', default: `http://localhost:${process.env.PORT || 3000}` },
  },
});

let response: Response;
try {
  response = await fetch(new URL(DEV_ENDPOINTS.requestReport, values.url), {
    method: 'POST',
    body: JSON.stringify({ note: values.note }),
  });
} catch {
  console.error(`No dev server at ${values.url}. Start it with \`bun run dev\` and open the game in a browser.`);
  process.exit(1);
}
const answer = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
if (!response.ok || !answer.path) {
  console.error(answer.error ?? `The dev server answered ${response.status}.`);
  process.exit(1);
}
console.log(`Report saved to ${answer.path}/ (a copy is in .reports/latest/)\n`);
console.log(await Bun.file(path.join(root, answer.path, 'summary.md')).text());
