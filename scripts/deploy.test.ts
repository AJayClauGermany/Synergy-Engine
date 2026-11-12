import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  accessApplication,
  accessApplicationName,
  allowEmailCodes,
  checkAccount,
  type Account,
  assetBucket,
  deployedUrl,
  moveAssetsToBucket,
  parseAllowed,
  passwordSecrets,
  planUpload,
  protectWithAccess,
  type WorkerConfig,
} from './deploy';

const root = path.resolve(import.meta.dir, '..');
const config = Bun.JSONC.parse(await Bun.file(path.join(root, 'wrangler.jsonc')).text()) as WorkerConfig;

describe('who may open a preview', () => {
  test('addresses and @domains, separated however a person types them', () => {
    expect(parseAllowed('Ada@Studio.com, bob@studio.com\n@partner.org  ada@studio.com')).toEqual({
      emails: ['ada@studio.com', 'bob@studio.com'],
      domains: ['partner.org'],
    });
    expect(parseAllowed('')).toEqual({ emails: [], domains: [] });
  });

  test('a typo is an error, not a silently shorter list', () => {
    expect(() => parseAllowed('ada@studio.com, bob')).toThrow('"bob" is neither');
    expect(() => parseAllowed('studio.com')).toThrow('@studio.com');
  });

  test('the Access application lists exactly those people', () => {
    const allowed = parseAllowed('ada@studio.com @partner.org');
    expect(accessApplication('my-game', 'abc123', allowed, false)).toEqual({
      name: accessApplicationName('my-game'),
      type: 'self_hosted',
      destinations: [{ type: 'worker', worker_id: 'abc123' }],
      session_duration: '168h',
      policies: [
        {
          name: 'Allowed testers',
          decision: 'allow',
          include: [{ email: { email: 'ada@studio.com' } }, { email_domain: { domain: 'partner.org' } }],
        },
      ],
    });
  });

  test('once the game is public, Access guards only the previews', () => {
    const application = accessApplication('my-game', 'abc123', parseAllowed('ada@studio.com'), true);
    expect(application).toMatchObject({ destinations: [{ type: 'preview_worker', worker_id: 'abc123' }] });
  });
});

test('a password reaches wrangler as written, whatever characters it holds', () => {
  const password = 'p$HOME "quoted"\n#日本';
  expect(JSON.parse(passwordSecrets(password))).toEqual({ PREVIEW_PASSWORD: password });
});

describe('assets', () => {
  test('only files the bucket lacks are uploaded', () => {
    const files = ['tree-b2.glb', 'terrain-a1.png', 'music/theme-c3.ogg'];
    expect(planUpload(files, new Set(['terrain-a1.png']))).toEqual({
      upload: ['music/theme-c3.ogg', 'tree-b2.glb'],
      kept: ['terrain-a1.png'],
    });
  });

  test('wrangler.jsonc gives previews and the main deployment the same bucket', () => {
    // Shared on purpose: names are content hashes, so builds never overwrite each other.
    // `bun run rename <name>` writes all three; by hand it is easy to change only "name".
    const fix = `wrangler.jsonc: both "bucket_name"s must be "${config.name}-assets", after "name". Run: bun run rename ${config.name}`;
    expect(assetBucket(config, 'preview'), fix).toBe(`${config.name}-assets`);
    expect(assetBucket(config, 'production'), fix).toBe(`${config.name}-assets`);
    expect(assetBucket({ name: 'no-r2' }, 'preview')).toBeNull();
  });

  test('the build puts imported files where the deploy and the Worker look for them', async () => {
    const build = await Bun.file(path.join(root, 'scripts/build.ts')).text();
    expect(build).toContain("naming: { asset: 'assets/[name]-[hash].[ext]' }");
  });

  test('a desktop build never goes through the deploy, so its assets stay in the app', async () => {
    const { scripts } = (await Bun.file(path.join(root, 'package.json')).json()) as { scripts: Record<string, string> };
    for (const name of ['desktop:dev', 'desktop:build']) {
      expect(scripts[name]).toContain('scripts/build.ts --outdir desktop/dist');
      expect(scripts[name]).not.toContain('deploy');
    }
  });
});

