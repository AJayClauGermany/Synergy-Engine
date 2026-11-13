import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV_ENDPOINTS, type ServerMessage } from '../packages/devtools/src/protocol';
import { createDevToolsServer, type DevToolsServer } from './devserver';

// A 1x1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let root: string;
let server: DevToolsServer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'synergy-devserver-'));
  server = createDevToolsServer(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function post(endpoint: string, body: unknown): Promise<Response> {
  const response = await server.handle(
    new Request(`http://localhost${endpoint}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  if (!response) throw new Error(`${endpoint} was not answered`);
  return response;
}
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('the log file', () => {
  test('a session starts a new file and keeps the one before; lines are appended', async () => {
    await post(DEV_ENDPOINTS.log, { session: '=== first ===', lines: ['a'] });
    await post(DEV_ENDPOINTS.log, { lines: ['b', 'c'] });
    expect(await read('.logs/game.log')).toBe('=== first ===\na\nb\nc\n');
    await post(DEV_ENDPOINTS.log, { session: '=== second ===', lines: [] });
    expect(await read('.logs/game.log')).toBe('=== second ===\n');
    expect(await read('.logs/game.previous.log')).toBe('=== first ===\na\nb\nc\n');
  });

  test('can be turned off, for the screenshot tool', async () => {
    server = createDevToolsServer(root, { writeLog: false });
    expect((await post(DEV_ENDPOINTS.log, { session: 'x', lines: ['a'] })).status).toBe(204);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('reports and screenshots', () => {
  test('a report is written to its own folder and copied to latest; unknown file names are ignored', async () => {
    const response = await post(DEV_ENDPOINTS.report, {
      screenshot: PNG,
      files: { 'summary.md': '# hi', 'log.txt': 'log', '../../evil.sh': 'rm -rf /' },
    });
    const { path: folder } = (await response.json()) as { path: string };
    expect(folder).toMatch(/^\.reports\/\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-\d{3}$/);
    expect((await readdir(path.join(root, folder))).toSorted()).toEqual(['log.txt', 'screenshot.png', 'summary.md']);
    expect(await read('.reports/latest/summary.md')).toBe('# hi');
  });

  test('a screenshot keeps only the last part of its name, so it stays in .screenshots', async () => {
    const response = await post(DEV_ENDPOINTS.screenshot, { screenshot: PNG, name: '../../../etc/turn 3' });
    expect(((await response.json()) as { path: string }).path).toBe(path.join('.screenshots', 'turn-3.png'));
    expect((await readdir(path.join(root, '.screenshots'))).toSorted()).toEqual(['dev-latest.png', 'turn-3.png']);
  });

  test('a screenshot that is not a PNG is refused', async () => {
    const response = await post(DEV_ENDPOINTS.screenshot, { screenshot: 'data:text/html,<b>' });
    expect(response.status).toBe(400);
  });

  test('anything else is not answered, and the endpoints want POST', async () => {
    expect(await server.handle(new Request('http://localhost/index.html'))).toBeUndefined();
    expect((await server.handle(new Request(`http://localhost${DEV_ENDPOINTS.log}`)))?.status).toBe(405);
  });
});

describe('asking an open page for a report', () => {
  test('with no page connected, says how to connect one', async () => {
    const response = await post(DEV_ENDPOINTS.requestReport, { note: 'x' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('bun run dev');
  });

  test('passes the note to the page and answers with the folder the page saved', async () => {
    const sent: ServerMessage[] = [];
    const page = { send: (text: string) => sent.push(JSON.parse(text) as ServerMessage) };
    server.websocket.open(page as never);
    const pending = post(DEV_ENDPOINTS.requestReport, { note: 'units do not move' });
    await Bun.sleep(0);
    expect(sent).toEqual([{ type: 'report', id: '1', note: 'units do not move' }]);
    server.websocket.message(page as never, JSON.stringify({ type: 'reported', id: '1', path: '.reports/x' }));
    expect(await (await pending).json()).toEqual({ path: '.reports/x' });
    server.websocket.close(page as never);
    expect(server.pages).toBe(0);
  });
});
