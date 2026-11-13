/**
 * Opens the game in headless Chromium, optionally drives it, and saves a screenshot.
 * This is how an agent (or CI) checks what the game actually looks like.
 *
 *   bun run screenshot                                  # build, serve dist/, capture .screenshots/game.png
 *   bun run screenshot --out shots/turn2.png --click 640,400 --key Space --wait 500
 *   bun run screenshot --url http://localhost:3000      # capture an already running dev server
 *   bun run screenshot --scene MyScene --eval "synergy.GameObject.find('Board') !== null"
 *   bun run screenshot --hierarchy                      # also print the scene as text (Debug.hierarchy())
 *   bun run screenshot --renderer webgl2                # force WebGL2 (the game prefers WebGPU)
 *   bun run screenshot --devtools                       # a build with the editor, opened (Hierarchy, Inspector, Console)
 *   bun run screenshot --key Space --logs               # print what the page logged so far
 *   bun run screenshot --scene Frontier --players 2     # two players in a local room: game-p1.png, game-p2.png
 *   bun run screenshot --players 2 --on 2 --click 640,400 --on 1 --wait 500   # act as player 2, then look as 1
 *
 * Several players (Unity's Multiplayer Play Mode, headless): `--players N` opens N pages of
 * one browser. Player 1 hosts a local room (`?net=local&host=CODE`), the others join it
 * (`?join=CODE&player=2`, ...; see game/src/localPlay.ts), and the run waits until each
 * page reports itself connected (`data-net` on its root element). Actions apply to the
 * player chosen with `--on N` (player 1 to begin with). Each player gets its own image
 * and log: `game-p1.png`, `game-p1.log`, `game-p2.png`, ...
 *
 * Size: --width, --height (CSS pixels) and --scale (device pixel ratio; use 2 for a sharp image to share).
 * The build keeps class names so messages are readable; --release tests the minified build that ships.
 * Actions (--click x,y / --key Code / --wait ms / --eval js / --hierarchy / --logs) run in the order given.
 * `--eval` prints the expression's JSON result; `synergy` is the engine API plus `engine`.
 * `--hierarchy` prints every GameObject with its components, position and script fields:
 * often quicker to check than the image, and it can be repeated between other actions.
 * Everything the page logged is saved next to the image (`.screenshots/game.log` for
 * `game.png`), one line per message with its level, so a run can be read afterwards.
 * Exits with code 1 if the page logs an error, so it doubles as a smoke test.
 *
 * Needs Playwright with Chromium: `bun add -d playwright && bunx playwright install chromium`
 * (already present in Claude Code cloud sessions).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createDevToolsServer } from './devserver';

type Action =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'key'; code: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'eval'; source: string }
  | { kind: 'hierarchy' }
  | { kind: 'logs' }
  | { kind: 'on'; player: number };

const root = path.resolve(import.meta.dir, '..');
const options = {
  url: '',
  out: '.screenshots/game.png',
  width: 1280,
  height: 720,
  scale: 1,
  scene: '',
  renderer: '',
  settle: 600,
  build: true,
  release: false,
  devtools: false,
  players: 1,
};
const actions: Action[] = [];

const args = Bun.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = () => {
    const next = args[++i];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    return next;
  };
  switch (flag) {
    case '--url':
      options.url = value();
      break;
    case '--out':
      options.out = value();
      break;
    case '--width':
      options.width = Number(value());
      break;
    case '--height':
      options.height = Number(value());
      break;
    case '--scale':
      options.scale = Number(value());
      break;
    case '--scene':
      options.scene = value();
      break;
    case '--renderer':
      options.renderer = value();
      break;
    case '--settle':
      options.settle = Number(value());
      break;
    case '--no-build':
      options.build = false;
      break;
    case '--release':
      options.release = true;
      break;
    case '--devtools':
      options.devtools = true;
      break;
    case '--click': {
      const [x, y] = value().split(',').map(Number);
      actions.push({ kind: 'click', x: x ?? 0, y: y ?? 0 });
      break;
    }
    case '--key':
      actions.push({ kind: 'key', code: value() });
      break;
    case '--wait':
      actions.push({ kind: 'wait', ms: Number(value()) });
      break;
    case '--eval':
      actions.push({ kind: 'eval', source: value() });
      break;
    case '--hierarchy':
      actions.push({ kind: 'hierarchy' });
      break;
    case '--logs':
      actions.push({ kind: 'logs' });
      break;
    case '--players':
      options.players = Math.max(1, Math.min(8, Math.trunc(Number(value()))));
      break;
    case '--on':
      actions.push({ kind: 'on', player: Math.trunc(Number(value())) });
      break;
    default:
      throw new Error(`Unknown option ${flag}. See the comment at the top of scripts/screenshot.ts.`);
  }
}

// Playwright is deliberately not a dependency of the template (it is large and only
// tools need it), so describe the few members used here instead of importing its types.
interface PageLike {
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  goto(url: string, options: { waitUntil: 'load' }): Promise<unknown>;
  waitForFunction(check: () => boolean, arg: undefined, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(source: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
}
interface ContextLike {
  newPage(): Promise<PageLike>;
}
interface BrowserLike {
  // One context for every player: pages of one context share an origin's storage and
  // BroadcastChannel, like windows of one browser profile.
  newContext(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<ContextLike>;
  close(): Promise<void>;
}
interface PlaywrightLike {
  chromium: { launch(options: { args: string[]; executablePath?: string }): Promise<BrowserLike> };
}

let playwright: PlaywrightLike;
try {
  const moduleName = 'playwright';
  playwright = (await import(moduleName)) as PlaywrightLike;
} catch {
  console.error('Playwright is not installed. Run: bun add -d playwright && bunx playwright install chromium');
  process.exit(2);
}

// Serve a fresh production build unless pointed at a running server.
let server: ReturnType<typeof Bun.serve> | null = null;
let url = options.url;
if (!url) {
  if (options.build) {
    // Class names are kept so that errors and --hierarchy can be read; --release builds exactly what ships.
    const buildArgs = [...(options.release ? [] : ['--keep-names']), ...(options.devtools ? ['--devtools'] : [])];
    const build = Bun.spawnSync(['bun', 'run', 'scripts/build.ts', ...buildArgs], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  }
  const dist = path.join(root, 'dist');
  // A --devtools build talks to the dev server; answer it the same way, so that
  // `--eval "synergy.editor.report('...')"` saves a report as it would under `bun run dev`.
  const devtools = createDevToolsServer(root, { writeLog: false });
  server = Bun.serve({
    port: 0,
    websocket: devtools.websocket,
    async fetch(request, server) {
      if (devtools.upgrade(request, server)) return undefined;
      const answer = await devtools.handle(request);
      if (answer) return answer;
      const { pathname } = new URL(request.url);
      const requested = path.join(dist, pathname === '/' ? 'index.html' : path.normalize(pathname));
      const file = Bun.file(requested);
      const inside = requested.startsWith(dist + path.sep);
      return inside && (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
    },
  });
  url = server.url.href;
}
if (options.scene) url += `${url.includes('?') ? '&' : '?'}scene=${encodeURIComponent(options.scene)}`;
if (options.renderer) url += `${url.includes('?') ? '&' : '?'}renderer=${encodeURIComponent(options.renderer)}`;
if (options.devtools) url += `${url.includes('?') ? '&' : '?'}editor`;

const browser = await playwright.chromium.launch({
  // Software WebGL and WebGPU (SwiftShader), so this works on machines and CI runners
  // without a GPU, and checks the same renderer players get: the game prefers WebGPU.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader',
  ],
  // Set CHROMIUM_PATH to use a specific browser binary instead of Playwright's own.
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const errors: string[] = [];
const started = performance.now();
let exitCode = 0;

/** One player's page, with everything it logged as `[  1.234s] LEVEL text`. */
interface Player {
  number: number;
  page: PageLike;
  logLines: string[];
  printedLines: number;
}

