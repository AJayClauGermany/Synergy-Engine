/**
 * Cloudflare Worker that serves the built game (dist/) behind a password.
 *
 * Every request reaches this Worker first (`run_worker_first` in wrangler.jsonc). Visitors
 * without a valid session get a login page; everyone else gets the static files.
 *
 * Configuration (see docs/deploying.md):
 *   PREVIEW_PASSWORD  secret   The password. Use a long random one.
 *   PUBLIC_ACCESS     var      Set to "true" to switch the gate off (a public launch).
 *
 * It fails closed: with no password and no PUBLIC_ACCESS, nothing is served.
 *
 * This is a shared-password gate for prototypes. To restrict by identity (your team's
 * email domain, single sign-on), put Cloudflare Access in front instead.
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PREVIEW_PASSWORD?: string;
  PUBLIC_ACCESS?: string;
}

const COOKIE = 'synergy_preview';
const LOGIN_PATH = '/__auth';
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

/** The session token: an HMAC keyed by the password, so changing the password signs everyone out. */
async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('synergy-preview-session-v1'));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares without leaking, through timing, how many leading characters matched. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  // Hash both sides first so the comparison always runs over equal-length buffers.
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= (x[i] as number) ^ (y[i] as number);
  return difference === 0;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Automation (curl, CI, agents) can send the password with HTTP Basic auth; the user name is ignored. */
function basicPassword(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    return decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return null;
  }
}

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1d2733; color: #e9eef4;
         font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(22rem, calc(100vw - 2rem)); padding: 1.5rem; background: #121922; border: 1px solid #ffffff1a;
         border-radius: 12px; }
  h1 { margin: 0 0 .25rem; font-size: 1.15rem; }
  p { margin: 0 0 1rem; color: #9fb0c2; }
  input, button { font: inherit; width: 100%; padding: .6rem .75rem; border-radius: 8px; border: 1px solid #ffffff26; }
  input { background: #0c1117; color: inherit; margin-bottom: .75rem; }
  button { background: #f2d264; color: #1b1f24; font-weight: 600; border-color: transparent; cursor: pointer; }
  .error { color: #ef6a5a; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function loginPage(failed: boolean, status: number): Response {
  return page(
    'Preview access',
    `<h1>Private preview</h1>
<p>Enter the password you were given to open this build.</p>
${failed ? '<p class="error" role="alert">That password is not correct.</p>' : ''}
<form method="post" action="${LOGIN_PATH}">
  <input type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Open preview</button>
</form>`,
    status,
  );
}

/** Marks gated responses as private so no shared cache or search engine keeps a copy. */
function privately(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', 'private, no-cache');
  copy.headers.set('X-Robots-Tag', 'noindex');
  return copy;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (env.PUBLIC_ACCESS === 'true') return env.ASSETS.fetch(request);

  const password = env.PREVIEW_PASSWORD;
  if (!password) {
    return page(
      'Preview locked',
      `<h1>Preview locked</h1>
<p>No password has been configured for this deployment, so nothing is being served.
Set the <code>PREVIEW_PASSWORD</code> secret (see docs/deploying.md).</p>`,
      503,
    );
  }

  const url = new URL(request.url);
  const expected = await sessionToken(password);

  if (url.pathname === LOGIN_PATH) {
    if (request.method !== 'POST') return Response.redirect(new URL('/', url).href, 303);
    const form = await request.formData().catch(() => null);
    const attempt = form?.get('password');
    if (typeof attempt !== 'string' || !(await safeEqual(attempt, password))) return loginPage(true, 401);
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${expected}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const cookie = cookieValue(request, COOKIE);
  const basic = basicPassword(request);
  const allowed =
    (cookie !== null && (await safeEqual(cookie, expected))) || (basic !== null && (await safeEqual(basic, password)));
  if (!allowed) return loginPage(false, 401);

  return privately(await env.ASSETS.fetch(request));
}

export default {
  fetch: handleRequest,
};
