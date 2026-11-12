/**
 * Deploys the game to Cloudflare, with everything a deploy needs done on the way:
 *
 *   bun run preview:deploy [--name pr-12]   a Preview of the current branch (or the name given)
 *   bun run deploy                          the main deployment
 *
 *   bun run cloudflare:check                changes nothing: is the account ready to deploy to?
 *
 *   1. Builds the game into dist/.
 *   2. Moves the content-hashed files in dist/assets/ (images, models, sounds) to the R2
 *      bucket named in wrangler.jsonc. Only files the bucket does not hold yet are
 *      uploaded, so a change to code uploads no assets at all. Nothing is ever deleted
 *      from the bucket: an older build keeps finding the files it was built with.
 *   3. Puts Cloudflare Access in front, admitting the emails in PREVIEW_ALLOWED_EMAILS, and
 *      switches on sign-in by emailed code where the account lacks it.
 *   4. Runs wrangler, which uploads the page and its scripts, and tells the Worker that
 *      Access guards it (ACCESS_AUD in cloudflare/worker.ts). The very first deploy runs
 *      wrangler twice: Access needs the Worker to exist, and the Worker stays locked until
 *      Access does.
 *
 * Steps 2 and 3 call Cloudflare's API and so need CLOUDFLARE_API_TOKEN and
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

/** Whether Cloudflare already has a Worker of this name, and its id if so. */
async function findWorker(account: Account, name: string): Promise<string | null> {
  return (await api<{ id: string }>(account, 'GET', `/workers/workers/${name}`))?.id ?? null;
}

/** What Cloudflare calls sign-in by a code mailed to the visitor. */
const EMAIL_CODE = 'onetimepin';
const EMAIL_CODE_BY_HAND =
  'in the Cloudflare dashboard open Zero Trust > Integrations > Identity providers > Add new identity provider > One-time PIN';

/**
 * Makes sure visitors can sign in with a code mailed to them. A new Zero Trust account
 * offers only "Sign in with Cloudflare", which a tester without a Cloudflare account
 * cannot use. Never fails a deploy: when the token may not do this, it says how to by hand.
 */
export async function allowEmailCodes(account: Account): Promise<string> {
  try {
    const methods = (await api<{ type: string }[]>(account, 'GET', '/access/identity_providers')) ?? [];
    if (methods.some((method) => method.type === EMAIL_CODE)) return 'testers sign in with a code mailed to them';
    await api(account, 'POST', '/access/identity_providers', { name: 'One-time PIN', type: EMAIL_CODE, config: {} });
    return 'switched on sign-in by a code mailed to the tester';
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return (
      'could not check that testers can sign in with a code mailed to them. If the sign-in page offers ' +
      `only "Sign in with Cloudflare", ${EMAIL_CODE_BY_HAND} (or add "Access: Organizations, Identity ` +
      'Providers, and Groups: Edit" to the API token and deploy again)'
    );
  }
}

/**
 * Step 3: Cloudflare Access in front of the Worker, for exactly the people on the list.
 * `aud` is the application's audience tag, which the deploy hands to the Worker.
 */
export async function protectWithAccess(
  account: Account,
  config: WorkerConfig,
  allowed: Allowed,
): Promise<{ summary: string; aud: string }> {
  const workerId = await findWorker(account, config.name);
  if (!workerId) throw new Error(`Cloudflare has no Worker called "${config.name}", so Access has nothing to protect.`);

  const name = accessApplicationName(config.name);
  let existing: { id: string } | undefined;
  for (let page = 1; !existing; page++) {
    const apps =
      (await api<{ id: string; name: string }[]>(account, 'GET', `/access/apps?per_page=50&page=${page}`)) ?? [];
    existing = apps.find((app) => app.name === name);
    if (apps.length < 50) break;
  }

  const application = accessApplication(config.name, workerId, allowed, config.vars?.PUBLIC_ACCESS === 'true');
  let saved: { id: string; aud?: string } | null;
  try {
    saved = existing
      ? await api(account, 'PUT', `/access/apps/${existing.id}`, application)
      : await api(account, 'POST', '/access/apps', application);
  } catch (error) {
    throw new Error(
      'Could not set up Cloudflare Access. It needs Zero Trust switched on once for the account (Cloudflare ' +
        `dashboard, "Zero Trust": pick a team name and the free plan) and "Access: Apps and Policies: Edit" on the API token.\n${String(error)}`,
      { cause: error },
    );
  }
  if (!saved) throw new Error(`The Access application "${name}" disappeared while it was being updated. Deploy again.`);
  const people = [...allowed.emails, ...allowed.domains.map((domain) => `anyone @${domain}`)];
  return {
    summary: `${existing ? 'updated' : 'created'}, admitting ${people.join(', ')}; ${await allowEmailCodes(account)}`,
    aud: saved.aud ?? saved.id,
  };
}

// ---- Is the account ready? -------------------------------------------------------------------

/** One line of `bun run cloudflare:check`. */
export interface Finding {
  ok: boolean;
  what: string;
  /** What was found, or what to do about it. */
  detail: string;
}

/**
 * Looks at the account without changing it, so that a missing switch or permission shows up
 * here rather than halfway through a deploy. It only reads, so it cannot tell "Read" from
 * "Edit" on the token; the first deploy does that.
 */
