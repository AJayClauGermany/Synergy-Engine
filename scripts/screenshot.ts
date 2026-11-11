/**
 * Opens the game in headless Chromium, optionally drives it, and saves a screenshot.
 * This is how an agent (or CI) checks what the game actually looks like.
 *
 *   bun run screenshot                                  # build, serve dist/, capture .screenshots/game.png
 *   bun run screenshot --out shots/turn2.png --click 640,400 --key Space --wait 500
 *   bun run screenshot --url http://localhost:3000      # capture an already running dev server
 *   bun run screenshot --scene MyScene --eval "synergy.GameObject.find('Board') !== null"
 *
 * Actions (--click x,y / --key Code / --wait ms / --eval js) run in the order given.
 * `--eval` prints the expression's JSON result; `synergy` is the engine API plus `engine`.
 * Exits with code 1 if the page logs an error, so it doubles as a smoke test.
 *
 * Needs Playwright with Chromium: `bun add -d playwright && bunx playwright install chromium`
 * (already present in Claude Code cloud sessions).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

type Action = { kind: 'click'; x: number; y: number } | { kind: 'key'; code: string } | { kind: 'wait'; ms: number } | { kind: 'eval'; source: string };

const root = path.resolve(import.meta.dir, '..');
const options = { url: '', out: '.screenshots/game.png', width: 1280, height: 720, scene: '', settle: 600, build: true };
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
    case '--url': options.url = value(); break;
    case '--out': options.out = value(); break;
    case '--width': options.width = Number(value()); break;
    case '--height': options.height = Number(value()); break;
    case '--scene': options.scene = value(); break;
    case '--settle': options.settle = Number(value()); break;
    case '--no-build': options.build = false; break;
    case '--click': {
      const [x, y] = value().split(',').map(Number);
      actions.push({ kind: 'click', x: x ?? 0, y: y ?? 0 });
      break;
    }
    case '--key': actions.push({ kind: 'key', code: value() }); break;
    case '--wait': actions.push({ kind: 'wait', ms: Number(value()) }); break;
    case '--eval': actions.push({ kind: 'eval', source: value() }); break;
    default: throw new Error(`Unknown option ${flag}. See the comment at the top of scripts/screenshot.ts.`);
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
interface BrowserLike {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PageLike>;
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
    const build = Bun.spawnSync(['bun', 'run', 'scripts/build.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  }
  const dist = path.join(root, 'dist');
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const file = Bun.file(path.join(dist, pathname === '/' ? 'index.html' : path.normalize(pathname)));
      return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
    },
  });
  url = server.url.href;
}
if (options.scene) url += `${url.includes('?') ? '&' : '?'}scene=${encodeURIComponent(options.scene)}`;

const browser = await playwright.chromium.launch({
  // Software WebGL, so this works on machines and CI runners without a GPU.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  // Set CHROMIUM_PATH to use a specific browser binary instead of Playwright's own.
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const errors: string[] = [];
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', undefined, { timeout: 30_000 });
  await page.waitForTimeout(options.settle);

  for (const action of actions) {
    if (action.kind === 'click') await page.mouse.click(action.x, action.y);
    else if (action.kind === 'key') await page.keyboard.press(action.code);
    else if (action.kind === 'wait') await page.waitForTimeout(action.ms);
    else console.log(`${action.source} => ${JSON.stringify(await page.evaluate(action.source))}`);
    // Give the game a couple of frames to react before the next step.
    if (action.kind !== 'wait') await page.waitForTimeout(100);
  }

  const out = path.resolve(root, options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`Saved ${path.relative(process.cwd(), out)} (${options.width}x${options.height})`);
} catch (error) {
  errors.push(String(error));
} finally {
  await browser.close();
  server?.stop(true);
}

if (errors.length > 0) {
  console.error(`The page reported ${errors.length} error(s):`);
  for (const error of errors) console.error(`  ${error}`);
  exitCode = 1;
}
process.exit(exitCode);
