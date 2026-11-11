/**
 * Cloudflare Worker that serves the built game (dist/) to the people allowed to see it.
 *
 * Every request reaches this Worker first (`run_worker_first` in wrangler.jsonc), so the
 * page, its scripts and its assets are all behind the same gate. A request is served when
 * one of these holds, tried in this order:
 *
 *   1. PUBLIC_ACCESS is "true": the gate is off (a public launch).
 *   2. Cloudflare Access let the request through. Access asks each visitor to sign in and
 *      admits only the emails on your list; `bun run preview:deploy` sets it up.
 *   3. The visitor knows PREVIEW_PASSWORD (a login page, or HTTP Basic auth).
 *
 * It fails closed: when none of the three is configured, nothing is served.
 *
 * Files under /assets/ (images, models, sounds: what the build names by content hash) are
 * read from the R2 bucket bound as ASSET_BUCKET when a deploy put them there, and from the
 * Worker's own static files otherwise. The bucket is private; this Worker is the only way in.
 *
 * Configuration (see docs/deploying.md):
 *   PREVIEW_PASSWORD  secret   The password. Use a long random one.
 *   PUBLIC_ACCESS     var      Set to "true" to switch the gate off.
 *   ASSET_BUCKET      R2       Optional. Where deploys keep the hashed assets.
 */

/** The part of an R2 object this Worker reads. With `onlyIf` unmet there is no `body`. */
interface StoredAsset {
  readonly body?: ReadableStream | null;
  readonly httpEtag: string;
  readonly size: number;
  readonly range?: { offset?: number; length?: number; suffix?: number };
  writeHttpMetadata(headers: Headers): void;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ASSET_BUCKET?: { get(key: string, options: { onlyIf: Headers; range: Headers }): Promise<StoredAsset | null> };
  PREVIEW_PASSWORD?: string;
  PUBLIC_ACCESS?: string;
}

/**
 * What the Worker reads of its execution context. `access` is set by Cloudflare, and only
 * when Cloudflare Access authenticated the request; a visitor cannot forge it with a header.
 */
export interface Context {
  readonly access?: unknown;
}

/** Where the build puts content-hashed files (`naming.asset` in scripts/build.ts). */
const ASSET_PREFIX = '/assets/';
/** A hashed file never changes under its name, so a browser may keep it for good. */
const FOREVER = 'max-age=31536000, immutable';

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
    // `atob` yields one character per byte; decode those bytes as UTF-8 so passwords
    // with non-ASCII characters work here as they do in the login form.
    const bytes = Uint8Array.from(atob(header.slice(6)), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
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
  const forever = copy.headers.get('Cache-Control') === `public, ${FOREVER}`;
  copy.headers.set('Cache-Control', forever ? `private, ${FOREVER}` : 'private, no-cache');
  copy.headers.set('X-Robots-Tag', 'noindex');
  return copy;
}

/** Reads a hashed asset from R2, honouring `If-None-Match` and `Range` (seeking in audio and video). */
async function fromBucket(
  request: Request,
  bucket: NonNullable<Env['ASSET_BUCKET']>,
  key: string,
): Promise<Response | null> {
  const stored = await bucket.get(key, { onlyIf: request.headers, range: request.headers });
  if (!stored) return null;
  const headers = new Headers();
  stored.writeHttpMetadata(headers);
  headers.set('ETag', stored.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  if (!stored.body) return new Response(null, { status: 304, headers });
  if (!request.headers.has('Range') || !stored.range) return new Response(stored.body, { headers });
  const offset = stored.range.offset ?? stored.size - (stored.range.suffix ?? stored.size);
  const length = stored.range.length ?? stored.size - offset;
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${stored.size}`);
  return new Response(stored.body, { status: 206, headers });
}

/** The file a request asks for, once the visitor is allowed to have it. */
async function serve(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(ASSET_PREFIX)) return env.ASSETS.fetch(request);

  let stored: Response | null = null;
  if (env.ASSET_BUCKET && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      stored = await fromBucket(request, env.ASSET_BUCKET, decodeURIComponent(pathname.slice(1)));
    } catch (error) {
      // A malformed path is not a file. Anything else (R2 unreachable) is worth a log line;
      // the Worker's own files below still get a chance to answer.
      if (!(error instanceof URIError)) console.error('Could not read the asset bucket:', error);
    }
  }
  const found = stored ?? (await env.ASSETS.fetch(request));
  // Unknown paths fall back to index.html (wrangler.jsonc). For an asset that would hand an
  // image loader a web page with status 200, so say what happened instead.
  if (!stored && (found.headers.get('Content-Type') ?? '').startsWith('text/html')) {
    return new Response('No such asset.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const response = new Response(found.body, found);
  if (response.ok) response.headers.set('Cache-Control', `public, ${FOREVER}`);
  return response;
}

export async function handleRequest(request: Request, env: Env, context?: Context): Promise<Response> {
  if (env.PUBLIC_ACCESS === 'true') return serve(request, env);
  // Cloudflare Access already checked who this is against the list of allowed emails.
  if (context?.access !== undefined) return privately(await serve(request, env));

  const password = env.PREVIEW_PASSWORD;
  if (!password) {
    return page(
      'Preview locked',
      `<h1>Preview locked</h1>
<p>Nobody has been given access to this deployment yet, so nothing is being served.
Set <code>PREVIEW_ALLOWED_EMAILS</code> and deploy again, or set the
<code>PREVIEW_PASSWORD</code> secret (see docs/deploying.md).</p>`,
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

  return privately(await serve(request, env));
}

export default {
  fetch: handleRequest,
};