test('the address of a preview is read from what wrangler prints', () => {
  const printed = {
    // Other addresses appear in the output too; only the preview's own counts.
    preview: {
      name: 'pr-12',
      repository: 'https://github.com/studio/my-game',
      urls: ['pr-12-my-game.studio.workers.dev'],
    },
    deployment: { urls: ['https://a1b2c3-my-game.studio.workers.dev'] },
  };
  expect(deployedUrl(`Uploading...\n${JSON.stringify(printed, null, 2)}\n`)).toBe(
    'https://pr-12-my-game.studio.workers.dev',
  );
  expect(deployedUrl('nothing here')).toBeNull();
});

describe('against Cloudflare (a stand-in for its API)', () => {
  // What the account holds, and every change a deploy asked for.
  const buckets = new Set<string>();
  const objects = new Map<string, { type: string | null; bytes: number }>();
  const apps: { id: string; name: string; body: unknown }[] = [];
  const signIns: object[] = [{ type: 'cloudflare' }];
  const changes: string[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const resource = pathname.replace('/accounts/acct', '');
      const json = (result: unknown, status = 200) => Response.json({ success: status < 400, result }, { status });
      const token = request.headers.get('Authorization');
      // A token as docs/setup.md describes it, and one from an older set-up, without the permission to add sign-in methods.
      if (token !== 'Bearer secret-token' && token !== 'Bearer no-sign-in-methods') return json(null, 403);
      if (resource === '/access/identity_providers') {
        if (token !== 'Bearer secret-token') return json(null, 403);
        if (request.method === 'POST') signIns.push((await request.json()) as object);
        return json(signIns);
      }
      if (resource === '/workers/subdomain') return json({ subdomain: 'studio' });
      if (request.method !== 'GET') changes.push(`${request.method} ${resource}`);

      const object = /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(resource);
      if (object) {
        const key = decodeURIComponent(object[2] as string);
        if (!buckets.has(object[1] as string)) return json(null, 404);
        if (request.method === 'PUT') {
          objects.set(key, {
            type: request.headers.get('Content-Type'),
            bytes: (await request.arrayBuffer()).byteLength,
          });
          return json({});
        }
        return objects.has(key) ? new Response('bytes') : json(null, 404);
      }
      const bucket = /^\/r2\/buckets\/([^/]+)$/.exec(resource);
      if (bucket) return buckets.has(bucket[1] as string) ? json({ name: bucket[1] }) : json(null, 404);
      if (resource === '/r2/buckets') {
        buckets.add(((await request.json()) as { name: string }).name);
        return json({});
      }
      if (resource === '/workers/workers/my-game') return json({ id: 'worker-id-1' });
      if (resource.startsWith('/workers/workers/')) return json(null, 404);
      if (resource === '/access/apps' && request.method === 'GET') return json(apps);
      if (resource === '/access/apps') {
        const body = (await request.json()) as { name: string };
        apps.push({ id: 'app-1', name: body.name, body });
        return json({ id: 'app-1', aud: 'aud-tag-1' });
      }
      const app = apps.find((candidate) => resource === `/access/apps/${candidate.id}`);
      if (app && request.method === 'PUT') {
        app.body = await request.json();
        return json({ id: app.id, aud: 'aud-tag-1' });
      }
      return json(null, 400);
    },
  });
  afterAll(() => server.stop(true));
  const account: Account = { id: 'acct', token: 'secret-token', api: server.url.href.replace(/\/$/, '') };

  async function build(files: Record<string, string>): Promise<string> {
    const dist = await mkdtemp(path.join(tmpdir(), 'synergy-deploy-'));
    await Bun.write(path.join(dist, 'index.html'), '<canvas>');
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dist, 'assets', name)), { recursive: true });
      await Bun.write(path.join(dist, 'assets', name), content);
    }
    return dist;
  }

  test('the first deploy creates the bucket and uploads every asset; the build keeps only the page', async () => {
    const dist = await build({ 'terrain-a1.png': 'png', 'models/tree-b2.glb': 'a tree' });
    const summary = await moveAssetsToBucket(account, 'my-game-assets', dist);
    expect(summary).toStartWith('2 uploaded to R2');
    expect(buckets.has('my-game-assets')).toBe(true);
    expect(objects.get('assets/terrain-a1.png')).toEqual({ type: 'image/png', bytes: 3 });
    expect(objects.get('assets/models/tree-b2.glb')).toEqual({ type: 'model/gltf-binary', bytes: 6 });
    expect(existsSync(path.join(dist, 'assets'))).toBe(false);
    expect(existsSync(path.join(dist, 'index.html'))).toBe(true);
    await rm(dist, { recursive: true });
  });

  test('a later deploy uploads only what changed and deletes nothing', async () => {
    changes.length = 0;
    const dist = await build({ 'terrain-a1.png': 'png', 'terrain-c3.png': 'repainted' });
    const summary = await moveAssetsToBucket(account, 'my-game-assets', dist);
    expect(summary).toStartWith('1 uploaded to R2');
    expect(summary).toEndWith('1 already there');
    expect(changes).toEqual(['PUT /r2/buckets/my-game-assets/objects/assets/terrain-c3.png']);
    // The file an older build refers to is still there.
    expect(objects.has('assets/models/tree-b2.glb')).toBe(true);
    await rm(dist, { recursive: true });
  });

  test('a build with no assets touches nothing', async () => {
    changes.length = 0;
    const dist = await build({});
    expect(await moveAssetsToBucket(account, 'another-bucket', dist)).toBe('no hashed assets in this build');
    expect(changes).toEqual([]);
    await rm(dist, { recursive: true });
  });

  test('Access is created once, then updated in place when the list changes', async () => {
    const created = await protectWithAccess(account, { name: 'my-game' }, parseAllowed('ada@studio.com'));
    expect(created.summary).toStartWith('created, admitting ada@studio.com; ');
    // What the deploy hands to the Worker, so that it serves the people Access admits.
    expect(created.aud).toBe('aud-tag-1');
    const updated = await protectWithAccess(account, { name: 'my-game' }, parseAllowed('bob@studio.com @partner.org'));
    expect(updated.summary).toStartWith('updated, admitting bob@studio.com, anyone @partner.org; ');
    expect(apps).toHaveLength(1);
    expect(apps[0]?.body).toEqual(
      accessApplication('my-game', 'worker-id-1', parseAllowed('bob@studio.com @partner.org'), false),
    );
  });

  test('sign-in by emailed code is switched on once; a token that may not do it gets instructions', async () => {
    // The first deploy above found only "Sign in with Cloudflare" and added the emailed code.
    expect(signIns).toEqual([{ type: 'cloudflare' }, { name: 'One-time PIN', type: 'onetimepin', config: {} }]);
    changes.length = 0;
    expect(await allowEmailCodes(account)).toBe('testers sign in with a code mailed to them');
    expect(changes).toEqual([]);
    const limited = await allowEmailCodes({ ...account, token: 'no-sign-in-methods' });
    expect(limited).toContain('Zero Trust > Integrations > Identity providers');
  });

  test('the account check reads only, and says what is missing', async () => {
    changes.length = 0;
    const ready = await checkAccount(account, { ...config, name: 'my-game' });
    expect(ready.map((finding) => [finding.what, finding.ok])).toEqual([
      ['API token and account id', true],
      ['workers.dev subdomain', true],
      ['R2', true],
      ['Zero Trust (Cloudflare Access)', true],
      ['Sign-in by emailed code', true],
    ]);
    expect(ready[1]?.detail).toBe('studio.workers.dev');
    const stranger = await checkAccount({ ...account, token: 'wrong' }, { ...config, name: 'my-game' });
    expect(stranger.every((finding) => !finding.ok)).toBe(true);
    expect(stranger[0]?.detail).toContain('Copy both again');
    expect(stranger[0]?.detail).toContain('Cloudflare answered 403');
    expect(changes).toEqual([]);
  });

  test('errors say what to do', async () => {
    const stranger = { ...account, token: 'wrong' };
    const dist = await build({ 'terrain-a1.png': 'png' });
    await expect(moveAssetsToBucket(stranger, 'my-game-assets', dist)).rejects.toThrow('Cloudflare answered 403');
    await expect(protectWithAccess(account, { name: 'not-deployed' }, parseAllowed('a@b.co'))).rejects.toThrow(
      'no Worker called "not-deployed"',
    );
    // A failed upload leaves the build whole, so nothing is deployed without its assets.
    expect(existsSync(path.join(dist, 'assets/terrain-a1.png'))).toBe(true);
    await rm(dist, { recursive: true });
  });
});
