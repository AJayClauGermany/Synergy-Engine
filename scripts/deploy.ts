/**
 * Deploys the game to Cloudflare, with everything a deploy needs done on the way:
 *
 *   bun run preview:deploy [--name pr-12]   a Preview of the current branch (or the name given)
 *   bun run deploy                          the main deployment
 *
 *   1. Builds the game into dist/.
 *   2. Moves the content-hashed files in dist/assets/ (images, models, sounds) to the R2
 *      bucket named in wrangler.jsonc. Only files the bucket does not hold yet are
 *      uploaded, so a change to code uploads no assets at all. Nothing is ever deleted
 *      from the bucket: an older build keeps finding the files it was built with.
 *   3. Runs wrangler, which uploads the page and its scripts.
 *   4. Puts Cloudflare Access in front, admitting the emails in PREVIEW_ALLOWED_EMAILS.
 *
 * Steps 2 and 4 call Cloudflare's API and so need CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID (CI has them; `wrangler login` alone does not provide them).
 * Without them the deploy still works: the assets travel with the Worker and the password
 * gate applies. docs/deploying.md has the whole picture.
 */
import { appendFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dir, '..');
/** The folder, inside the build, of files named by content hash (`naming.asset` in build.ts). */
const ASSET_DIR = 'assets';
/** One request to Cloudflare's API takes at most this much (`wrangler r2 object put` has the same limit). */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
/** Workers refuses a static file larger than this, which is one reason big assets go to R2. */
const MAX_STATIC_BYTES = 25 * 1024 * 1024;

/** The parts of wrangler.jsonc this script reads. */
export interface WorkerConfig {
  name: string;
  vars?: Record<string, unknown>;
  r2_buckets?: { binding: string; bucket_name?: string }[];
  previews?: { r2_buckets?: { binding: string; bucket_name?: string }[] };
}

export type Target = 'preview' | 'production';

/** The bucket a deploy of this kind reads its assets from, or null when R2 is not in use. */
export function assetBucket(config: WorkerConfig, target: Target): string | null {
  const buckets = (target === 'preview' ? config.previews?.r2_buckets : config.r2_buckets) ?? [];
  return buckets.find((bucket) => bucket.binding === 'ASSET_BUCKET')?.bucket_name ?? null;
}

/** Who may open a gated deployment: single addresses, and whole domains written as `@studio.com`. */
export interface Allowed {
  emails: string[];
  domains: string[];
}

/** Reads PREVIEW_ALLOWED_EMAILS: entries separated by commas, spaces or new lines. */
export function parseAllowed(text: string): Allowed {
  const allowed: Allowed = { emails: [], domains: [] };
  for (const entry of new Set(
    text
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean),
  )) {
    if (/^@[^@\s]+\.[^@\s]+$/.test(entry)) allowed.domains.push(entry.slice(1));
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry)) allowed.emails.push(entry);
    else {
      throw new Error(
        `PREVIEW_ALLOWED_EMAILS: "${entry}" is neither an email address nor a domain. ` +
          'Write addresses as ada@studio.com and whole domains as @studio.com.',
      );
    }
  }
  return allowed;
}

/** The name of the Access application that guards a Worker. One per Worker; a deploy updates it. */
export function accessApplicationName(worker: string): string {
  return `${worker} (Synergy preview gate)`;
}

/**
 * The Access application for a Worker. While the game is not public it covers the main
 * deployment and every Preview; once PUBLIC_ACCESS is "true" it covers only the Previews.
 */
export function accessApplication(worker: string, workerId: string, allowed: Allowed, isPublic: boolean): object {
  return {
    name: accessApplicationName(worker),
    type: 'self_hosted',
    destinations: [{ type: isPublic ? 'preview_worker' : 'worker', worker_id: workerId }],
    session_duration: '168h',
    policies: [
      {
        name: 'Allowed testers',
        decision: 'allow',
        include: [
          ...allowed.emails.map((email) => ({ email: { email } })),
          ...allowed.domains.map((domain) => ({ email_domain: { domain } })),
        ],
      },
    ],
  };
}

/** The address of a Preview, read from what `wrangler preview --json` prints. */
export function deployedUrl(output: string): string | null {
  try {
    const printed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) as {
      preview?: { urls?: string[] };
      deployment?: { urls?: string[] };
    };
    const url = printed.preview?.urls?.[0] ?? printed.deployment?.urls?.[0];
    if (!url) return null;
    return url.startsWith('http') ? url : `https://${url}`;
  } catch {
    return null;
  }
}

