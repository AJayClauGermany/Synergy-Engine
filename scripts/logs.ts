/**
 * Prints the log of the game open under `bun run dev` (`.logs/game.log`): every console
 * message and uncaught error since the page was last loaded, with the time, frame and game
 * time of each.
 *
 *   bun run logs                  # the whole log
 *   bun run logs --errors         # errors only;  --warnings for warnings and errors
 *   bun run logs --tail 50        # the last 50 entries
 *   bun run logs --previous       # the load before (.logs/game.previous.log)
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dir, '..');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    errors: { type: 'boolean', default: false },
    warnings: { type: 'boolean', default: false },
    tail: { type: 'string' },
    previous: { type: 'boolean', default: false },
  },
});

const file = path.join(root, '.logs', values.previous ? 'game.previous.log' : 'game.log');
const log = Bun.file(file);
if (!(await log.exists())) {
  console.error(`${path.relative(root, file)} does not exist yet. Run \`bun run dev\` and open the game in a browser.`);
  process.exit(1);
}

// An entry is its first line plus the indented lines (stack, more of the message) under it.
const [header = '', ...lines] = (await log.text()).trimEnd().split('\n');
const entries: string[][] = [];
for (const line of lines) {
  if (line.startsWith('    ') && entries.length > 0) entries.at(-1)?.push(line);
  else entries.push([line]);
}
const levels = values.errors ? ['ERROR'] : values.warnings ? ['ERROR', 'WARN'] : null;
let shown = levels ? entries.filter(([first = '']) => levels.some((level) => first.includes(`] ${level} `))) : entries;
if (values.tail !== undefined) shown = shown.slice(-Number(values.tail));

console.log(header);
console.log(shown.map((entry) => entry.join('\n')).join('\n'));
console.error(`(${shown.length} of ${entries.length} entries, ${path.relative(root, file)})`);
