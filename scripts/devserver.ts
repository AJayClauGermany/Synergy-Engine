/**
 * The dev server's side of the devtools (`packages/devtools`): where the game page's log,
 * reports and screenshots land on disk, and how `bun run report` reaches an open page.
 *
 *   .logs/game.log            everything the page logged since it was last loaded
 *   .logs/game.previous.log   the load before that
 *   .reports/<time>/          summary.md, screenshot.png, log.txt, hierarchy.txt, hud.txt
 *   .reports/latest/          a copy of the newest report
 *   .screenshots/dev-<time>.png
 *
 * Only `bun run dev` uses this; a production build has no devtools and never calls it.
 */
import { appendFile, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  DEV_ENDPOINTS,
  type LogBatch,
  type PageMessage,
  type ReportRequest,
  type ReportUpload,
  type ScreenshotUpload,
  type ServerMessage,
} from '../packages/devtools/src/protocol';

/** Reports hold a PNG; a log batch is text. Anything larger is a mistake, not a report. */
const MAX_BODY = 40 * 1024 * 1024;
/** Report files the page may write. A name from the page never becomes a path by itself. */
const REPORT_FILES = new Set(['summary.md', 'log.txt', 'hierarchy.txt', 'hud.txt']);
const REPORT_TIMEOUT = 15_000;

/** `2026-11-13_10-22-01-123`: sorts by time and is a valid file name everywhere. */
function stamp(date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(':', '-')}-${iso.slice(20, 23)}`;
}

function png(dataUrl: string): Uint8Array | null {
  const prefix = 'data:image/png;base64,';
  return dataUrl.startsWith(prefix) ? Buffer.from(dataUrl.slice(prefix.length), 'base64') : null;
}

async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) throw new Error('Request body too large.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('Request body too large.');
  return JSON.parse(text) as T;
}

type Socket = ServerWebSocket<unknown>;

export interface DevToolsServer {
  /** Takes over the page's socket request. True when it did; return nothing from `fetch` then. */
  upgrade(request: Request, server: { upgrade(request: Request, options: { data: unknown }): boolean }): boolean;
  /** Answers a devtools request, or returns `undefined` for anything else. */
  handle(request: Request): Promise<Response | undefined>;
  /** Bun's WebSocket handlers for the page's socket. */
  readonly websocket: {
    open(socket: Socket): void;
    message(socket: Socket, data: string | Buffer): void;
    close(socket: Socket): void;
  };
  /** How many game pages are connected. */
  readonly pages: number;
}

export interface DevToolsServerOptions {
  /**
   * Write the page's log to `.logs/game.log`. Default true. The screenshot tool turns it
   * off: it saves the page's console beside the image, and must not replace the log of a
   * game someone has open in `bun run dev`.
   */
  writeLog?: boolean;
}

/** The devtools endpoints, writing under `root` (the project folder). */
export function createDevToolsServer(root: string, options: DevToolsServerOptions = {}): DevToolsServer {
  const writeLogs = options.writeLog ?? true;
  const logs = path.join(root, '.logs');
  const reports = path.join(root, '.reports');
  const screenshots = path.join(root, '.screenshots');
  const relative = (target: string) => path.relative(root, target);
  const sockets = new Set<Socket>();
  const waiting = new Map<string, (answer: Response) => void>();
  let nextRequest = 1;

  async function writeLog(batch: LogBatch): Promise<void> {
    if (!writeLogs) return;
    await mkdir(logs, { recursive: true });
    const file = path.join(logs, 'game.log');
    if (batch.session !== undefined) {
      // A new page load starts a new file, and the one before is kept for comparison.
      await rename(file, path.join(logs, 'game.previous.log')).catch(() => {});
      await writeFile(file, `${batch.session}\n`);
    }
    const lines = (batch.lines as unknown[]).filter((line): line is string => typeof line === 'string');
    if (lines.length > 0) await appendFile(file, `${lines.join('\n')}\n`);
  }

  async function writeReport(upload: ReportUpload): Promise<string> {
    const folder = path.join(reports, stamp());
    await mkdir(folder, { recursive: true });
    for (const [name, text] of Object.entries(upload.files ?? {})) {
      if (REPORT_FILES.has(name) && typeof text === 'string') await writeFile(path.join(folder, name), text);
    }
    const image = upload.screenshot ? png(upload.screenshot) : null;
    if (image) await writeFile(path.join(folder, 'screenshot.png'), image);
    const latest = path.join(reports, 'latest');
    await rm(latest, { recursive: true, force: true });
    await cp(folder, latest, { recursive: true });
    return relative(folder);
  }

  async function writeScreenshot(upload: ScreenshotUpload): Promise<string> {
    const image = png(upload.screenshot);
    if (!image) throw new Error('The screenshot must be a PNG data URL.');
    await mkdir(screenshots, { recursive: true });
    // Only the last part of a name the page sends is used, so it can never leave the folder.
    const given = String(upload.name ?? '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.-]+/g, '-')
      .replace(/^\.+/, '');
    const name = given ? (given.toLowerCase().endsWith('.png') ? given : `${given}.png`) : `dev-${stamp()}.png`;
    const file = path.join(screenshots, name);
    await writeFile(file, image);
    await writeFile(path.join(screenshots, 'dev-latest.png'), image);
    return relative(file);
  }

  /** Asks the most recently connected page for a report and waits for its folder. */
  function requestReport(request: ReportRequest): Promise<Response> {
    const page = [...sockets].at(-1);
    if (!page) {
      return Promise.resolve(
        Response.json(
          { error: 'No game page is connected. Open the game from `bun run dev` in a browser, then try again.' },
          { status: 409 },
        ),
      );
    }
    const id = String(nextRequest++);
    const message: ServerMessage = { type: 'report', id, note: String(request.note ?? '') };
    page.send(JSON.stringify(message));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(Response.json({ error: 'The game page did not answer in time.' }, { status: 504 }));
      }, REPORT_TIMEOUT);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  const routes: Record<string, (request: Request) => Promise<Response>> = {
    [DEV_ENDPOINTS.log]: async (request) => {
      await writeLog(await readJson<LogBatch>(request));
      return new Response(null, { status: 204 });
    },
    [DEV_ENDPOINTS.report]: async (request) => Response.json({ path: await writeReport(await readJson(request)) }),
    [DEV_ENDPOINTS.screenshot]: async (request) =>
      Response.json({ path: await writeScreenshot(await readJson(request)) }),
    [DEV_ENDPOINTS.requestReport]: async (request) => requestReport(await readJson<ReportRequest>(request)),
  };

  return {
    get pages() {
      return sockets.size;
    },
    upgrade(request, server) {
      return new URL(request.url).pathname === DEV_ENDPOINTS.socket && server.upgrade(request, { data: null });
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      const route = routes[pathname];
      if (!route) return undefined;
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      try {
        return await route(request);
      } catch (error) {
        return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 400 });
      }
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(_socket, data) {
        let message: PageMessage;
        try {
          message = JSON.parse(String(data)) as PageMessage;
        } catch {
          return;
        }
        if (message.type !== 'reported') return;
        const answer = waiting.get(message.id);
        waiting.delete(message.id);
        answer?.(
          message.path
            ? Response.json({ path: message.path })
            : Response.json({ error: message.error ?? 'The page could not save the report.' }, { status: 500 }),
        );
      },
    },
  };
}
