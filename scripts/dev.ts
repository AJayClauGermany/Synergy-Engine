/**
 * Development server with hot reload: `bun run dev` (PORT=3000 by default).
 * Bun bundles game/index.html on the fly; there is no separate bundler config.
 *
 * The page it serves is a development build, so it carries the devtools
 * (`packages/devtools`): press ` (backquote) for the editor, F8 for a report. What they
 * write lands under .logs/, .reports/ and .screenshots/ through `scripts/devserver.ts`.
 */
import path from 'node:path';
import index from '../game/index.html';
import { createDevToolsServer } from './devserver';

const root = path.resolve(import.meta.dir, '..');
const publicDir = path.join(root, 'game/public');
const devtools = createDevToolsServer(root);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { '/': index },
  development: { hmr: true, console: true },
  websocket: devtools.websocket,
  // Anything that is not a bundled route is a devtools request or a file in game/public.
  async fetch(request, server) {
    if (devtools.upgrade(request, server)) return undefined;
    const answer = await devtools.handle(request);
    if (answer) return answer;
    const { pathname } = new URL(request.url);
    const requested = path.join(publicDir, path.normalize(pathname));
    const file = Bun.file(requested);
    // Never serve anything outside game/public.
    if (pathname !== '/' && requested.startsWith(publicDir + path.sep) && (await file.exists())) {
      return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Synergy dev server running at ${server.url}`);
console.log(
  'Devtools: ` (backquote) opens the editor, F8 saves a report to .reports/latest, the log is .logs/game.log',
);
