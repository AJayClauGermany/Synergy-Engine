/**
 * Development server with hot reload: `bun run dev` (PORT=3000 by default).
 * Bun bundles game/index.html on the fly; there is no separate bundler config.
 */
import path from 'node:path';
import index from '../game/index.html';

const publicDir = path.resolve(import.meta.dir, '../game/public');

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { '/': index },
  development: { hmr: true, console: true },
  // Anything that is not a bundled route is looked up in game/public.
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = Bun.file(path.join(publicDir, path.normalize(pathname)));
    if (pathname !== '/' && (await file.exists())) return new Response(file);
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Synergy dev server running at ${server.url}`);
