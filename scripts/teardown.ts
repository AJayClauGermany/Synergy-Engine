/**
 * Removes what deploys of this game created on Cloudflare: the opposite of scripts/deploy.ts.
 *
 *   bun run cloudflare:teardown                       changes nothing: lists what exists
 *   bun run cloudflare:teardown --confirm <name>      deletes it; <name> is "name" in wrangler.jsonc
 *   ... --convex prod | dev                           also empties every table of that Convex deployment
 *
 *   1. The Worker, with every Preview and version of it.
 *   2. The Access application in front of it. Only once the Worker is gone: a Worker that
 *      outlives its Access application would serve everyone (docs/deploying.md).
 *   3. The R2 bucket of hashed assets: every object, then the bucket.
 *
 * A step that fails does not stop the others; the report says what is left and why. Things
 * that belong to the account rather than to this game are never touched: the API token,
 * sign-in by emailed code, the workers.dev subdomain, R2 and Zero Trust themselves.
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, the ones a deploy uses. In CI the
 * "Teardown" workflow runs this with the repository's secrets (docs/setup.md).
 */
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import schema from '../convex/schema';
import {
  type Account,
  accessApplicationName,
  api,
  ApiError,
  assetBucket,
  call,
  findAccessApplication,
  findWorker,
  inParallel,
  type WorkerConfig,
} from './deploy';

const root = path.resolve(import.meta.dir, '..');
/** Cloudflare lists at most this many objects per call. */
const PAGE = 1000;

/** One line of the report. */
export interface Step {
  what: string;
  /** `found` is the answer of a run that changes nothing; `kept` means left in place on purpose. */
  outcome: 'deleted' | 'absent' | 'found' | 'kept' | 'failed';
  detail: string;
}

/** Every bucket wrangler.jsonc names for assets (previews and the main deployment normally share one). */
export function assetBuckets(config: WorkerConfig): string[] {
  return [...new Set([assetBucket(config, 'production'), assetBucket(config, 'preview')])].filter(
    (bucket): bucket is string => bucket !== null,
  );
}

const objectsOf = async (account: Account, bucket: string) =>
  (await api<{ key: string }[]>(account, 'GET', `/r2/buckets/${bucket}/objects?per_page=${PAGE}`)) ?? [];

/** Deletes every object of a bucket and says how many there were. A bucket has to be empty to be deleted. */
async function emptyBucket(account: Account, bucket: string): Promise<number> {
  let deleted = 0;
  // Each round lists the bucket from the start, since the round before removed what it saw.
  for (let objects = await objectsOf(account, bucket); objects.length > 0; objects = await objectsOf(account, bucket)) {
    await inParallel(objects, 16, async ({ key }) => {
      const response = await call(
        account,
        'DELETE',
        `/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`,
      );
      await response.body?.cancel();
    });
    deleted += objects.length;
  }
  return deleted;
}

/**
 * Looks for the Worker, its Access application and its buckets and, when `remove` is set,
 * deletes them. Never throws for something Cloudflare refused: that becomes a `failed` step.
 */
export async function teardown(account: Account, config: WorkerConfig, remove: boolean): Promise<Step[]> {
  const steps: Step[] = [];
  /** `work` gives the outcome and a detail; `needs` is the token permission to name when Cloudflare refuses. */
  const step = async (what: string, needs: string, work: () => Promise<[Step['outcome'], string]>) => {
    try {
      const [outcome, detail] = await work();
      steps.push({ what, outcome, detail });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const answer = error.message.split('\n').slice(0, 2).join(' ').slice(0, 300);
      steps.push({ what, outcome: 'failed', detail: `${answer}\nThe API token needs "${needs}".` });
    }
    return steps.at(-1)?.outcome;
  };

  const worker = await step(`Worker "${config.name}"`, 'Workers Scripts: Edit', async () => {
    if (!(await findWorker(account, config.name))) return ['absent', 'Cloudflare has no Worker of this name'];
    if (!remove) return ['found', 'would be deleted, with its Previews and versions'];
    await api(account, 'DELETE', `/workers/workers/${config.name}`);
    return ['deleted', 'with its Previews and versions'];
  });

  await step(
    `Access application "${accessApplicationName(config.name)}"`,
    'Access: Apps and Policies: Edit',
    async () => {
      const application = await findAccessApplication(account, config.name);
      if (!application) return ['absent', 'Cloudflare has no Access application of this name'];
      if (!remove) return ['found', 'would be deleted'];
      if (worker === 'failed') {
        return ['kept', 'the Worker could not be deleted, and without this application it would serve everyone'];
      }
      await api(account, 'DELETE', `/access/apps/${application.id}`);
      return ['deleted', 'nobody is on its list any more'];
    },
  );

  for (const bucket of assetBuckets(config)) {
    await step(`R2 bucket "${bucket}"`, 'Workers R2 Storage: Edit', async () => {
      if ((await api(account, 'GET', `/r2/buckets/${bucket}`)) === null)
        return ['absent', 'Cloudflare has no bucket of this name'];
      if (!remove) {
        const count = (await objectsOf(account, bucket)).length;
        return [
          'found',
          `would be emptied (${count === PAGE ? `${PAGE} objects or more` : `${count} object${count === 1 ? '' : 's'}`}) and deleted`,
        ];
      }
      const count = await emptyBucket(account, bucket);
      await api(account, 'DELETE', `/r2/buckets/${bucket}`);
      return ['deleted', `after deleting its ${count} object${count === 1 ? '' : 's'}`];
    });
  }
  return steps;
}

