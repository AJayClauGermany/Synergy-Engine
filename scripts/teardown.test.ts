import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { accessApplicationName, type Account } from './deploy';
import { assetBuckets, teardown } from './teardown';

test('previews and the main deployment share one bucket, which is listed once', () => {
  const shared = [{ binding: 'ASSET_BUCKET', bucket_name: 'my-game-assets' }];
  expect(assetBuckets({ name: 'my-game', r2_buckets: shared, previews: { r2_buckets: shared } })).toEqual([
    'my-game-assets',
  ]);
  expect(assetBuckets({ name: 'no-r2' })).toEqual([]);
});

describe('against Cloudflare (a stand-in for its API)', () => {
  // What the account holds.
  let workers: Set<string>;
  let apps: { id: string; name: string }[];
  let buckets: Map<string, Set<string>>;
  const changes: string[] = [];

  beforeEach(() => {
    workers = new Set(['my-game', 'other-game']);
    apps = [
      { id: 'app-1', name: accessApplicationName('my-game') },
      { id: 'app-2', name: accessApplicationName('other-game') },
    ];
    // More objects than one listing returns, one of them with a name that needs escaping.
    const objects = Array.from({ length: 2500 }, (_, index) => `assets/file-${index}.png`);
    buckets = new Map([
      ['my-game-assets', new Set([...objects, 'assets/models/old tree-b2.glb'])],
      ['other-game-assets', new Set(['assets/keep.png'])],
    ]);
    changes.length = 0;
  });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const resource = pathname.replace('/accounts/acct', '');
      const json = (result: unknown, status = 200) => Response.json({ success: status < 400, result }, { status });
      const token = request.headers.get('Authorization');
      const remove = request.method === 'DELETE';
      if (token === 'Bearer wrong') return json(null, 403);
      // A token that may deploy Workers and nothing else.
      if (token === 'Bearer workers-only' && remove && !resource.startsWith('/workers/')) return json(null, 403);
      if (token === 'Bearer no-workers' && remove && resource.startsWith('/workers/')) return json(null, 403);
      if (request.method !== 'GET') changes.push(`${request.method} ${resource}`);

      const worker = /^\/workers\/workers\/([^/]+)$/.exec(resource)?.[1];
      if (worker) {
        if (!workers.has(worker)) return json(null, 404);
        if (remove) workers.delete(worker);
        return json({ id: `id-of-${worker}` });
      }
      if (resource === '/access/apps') return json(apps);
      const app = apps.find((candidate) => resource === `/access/apps/${candidate.id}`);
      if (app && remove) {
        apps.splice(apps.indexOf(app), 1);
        return json({ id: app.id });
      }
      const object = /^\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/.exec(resource);
      const stored = buckets.get(object?.[1] ?? /^\/r2\/buckets\/([^/]+)$/.exec(resource)?.[1] ?? '');
      if (!stored) return json(null, 404);
      if (object?.[2]) return stored.delete(decodeURIComponent(object[2])) ? json({}) : json(null, 404);
      if (object) return json([...stored].slice(0, 1000).map((key) => ({ key })));
      if (!remove) return json({ name: 'a bucket' });
      // As Cloudflare does: a bucket that still holds objects is not deleted.
      if (stored.size > 0) return json(null, 409);
      buckets.delete(resource.replace('/r2/buckets/', ''));
      return json({});
    },
  });
  afterAll(() => server.stop(true));
  const account: Account = { id: 'acct', token: 'secret-token', api: server.url.href.replace(/\/$/, '') };
  const config = {
    name: 'my-game',
    r2_buckets: [{ binding: 'ASSET_BUCKET', bucket_name: 'my-game-assets' }],
  };

  test('without --confirm it reads only, and says what it would delete', async () => {
    const steps = await teardown(account, config, false);
    expect(steps.map((step) => step.outcome)).toEqual(['found', 'found', 'found']);
    expect(steps[2]?.detail).toContain('1000 objects or more');
    expect(changes).toEqual([]);
  });

  test('it deletes the Worker, its Access application and its bucket, and nothing of another game', async () => {
    const steps = await teardown(account, config, true);
    expect(steps.map((step) => [step.what, step.outcome])).toEqual([
      ['Worker "my-game"', 'deleted'],
      [`Access application "${accessApplicationName('my-game')}"`, 'deleted'],
      ['R2 bucket "my-game-assets"', 'deleted'],
    ]);
    expect(steps[2]?.detail).toBe('after deleting its 2501 objects');
    expect([...workers]).toEqual(['other-game']);
    expect(apps).toEqual([{ id: 'app-2', name: accessApplicationName('other-game') }]);
    expect([...buckets.keys()]).toEqual(['other-game-assets']);
    expect(buckets.get('other-game-assets')?.size).toBe(1);
    // The Worker goes first, so that it is never left serving without Access in front.
    expect(changes[0]).toBe('DELETE /workers/workers/my-game');
    expect(changes[1]).toBe('DELETE /access/apps/app-1');
    expect(changes.at(-1)).toBe('DELETE /r2/buckets/my-game-assets');
  });

  test('a second run finds nothing and changes nothing', async () => {
    await teardown(account, config, true);
    changes.length = 0;
    const steps = await teardown(account, config, true);
    expect(steps.map((step) => step.outcome)).toEqual(['absent', 'absent', 'absent']);
    expect(changes).toEqual([]);
  });

  test('what the token may not delete is reported with the permission it lacks, and the rest still goes', async () => {
    const steps = await teardown({ ...account, token: 'workers-only' }, config, true);
    expect(steps.map((step) => step.outcome)).toEqual(['deleted', 'failed', 'failed']);
    expect(steps[1]?.detail).toContain('Cloudflare answered 403');
    expect(steps[1]?.detail).toContain('"Access: Apps and Policies: Edit"');
    expect(steps[2]?.detail).toContain('"Workers R2 Storage: Edit"');
    expect(buckets.get('my-game-assets')?.size).toBe(2501);
  });

  test('while the Worker cannot be deleted, its Access application stays in front of it', async () => {
    const steps = await teardown({ ...account, token: 'no-workers' }, config, true);
    expect(steps.map((step) => step.outcome)).toEqual(['failed', 'kept', 'deleted']);
    expect(apps).toHaveLength(2);
    expect(workers.has('my-game')).toBe(true);
  });

  test('a token Cloudflare does not accept fails every step and changes nothing', async () => {
    const steps = await teardown({ ...account, token: 'wrong' }, config, true);
    expect(steps.map((step) => step.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(workers.size + apps.length + buckets.size).toBe(6);
  });
});