export async function checkAccount(account: Account, config: WorkerConfig): Promise<Finding[]> {
  const findings: Finding[] = [];
  const look = async (what: string, fix: string, read: () => Promise<string | null>) => {
    try {
      const found = await read();
      findings.push(found === null ? { ok: false, what, detail: fix } : { ok: true, what, detail: found });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const answer = error.message.split('\n').slice(0, 2).join(' ').slice(0, 300);
      findings.push({ ok: false, what, detail: `${fix}\n(${answer})` });
    }
  };

  await look(
    'API token and account id',
    'Cloudflare does not accept this token for this account. Copy both again: the token is shown once, when it ' +
      'is created; the account id is on the Workers & Pages overview. The token needs "Workers Scripts: Edit".',
    async () => {
      const worker = await findWorker(account, config.name);
      return worker ? `accepted; the Worker "${config.name}" exists` : `accepted; "${config.name}" is not deployed yet`;
    },
  );
  await look(
    'workers.dev subdomain',
    'Open Workers & Pages in the Cloudflare dashboard once: a new account is asked to choose its subdomain.',
    async () => {
      const found = await api<{ subdomain?: string }>(account, 'GET', '/workers/subdomain');
      return found?.subdomain ? `${found.subdomain}.workers.dev` : null;
    },
  );
  const bucket = assetBucket(config, 'preview');
  if (bucket) {
    await look(
      'R2',
      'Switch R2 on (Cloudflare dashboard, R2 Object Storage; it asks for a payment method) and give the token ' +
        '"Workers R2 Storage: Edit".',
      async () => {
        const found = await api(account, 'GET', `/r2/buckets/${bucket}`);
        return found ? `on; the bucket "${bucket}" exists` : `on; the first deploy creates "${bucket}"`;
      },
    );
  }
  await look(
    'Zero Trust (Cloudflare Access)',
    'Open Zero Trust in the Cloudflare dashboard once (pick a team name and the free plan) and give the token ' +
      '"Access: Apps and Policies: Edit".',
    async () => {
      const apps = (await api<{ name: string }[]>(account, 'GET', '/access/apps?per_page=50')) ?? [];
      const ours = apps.some((app) => app.name === accessApplicationName(config.name));
      return ours ? 'on; this game has its Access application' : 'on; the first deploy creates the Access application';
    },
  );
  await look(
    'Sign-in by emailed code',
    `Optional. Without it, testers need a Cloudflare account to sign in. To switch it on, ${EMAIL_CODE_BY_HAND}; ` +
      'or give the token "Access: Organizations, Identity Providers, and Groups: Edit" and a deploy does it.',
    async () => {
      const methods = (await api<{ type: string }[]>(account, 'GET', '/access/identity_providers')) ?? [];
      return methods.some((method) => method.type === EMAIL_CODE) ? 'on' : 'off; a deploy switches it on';
    },
  );
  return findings;
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
  if (target !== 'preview' && target !== 'production' && target !== 'check') {
    console.error('Usage: bun scripts/deploy.ts preview [--name <preview-name>] | production | check');
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

  if (target === 'check') {
    if (!account) {
      console.error(
        'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set. Put them in .env.local (docs/setup.md, step 5).',
      );
      return 1;
    }
    const findings = await checkAccount(account, config);
    const people = [...allowed.emails, ...allowed.domains.map((domain) => `anyone @${domain}`)];
    findings.push({
      ok: hasAllowed,
      what: 'PREVIEW_ALLOWED_EMAILS',
      detail: hasAllowed
        ? people.join(', ')
        : 'Empty, so nobody could open a deployment. Add your own address in .env.local.',
    });
    for (const finding of findings) {
      console.log(
        `${finding.ok ? 'ok     ' : 'MISSING'}  ${finding.what}: ${finding.detail.replaceAll('\n', '\n         ')}`,
      );
    }
    // Sign-in by emailed code is a convenience: a deploy works without it.
    const blocking = findings.filter((finding) => !finding.ok && finding.what !== 'Sign-in by emailed code');
    console.log(
      blocking.length === 0
        ? '\nREADY. Next: bun run preview:deploy --name setup-test'
        : '\nNOT READY. Fix what is MISSING, then run this again.',
    );
    return blocking.length === 0 ? 0 : 1;
  }

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

  /** Runs wrangler and gives a Preview's address. `aud` set means Access is in front, and the Worker is told so. */
  const publish = async (aud: string | null): Promise<string | null> => {
    const wrangler = [process.execPath, 'x', 'wrangler'];
    const vars = aud ? ['--var', `ACCESS_AUD:${aud}`] : [];
    if (target === 'preview') {
      const name = values.name ? ['--name', values.name] : [];
      const output = await run([...wrangler, 'preview', ...name, ...vars, '--json'], true);
      const address = deployedUrl(output);
      if (!address) console.log(output);
      return address;
    }
    await run([...wrangler, 'deploy', ...vars]);
    return null;
  };

  let url: string | null;
  if (hasAllowed && account) {
    // Access attaches to the Worker, so the Worker has to exist first. A Worker deployed
    // without ACCESS_AUD answers nobody (it fails closed), so there is no open window.
    if (!(await findWorker(account, config.name))) {
      console.log(`First deploy of "${config.name}": creating the Worker, then putting Access in front.`);
      await publish(null);
    }
    const access = await protectWithAccess(account, config, allowed);
    url = await publish(access.aud);
    report.push(`Cloudflare Access: ${access.summary}.`);
  } else {
    url = await publish(null);
    report.push(
      hasAllowed
        ? 'Cloudflare Access: NOT set up, because CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set. ' +
            'This deployment is locked unless it has a PREVIEW_PASSWORD secret.'
        : 'Cloudflare Access: NOT set up, because PREVIEW_ALLOWED_EMAILS is empty (in CI it is a repository ' +
            'variable, not a secret). This deployment is locked unless it has a PREVIEW_PASSWORD secret.',
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