/**
 * Empties every table of convex/schema.ts in one Convex deployment, keeping the project,
 * its functions and its address. The Convex command line does the work: with
 * CONVEX_DEPLOY_KEY set it acts on the deployment that key belongs to, otherwise on the
 * development deployment of whoever is logged in (`prod`: that project's production one).
 */
async function emptyConvexTables(deployment: 'prod' | 'dev', remove: boolean): Promise<Step[]> {
  const where = process.env.CONVEX_DEPLOY_KEY
    ? 'the deployment CONVEX_DEPLOY_KEY belongs to'
    : `your ${deployment === 'prod' ? 'production' : 'development'} deployment`;
  const tables = Object.keys(schema.tables);
  if (!remove) {
    return tables.map((table) => ({
      what: `Convex table "${table}"`,
      outcome: 'found',
      detail: `would be emptied, in ${where}`,
    }));
  }
  const folder = await mkdtemp(path.join(tmpdir(), 'synergy-teardown-'));
  const nothing = path.join(folder, 'empty.jsonl');
  await Bun.write(nothing, '');
  const steps: Step[] = [];
  for (const table of tables) {
    // Importing no rows with --replace leaves the table empty and the schema as it is.
    const command = [process.execPath, 'x', 'convex', 'import', '--table', table, '--replace', '--yes'];
    if (deployment === 'prod' && !process.env.CONVEX_DEPLOY_KEY) command.push('--prod');
    const child = Bun.spawn([...command, nothing], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`.trim();
    steps.push(
      (await child.exited) === 0
        ? { what: `Convex table "${table}"`, outcome: 'deleted', detail: `every row, in ${where}` }
        : { what: `Convex table "${table}"`, outcome: 'failed', detail: output.slice(-600) },
    );
  }
  await rm(folder, { recursive: true });
  return steps;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { confirm: { type: 'string' }, convex: { type: 'string' } },
  });
  const config = Bun.JSONC.parse(await Bun.file(path.join(root, 'wrangler.jsonc')).text()) as WorkerConfig;
  if (values.confirm !== undefined && values.confirm !== config.name) {
    console.error(
      `--confirm ${values.confirm} does not match "name" in wrangler.jsonc, which is "${config.name}". Nothing was changed.`,
    );
    return 1;
  }
  if (values.convex !== undefined && values.convex !== 'prod' && values.convex !== 'dev') {
    console.error('--convex takes "prod" or "dev". Nothing was changed.');
    return 1;
  }
  const remove = values.confirm !== undefined;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !id) {
    console.error(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set. Put them in .env.local (docs/setup.md, step 5), ' +
        'or run the "Teardown" workflow, which has the repository\'s secrets.',
    );
    return 1;
  }
  const account = { token, id, api: process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4' };

  const steps = await teardown(account, config, remove);
  if (values.convex) steps.push(...(await emptyConvexTables(values.convex, remove)));

  const lines = steps.map(
    (step) => `${step.outcome.padEnd(7)}  ${step.what}: ${step.detail.replaceAll('\n', '\n         ')}`,
  );
  const failed = steps.filter((step) => step.outcome === 'failed' || step.outcome === 'kept').length;
  const verdict = steps.every((step) => step.outcome === 'absent')
    ? 'NOTHING TO DELETE. Cloudflare holds nothing under this name.'
    : !remove
      ? `NOTHING CHANGED. To delete what was found: bun run cloudflare:teardown --confirm ${config.name}`
      : failed === 0
        ? 'CLEAN. The next deploy would create all of it again.'
        : `NOT CLEAN: ${failed} left. Fix what failed, then run this again; what is already gone is skipped.`;
  console.log(`${lines.join('\n')}\n\n${verdict}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Teardown\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n${verdict}\n`,
    );
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