/** Splits the files of a build into those the bucket still needs and those it has. */
export function planUpload(files: string[], stored: ReadonlySet<string>): { upload: string[]; kept: string[] } {
  return {
    upload: files.filter((file) => !stored.has(file)).sort(),
    kept: files.filter((file) => stored.has(file)).sort(),
  };
}

// ---- Cloudflare's API -------------------------------------------------------------------

export interface Account {
  id: string;
  token: string;
  /** Where the API lives. wrangler reads the same CLOUDFLARE_API_BASE_URL; tests point it at a stand-in. */
  api: string;
}

class ApiError extends Error {}

async function call(account: Account, method: string, resource: string, body?: BodyInit, type?: string) {
  const response = await fetch(`${account.api}/accounts/${account.id}${resource}`, {
    method,
    body,
    headers: { Authorization: `Bearer ${account.token}`, ...(type ? { 'Content-Type': type } : {}) },
  });
  if (response.ok || response.status === 404) return response;
  const text = await response.text();
  throw new ApiError(`Cloudflare answered ${response.status} to ${method} ${resource}:\n${text.slice(0, 600)}`);
}

/** A JSON call. Gives null for "no such thing" (404). */
async function api<Result>(account: Account, method: string, resource: string, body?: object): Promise<Result | null> {
  const response = await call(account, method, resource, body && JSON.stringify(body), 'application/json');
  if (response.status === 404) return null;
  return ((await response.json()) as { result: Result }).result;
}

/** Runs `work` over `items`, a few at a time: fast, without opening a connection per file. */
async function inParallel<Item>(items: Item[], limit: number, work: (item: Item) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Step 2: the hashed assets go to R2 and leave the build, so wrangler has less to upload. */
export async function moveAssetsToBucket(account: Account, bucket: string, dist: string): Promise<string> {
  const dir = path.join(dist, ASSET_DIR);
  const files = await listFiles(dir);
  if (files.length === 0) return 'no hashed assets in this build';

  if ((await api(account, 'GET', `/r2/buckets/${bucket}`)) === null) {
    try {
      await api(account, 'POST', '/r2/buckets', { name: bucket });
    } catch (error) {
      throw new Error(
        `Could not create the R2 bucket "${bucket}". R2 has to be switched on once for the account ` +
          `(Cloudflare dashboard, "R2 Object Storage"), and the API token needs "Workers R2 Storage: Edit".\n${String(error)}`,
        { cause: error },
      );
    }
    console.log(`Created the R2 bucket ${bucket}.`);
  }

  const object = (file: string) =>
    `/r2/buckets/${bucket}/objects/${ASSET_DIR}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const stored = new Set<string>();
  await inParallel(files, 16, async (file) => {
    // The name holds a hash of the content, so a file that is there is the right file.
    const response = await call(account, 'GET', object(file));
    await response.body?.cancel();
    if (response.ok) stored.add(file);
  });

  const { upload, kept } = planUpload(files, stored);
  let bytes = 0;
  await inParallel(upload, 6, async (file) => {
    const content = Bun.file(path.join(dir, file));
    if (content.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${ASSET_DIR}/${file} is ${megabytes(content.size)}; one upload takes at most ${megabytes(MAX_UPLOAD_BYTES)}. ` +
          'Split the file or compress it.',
      );
    }
    const response = await call(account, 'PUT', object(file), content, content.type || 'application/octet-stream');
    if (!response.ok) throw new Error(`The bucket ${bucket} disappeared while uploading ${file}.`);
    bytes += content.size;
  });

  // From here on the Worker reads these from the bucket (cloudflare/worker.ts).
  await rm(dir, { recursive: true });
  return `${upload.length} uploaded to R2 (${megabytes(bytes)}), ${kept.length} already there`;
}

