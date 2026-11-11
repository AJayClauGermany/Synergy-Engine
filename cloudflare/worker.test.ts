import { describe, expect, test } from 'bun:test';
import { type Env, handleRequest } from './worker';

const assets = { fetch: async () => new Response('<h1>the game</h1>', { headers: { 'Content-Type': 'text/html' } }) };
const locked: Env = { ASSETS: assets, PREVIEW_PASSWORD: 'correct horse battery staple' };
const origin = 'https://preview.example.workers.dev';

async function login(password: string): Promise<Response> {
  return handleRequest(
    new Request(`${origin}/__auth`, { method: 'POST', body: new URLSearchParams({ password }) }),
    locked,
  );
}

describe('preview gate', () => {
  test('visitors without a session get the login page, not the game', async () => {
    const response = await handleRequest(new Request(`${origin}/`), locked);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Private preview');
    expect(body).not.toContain('the game');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // Asset URLs are protected too, not just the page.
    const asset = await handleRequest(new Request(`${origin}/chunk-abc.js`), locked);
    expect(asset.status).toBe(401);
  });

  test('a wrong password is refused', async () => {
    const response = await login('guess');
    expect(response.status).toBe(401);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.text()).toContain('not correct');
  });

  test('the right password sets a session cookie that unlocks the game', async () => {
    const response = await login('correct horse battery staple');
    expect(response.status).toBe(303);
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // The cookie holds a derived token, never the password itself.
    expect(cookie).not.toContain('correct horse');

    const session = cookie.split(';')[0] as string;
    const game = await handleRequest(new Request(`${origin}/`, { headers: { Cookie: session } }), locked);
    expect(game.status).toBe(200);
    expect(await game.text()).toContain('the game');
    expect(game.headers.get('Cache-Control')).toContain('private');
    expect(game.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('a forged or stale cookie does not work, and changing the password signs everyone out', async () => {
    const forged = await handleRequest(
      new Request(`${origin}/`, { headers: { Cookie: 'synergy_preview=deadbeef' } }),
      locked,
    );
    expect(forged.status).toBe(401);

    const cookie = ((await login('correct horse battery staple')).headers.get('Set-Cookie') ?? '').split(
      ';',
    )[0] as string;
    const rotated = await handleRequest(new Request(`${origin}/`, { headers: { Cookie: cookie } }), {
      ...locked,
      PREVIEW_PASSWORD: 'a new password',
    });
    expect(rotated.status).toBe(401);
  });

  test('automation can use HTTP Basic auth', async () => {
    const header = (password: string) => ({ Authorization: `Basic ${btoa(`agent:${password}`)}` });
    const ok = await handleRequest(
      new Request(`${origin}/`, { headers: header('correct horse battery staple') }),
      locked,
    );
    expect(ok.status).toBe(200);
    const bad = await handleRequest(new Request(`${origin}/`, { headers: header('nope') }), locked);
    expect(bad.status).toBe(401);
  });

  test('passwords with non-ASCII characters work in both the form and Basic auth', async () => {
    const env: Env = { ASSETS: assets, PREVIEW_PASSWORD: 'pässwörd-日本' };
    const form = await handleRequest(
      new Request(`${origin}/__auth`, { method: 'POST', body: new URLSearchParams({ password: 'pässwörd-日本' }) }),
      env,
    );
    expect(form.status).toBe(303);
    // What a browser or curl sends: the UTF-8 bytes of "user:password", base64-encoded.
    const bytes = new TextEncoder().encode('agent:pässwörd-日本');
    const basic = btoa(String.fromCharCode(...bytes));
    const response = await handleRequest(
      new Request(`${origin}/`, { headers: { Authorization: `Basic ${basic}` } }),
      env,
    );
    expect(response.status).toBe(200);
  });

  test('fails closed with no password, and opens only when PUBLIC_ACCESS is "true"', async () => {
    const unconfigured = await handleRequest(new Request(`${origin}/`), { ASSETS: assets });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.text()).not.toContain('the game');

    const stillLocked = await handleRequest(new Request(`${origin}/`), { ASSETS: assets, PUBLIC_ACCESS: 'false' });
    expect(stillLocked.status).toBe(503);

    const open = await handleRequest(new Request(`${origin}/`), { ASSETS: assets, PUBLIC_ACCESS: 'true' });
    expect(open.status).toBe(200);
    expect(await open.text()).toContain('the game');
  });

  test('a request Cloudflare Access let through is served without a password', async () => {
    const env: Env = { ASSETS: assets };
    const response = await handleRequest(new Request(`${origin}/`), env, { access: { aud: 'abc' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('the game');
    expect(response.headers.get('Cache-Control')).toContain('private');
    // A header is not enough: only Cloudflare sets `context.access`.
    const forged = await handleRequest(
      new Request(`${origin}/`, { headers: { 'Cf-Access-Jwt-Assertion': 'anything' } }),
      env,
      {},
    );
    expect(forged.status).toBe(503);
  });
});

describe('hashed assets', () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const requested: string[] = [];
  const bucket: NonNullable<Env['ASSET_BUCKET']> = {
    async get(key, options) {
      requested.push(key);
      if (key !== 'assets/terrain-abc123.png') return null;
      const stored = {
        httpEtag: '"v1"',
        size: png.length,
        writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png'),
      };
      if (options.onlyIf.get('If-None-Match') === '"v1"') return stored;
      if (options.range.has('Range')) {
        return { ...stored, body: new Blob([png.slice(2, 5)]).stream(), range: { offset: 2, length: 3 } };
      }
      return { ...stored, body: new Blob([png]).stream() };
    },
  };
  // What the Worker's static files do: a real file, or index.html for anything unknown.
  const files = {
    fetch: async (request: Request) =>
      new URL(request.url).pathname === '/assets/local-def456.glb'
        ? new Response('model', { headers: { 'Content-Type': 'model/gltf-binary' } })
        : new Response('<h1>the game</h1>', { headers: { 'Content-Type': 'text/html' } }),
  };
  const open: Env = { ASSETS: files, ASSET_BUCKET: bucket, PUBLIC_ACCESS: 'true' };

  test('come from the bucket, cacheable for good', async () => {
    const response = await handleRequest(new Request(`${origin}/assets/terrain-abc123.png`), open);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  test('answer revalidation and range requests', async () => {
    const unchanged = await handleRequest(
      new Request(`${origin}/assets/terrain-abc123.png`, { headers: { 'If-None-Match': '"v1"' } }),
      open,
    );
    expect(unchanged.status).toBe(304);
    const part = await handleRequest(
      new Request(`${origin}/assets/terrain-abc123.png`, { headers: { Range: 'bytes=2-4' } }),
      open,
    );
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 2-4/8');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.slice(2, 5));
  });

  test('fall back to the files deployed with the Worker, and a missing one is a 404, not the page', async () => {
    const local = await handleRequest(new Request(`${origin}/assets/local-def456.glb`), open);
    expect(await local.text()).toBe('model');
    const missing = await handleRequest(new Request(`${origin}/assets/gone-000000.png`), open);
    expect(missing.status).toBe(404);
    // With no bucket bound (R2 not in use) the Worker's own files answer.
    const unbound = await handleRequest(new Request(`${origin}/assets/local-def456.glb`), {
      ASSETS: files,
      PUBLIC_ACCESS: 'true',
    });
    expect(await unbound.text()).toBe('model');
  });

  test('are behind the gate like everything else, and only /assets/ reaches the bucket', async () => {
    requested.length = 0;
    const gated: Env = { ASSETS: files, ASSET_BUCKET: bucket, PREVIEW_PASSWORD: 'correct horse battery staple' };
    const refused = await handleRequest(new Request(`${origin}/assets/terrain-abc123.png`), gated);
    expect(refused.status).toBe(401);
    expect(requested).toEqual([]);

    const allowed = await handleRequest(new Request(`${origin}/assets/terrain-abc123.png`), gated, { access: {} });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');

    await handleRequest(new Request(`${origin}/index.html`), open);
    expect(requested).toEqual(['assets/terrain-abc123.png']);
  });
});