const multiplayer = options.players > 1;
const roomCode = `T${crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
function playerUrl(number: number): string {
  if (!multiplayer) return url;
  const join = number === 1 ? `host=${roomCode}` : `join=${roomCode}&player=${number}`;
  return `${url}${url.includes('?') ? '&' : '?'}net=local&${join}`;
}

const players: Player[] = [];
try {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.scale,
  });
  for (let number = 1; number <= options.players; number++) {
    const player: Player = { number, page: await context.newPage(), logLines: [], printedLines: 0 };
    const tag = multiplayer ? `player ${number}: ` : '';
    const logLine = (level: string, text: string) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(3).padStart(8);
      player.logLines.push(`[${seconds}s] ${level.toUpperCase().padEnd(5)} ${text}`);
    };
    player.page.on('console', (message) => {
      const type = message.type() === 'warning' ? 'warn' : message.type();
      logLine(type, message.text());
      if (type === 'error') errors.push(tag + message.text());
    });
    player.page.on('pageerror', (error) => {
      logLine('error', `Uncaught ${String(error)}`);
      errors.push(`${tag}${String(error)}`);
    });
    players.push(player);
  }

  // Every page loads at once, as the windows of a test would; joiners wait for the host.
  await Promise.all(
    players.map(async ({ page, number }) => {
      await page.goto(playerUrl(number), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', undefined, {
        timeout: 30_000,
      });
    }),
  );
  if (multiplayer) {
    await Promise.all(
      players.map(async ({ page, number }) => {
        try {
          await page.waitForFunction(
            () => ['hosting', 'joined'].includes(document.documentElement.dataset.net ?? ''),
            undefined,
            { timeout: 20_000 },
          );
        } catch {
          const state = await page.evaluate('document.documentElement.dataset.net ?? "(not reported)"');
          throw new Error(
            `Player ${number} did not connect (data-net is ${String(state)}). The game must host or join from ` +
              '?host= / ?join= and report it with data-net (see game/src/localPlay.ts).',
          );
        }
      }),
    );
  }
  const first = players[0] as Player;
  await first.page.waitForTimeout(options.settle);
  const device = await first.page.evaluate('synergy.engine.app.graphicsDevice.deviceType');

  let current = first;
  for (const action of actions) {
    const page = current.page;
    if (action.kind === 'on') {
      const next = players[action.player - 1];
      if (!next) throw new Error(`--on ${action.player}: there are ${players.length} player(s); use --players.`);
      current = next;
      continue;
    }
    if (action.kind === 'click') await page.mouse.click(action.x, action.y);
    else if (action.kind === 'key') await page.keyboard.press(action.code);
    else if (action.kind === 'wait') await page.waitForTimeout(action.ms);
    else if (action.kind === 'hierarchy') console.log(await page.evaluate('synergy.Debug.hierarchy()'));
    else if (action.kind === 'logs') {
      console.log(current.logLines.slice(current.printedLines).join('\n') || '(nothing logged since the last --logs)');
      current.printedLines = current.logLines.length;
    } else console.log(`${action.source} => ${JSON.stringify(await page.evaluate(action.source))}`);
    // Give the game a couple of frames to react before the next step.
    if (action.kind !== 'wait') await page.waitForTimeout(100);
  }

  const base = path.resolve(root, options.out).replace(/\.png$/i, '');
  await mkdir(path.dirname(base), { recursive: true });
  for (const player of players) {
    const name = multiplayer ? `${base}-p${player.number}` : base;
    await player.page.screenshot({ path: `${name}.png` });
    await Bun.write(`${name}.log`, player.logLines.length > 0 ? `${player.logLines.join('\n')}\n` : '');
    console.log(
      `Saved ${path.relative(process.cwd(), `${name}.png`)} (${options.width}x${options.height} at ${options.scale}x, ` +
        `${String(device)}) and its log, ${path.relative(process.cwd(), `${name}.log`)} (${player.logLines.length} lines)`,
    );
  }
} catch (error) {
  errors.push(String(error));
} finally {
  await browser.close();
  await server?.stop(true);
}

if (errors.length > 0) {
  console.error(`The page reported ${errors.length} error(s):`);
  for (const error of errors) console.error(`  ${error}`);
  exitCode = 1;
}
process.exit(exitCode);