/** Step 4: Cloudflare Access in front of the Worker, for exactly the people on the list. */
export async function protectWithAccess(account: Account, config: WorkerConfig, allowed: Allowed): Promise<string> {
  const worker = await api<{ id: string }>(account, 'GET', `/workers/workers/${config.name}`);
  if (!worker) throw new Error(`Cloudflare has no Worker called "${config.name}", so Access has nothing to protect.`);

  const name = accessApplicationName(config.name);
  let existing: { id: string } | undefined;
  for (let page = 1; !existing; page++) {
    const apps =
      (await api<{ id: string; name: string }[]>(account, 'GET', `/access/apps?per_page=50&page=${page}`)) ?? [];
    existing = apps.find((app) => app.name === name);
    if (apps.length < 50) break;
  }

  const application = accessApplication(config.name, worker.id, allowed, config.vars?.PUBLIC_ACCESS === 'true');
  try {
    if (existing) await api(account, 'PUT', `/access/apps/${existing.id}`, application);
    else await api(account, 'POST', '/access/apps', application);
  } catch (error) {
    throw new Error(
      'Could not set up Cloudflare Access. It needs Zero Trust switched on once for the account (Cloudflare ' +
        `dashboard, "Zero Trust": pick a team name and the free plan) and "Access: Apps and Policies: Edit" on the API token.\n${String(error)}`,
      { cause: error },
    );
  }
  const people = [...allowed.emails, ...allowed.domains.map((domain) => `anyone @${domain}`)];
  return `${existing ? 'updated' : 'created'}, admitting ${people.join(', ')}`;
}

// ---- The deploy ---------------------------------------------------------------------------

async function run(command: string[], capture = false): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: 'inherit',
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  const output = capture ? await new Response(child.stdout).text() : '';
  if ((await child.exited) !== 0) {
    if (output) console.error(output);
    throw new Error(`\`${command.join(' ')}\` failed.`);
  }
  return output;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { name: { type: 'string' } },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (target !== 'preview' && target !== 'production') {
    console.error('Usage: bun scripts/deploy.ts preview [--name <preview-name>] | production');
    return 1;
  }

  const config = Bun.JSONC.parse(await Bun.file(path.join(root, 'wrangler.jsonc')).text()) as WorkerConfig;
  const dist = path.join(root, 'dist');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  const api = process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4';
  const account = token && id ? { token, id, api } : null;
  const allowed = parseAllowed(process.env.PREVIEW_ALLOWED_EMAILS ?? '');
  const hasAllowed = allowed.emails.length + allowed.domains.length > 0;
  const bucket = assetBucket(config, target);
  const report: string[] = [];

  await run([process.execPath, 'scripts/build.ts']);

  if (bucket && account) {
    report.push(`Assets: ${await moveAssetsToBucket(account, bucket, dist)}.`);
  } else {
    const assets = await listFiles(path.join(dist, ASSET_DIR));
    const large = assets.filter((file) => Bun.file(path.join(dist, ASSET_DIR, file)).size > MAX_STATIC_BYTES);
    const why = bucket
      ? 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set'
      : 'wrangler.jsonc names no ASSET_BUCKET';
    report.push(`Assets: ${assets.length} uploaded with the Worker, because ${why}.`);
    if (large.length > 0) {
      console.error(`Too large to deploy with the Worker (over ${megabytes(MAX_STATIC_BYTES)}): ${large.join(', ')}.`);
      console.error('Deploy with the API token set so they go to R2 (docs/deploying.md).');
      return 1;
    }
  }

  const wrangler = [process.execPath, 'x', 'wrangler'];
  let url: string | null = null;
  if (target === 'preview') {
    const output = await run([...wrangler, 'preview', ...(values.name ? ['--name', values.name] : []), '--json'], true);
    url = deployedUrl(output);
    if (!url) console.log(output);
  } else {
    await run([...wrangler, 'deploy']);
  }

  // After wrangler, because the first deploy is what creates the Worker. Until Access is in
  // place the Worker answers nobody (it fails closed), so there is no open window.
  if (hasAllowed && account) {
    report.push(`Cloudflare Access: ${await protectWithAccess(account, config, allowed)}.`);
  } else if (hasAllowed) {
    report.push('Cloudflare Access: NOT set up, because CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set.');
  } else {
    report.push(
      'Cloudflare Access: left as it is, because PREVIEW_ALLOWED_EMAILS is empty. The password gate applies.',
    );
  }

  if (url) report.unshift(`Deployed ${url}`);
  console.log(`\n${report.join('\n')}`);
  // In GitHub Actions: the address for later steps, and the report on the run's page.
  if (process.env.GITHUB_OUTPUT && url) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${target === 'preview' ? 'Preview' : 'Deployment'}\n\n${report.join('\n\n')}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
