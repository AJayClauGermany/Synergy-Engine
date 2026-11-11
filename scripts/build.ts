/**
 * Builds the game into a static site: `bun run build [--outdir dist] [--keep-names]`.
 * The output can be hosted anywhere, wrapped by Electrobun, or served by the Cloudflare Worker.
 *
 * `--keep-names` leaves class and function names as written, so error messages
 * ("Exception in UnitView.update") and `Debug.hierarchy()` are readable. The screenshot
 * tool builds this way. It makes the download about a sixth larger, so releases do without.
 */
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dir, '..');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { outdir: { type: 'string', default: 'dist' }, 'keep-names': { type: 'boolean', default: false } },
});
const outdir = path.resolve(root, values.outdir);

await rm(outdir, { recursive: true, force: true });

const started = performance.now();
const result = await Bun.build({
  entrypoints: [path.join(root, 'game/index.html')],
  outdir,
  target: 'browser',
  // Dynamic `import()`s become separate files, so optional code (e.g. networking) loads on demand.
  splitting: true,
  minify: values['keep-names'] ? { whitespace: true, syntax: true, identifiers: false } : true,
  sourcemap: 'linked',
  // Only variables starting with PUBLIC_ are inlined into the bundle. Never put secrets in them.
  env: 'PUBLIC_*',
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Files in game/public are copied as-is (favicon, large assets you load by URL, ...).
const publicDir = path.join(root, 'game/public');
if (existsSync(publicDir)) await cp(publicDir, outdir, { recursive: true });

const bytes = result.outputs.reduce((total, output) => total + output.size, 0);
const script = result.outputs
  .filter((output) => output.path.endsWith('.js'))
  .reduce((total, output) => total + output.size, 0);
console.log(
  `Built ${path.relative(root, outdir)}/ in ${Math.round(performance.now() - started)} ms ` +
    `(${result.outputs.length} files, ${(bytes / 1024).toFixed(0)} kB total, ${(script / 1024).toFixed(0)} kB of JavaScript)`,
);
