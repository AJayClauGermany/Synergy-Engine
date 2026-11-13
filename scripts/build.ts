/**
 * Builds the game into a static site: `bun run build [--outdir dist] [--keep-names] [--devtools]`.
 * The output can be hosted anywhere, wrapped by Electrobun, or served by the Cloudflare Worker.
 *
 * `--keep-names` leaves class and function names as written, so error messages
 * ("Exception in UnitView.update") and `Debug.hierarchy()` are readable. The screenshot
 * tool builds this way. It makes the download about a sixth larger, so releases do without.
 *
 * A build is a release build: `process.env.NODE_ENV` is "production", so the devtools
 * (`packages/devtools`: the editor, the log file, reports) are left out entirely.
 * `--devtools` keeps them, for `bun run screenshot --devtools` and for testing the editor
 * on a static server; never ship that build.
 */
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dir, '..');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outdir: { type: 'string', default: 'dist' },
    'keep-names': { type: 'boolean', default: false },
    devtools: { type: 'boolean', default: false },
  },
});
const outdir = path.resolve(root, values.outdir);

await rm(outdir, { recursive: true, force: true });

// A fingerprint of the source this build is made from, readable in the game as
// `buildId` (game/src/env.ts). Netcode refuses to connect two different builds, so the
// same source must give the same id on every machine: it is a hash of the files, not a
// timestamp. Set PUBLIC_BUILD_ID yourself to use a release number instead.
if (!process.env.PUBLIC_BUILD_ID) {
  const hasher = new Bun.CryptoHasher('sha256');
  const files: string[] = [];
  for (const pattern of ['game/src/**/*', 'game/index.html', 'packages/*/src/**/*', 'bun.lock']) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) files.push(file);
  }
  for (const file of files.sort()) {
    hasher.update(file);
    hasher.update(await Bun.file(path.join(root, file)).arrayBuffer());
  }
  process.env.PUBLIC_BUILD_ID = hasher.digest('hex').slice(0, 12);
}
const buildId = process.env.PUBLIC_BUILD_ID;

const started = performance.now();
const result = await Bun.build({
  entrypoints: [path.join(root, 'game/index.html')],
  outdir,
  target: 'browser',
  // Dynamic `import()`s become separate files, so optional code (e.g. networking) loads on demand.
  splitting: true,
  // Imported files (images, models, sounds) go to assets/ under a name that holds a hash
  // of their content. A deploy can then keep them in R2 and upload only the ones that
  // changed (scripts/deploy.ts); a desktop build ships the folder as it is.
  naming: { asset: 'assets/[name]-[hash].[ext]' },
  minify: values['keep-names'] ? { whitespace: true, syntax: true, identifiers: false } : true,
  sourcemap: 'linked',
  // Only variables starting with PUBLIC_ are inlined into the bundle. Never put secrets in them.
  env: 'PUBLIC_*',
  define: {
    'process.env.NODE_ENV': values.devtools ? '"development"' : '"production"',
    'process.env.PUBLIC_BUILD_ID': JSON.stringify(buildId),
  },
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
  `Built ${path.relative(root, outdir)}/ (build ${buildId}${values.devtools ? ', with devtools' : ''}) in ${Math.round(performance.now() - started)} ms ` +
    `(${result.outputs.length} files, ${(bytes / 1024).toFixed(0)} kB total, ${(script / 1024).toFixed(0)} kB of JavaScript)`,
);
