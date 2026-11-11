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
});
