/**
 * Serves the production build from dist/: `bun run build && bun run start`.
 * Useful for checking the real bundle locally and for screenshot/e2e tooling.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { dir: { type: 'string', default: 'dist' }, port: { type: 'string' } },
});
const dir = path.resolve(import.meta.dir, '..', values.dir);
if (!existsSync(path.join(dir, 'index.html'))) {
  console.error(`No build found in ${dir}. Run \`bun run build\` first.`);
  process.exit(1);
}

const server = Bun.serve({
  port: Number(values.port ?? process.env.PORT ?? 4173),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const requested = path.join(dir, path.normalize(pathname));
    // Stay inside the build folder and fall back to index.html.
    const file = Bun.file(
      requested.startsWith(dir + path.sep) && pathname !== '/' ? requested : path.join(dir, 'index.html'),
    );
    return new Response((await file.exists()) ? file : Bun.file(path.join(dir, 'index.html')));
  },
});

console.log(`Serving ${path.relative(process.cwd(), dir) || '.'} at ${server.url}`);
