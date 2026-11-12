# Deploying private previews to Cloudflare

The game builds to a static folder (`dist/`). `wrangler.jsonc` deploys it as a Cloudflare
Worker, and `cloudflare/worker.ts` runs in front of every request so that only the people
you chose can open it. Three things are automatic:

- **A preview per pull request.** Opening a pull request (or marking a draft ready)
  deploys it; each push updates it; closing it deletes it. Draft pull requests deploy nothing.
- **Sign-in with Cloudflare Access.** A visitor proves their email address with a code
  Cloudflare mails them, and gets in only when the address is on your list. Cloudflare
  checks this before the Worker runs.
- **Assets in R2.** Images, models and sounds are stored once, under a name that holds a
  hash of their content. A deploy uploads only the ones the bucket does not hold yet, so
  a change to code uploads no assets at all.

## Set-up, once

[setup.md](setup.md), step 5, has the steps, in three parts: Cloudflare first (switch on
R2 and Zero Trust, create an API token, confirm with `bun run cloudflare:check`), then a
preview from your machine, then GitHub (two repository secrets, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, and two repository variables, `PREVIEW_ALLOWED_EMAILS`, and
`PUBLIC_CONVEX_URL` if the game uses Convex). Step 3 there names the Worker and its
bucket in `wrangler.jsonc`.

Everything else is created by the first deploy: the Worker, the R2 bucket and the Access
application. To let someone in or out later, edit `PREVIEW_ALLOWED_EMAILS`; the next deploy
applies it. An entry starting with `@` admits a whole domain.

## What a pull request does

`.github/workflows/preview.yml`:

| Event | Result |
|-------|--------|
| opened, reopened, marked ready for review, new commits | deploys the preview `pr-<number>`; the pull request shows a *View deployment* button |
| the pull request is a draft | nothing |
| closed or merged | deletes the preview |

The address has the form `https://pr-<number>-<worker-name>.<subdomain>.workers.dev`.
Until the two secrets exist the workflow passes without doing anything. Pull requests
from forks are skipped, because they cannot read the secrets.

## Deploying by hand

```bash
bun run preview:deploy
```

deploys a preview named after the current git branch (`--name demo` picks the name;
`bunx wrangler preview delete --name demo` removes one).

```bash
bun run deploy
```

deploys the main address, `https://<worker-name>.<subdomain>.workers.dev`.

Both run `scripts/deploy.ts`: build, move the assets to R2, update Access, run wrangler.
The R2 and Access steps need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
`.env.local`, and `PREVIEW_ALLOWED_EMAILS` for Access. With only `bunx wrangler login`
the deploy still works, with the assets uploaded as part of the Worker and no Access, so
the deployment is locked unless it has a password; the last lines of the output say which
happened.

```bash
bun run cloudflare:check
```

reads the account without changing it and says whether a deploy would find what it needs:
the token, the `workers.dev` subdomain, R2, Zero Trust, sign-in by emailed code.

The main address is deployed only this way. No workflow deploys it, so a game that ships
only as a desktop app never has to have one.

## Who gets in

The Worker serves a request when one of these holds, and otherwise serves nothing (a
deployment nobody configured is locked, not open):

1. `"PUBLIC_ACCESS": "true"` in `wrangler.jsonc`: the gate is off. This applies to the
   main deployment only; previews do not inherit it.
2. **Cloudflare Access** is in front of it. While `PUBLIC_ACCESS` is `"false"`, Access
   covers the main deployment and every preview; once it is `"true"`, only the previews.
3. The visitor knows the **password**, if you set one. This is only ever the
   fallback, for a deployment without Access: when both are set, Access is the gate and
   the password is not asked for. Set `PREVIEW_PASSWORD` where the other values live (a
   GitHub repository *secret* for pull-request previews, `.env.local` for deploys by
   hand) and each deploy stores it with the Worker as a secret. Neither it nor the list of
   emails has to be set; with neither, the deployment is locked. Removing the value does
   not remove the secret from Cloudflare (`bunx wrangler secret delete PREVIEW_PASSWORD` does, and
   `bunx wrangler preview secret --help` shows the same for previews). A correct password
   sets a cookie for 7 days, derived from the password, so changing it signs everyone
   out; `curl -u x:"$PASSWORD" https://...` works too. It is one shared password with
   no rate limiting: use a long random one. Behind Access the password is never asked
   for, and a visitor still has to pass Access first: to rely on the password alone,
   deploy with `PREVIEW_ALLOWED_EMAILS` empty (every preview that is open, too), then
   delete the Access application (*Zero Trust > Access > Applications*).

Gated responses are marked `noindex` and `Cache-Control: private`. Scripts and assets are
gated as well as the page.

### How Access and the Worker fit together

Access here is "Worker-level": the Access application names the Worker, and Cloudflare
checks every visitor to any of its addresses before the Worker runs. A deploy

1. creates or updates the Access application `<name> (Synergy preview gate)` so that it
   admits exactly `PREVIEW_ALLOWED_EMAILS`;
2. makes sure visitors can sign in with a code mailed to them. A new Zero Trust account
   offers only "Sign in with Cloudflare", which needs a Cloudflare login. The deploy adds
   the *One-time PIN* method, with the token's *Access: Organizations, Identity
   Providers, and Groups: Edit*; a token made before that permission was part of the
   set-up still deploys, and the deploy says where to add the method by hand
   (*Zero Trust > Integrations > Identity providers*);
3. uploads the Worker with the variable `ACCESS_AUD` (the application's audience tag).

The third step is how the Worker knows. Cloudflare marks a request that Access admitted
(`ctx.access`), but not for a Worker with static assets, which this one is: its requests
arrive through Cloudflare's asset router, which drops the mark. So a deployment made
without `ACCESS_AUD` answers "Preview locked" to everyone, signed in or not, and one made
with it serves whoever reaches it, which is whoever Access admitted. Two consequences:

- Never set `ACCESS_AUD` by hand or in `wrangler.jsonc`. It would open a deployment that
  has no Access in front of it.
- Do not delete the Access application while Access-gated deployments exist: they would
  be open until the next deploy recreates it. To open the game on purpose, use
  `PUBLIC_ACCESS`.

The game's own WebSockets are unaffected (they go to PeerJS and Convex, not to the
Worker). A WebSocket *to the Worker* would be refused under Worker-level Access.

## Assets

Anything the game imports for its URL

```ts
import knightUrl from '../assets/knight.glb' with { type: 'file' };
```

is written by the build to `dist/assets/knight-<hash>.glb`, and the game asks for
`./assets/knight-<hash>.glb`. Where that file comes from depends on the build:

| Build | Where `assets/` lives |
|-------|-----------------------|
| `bun run preview:deploy`, `bun run deploy`, pull-request previews | the R2 bucket; the Worker reads it for requests to `/assets/` |
| `bun run desktop:build` | inside the app, on disk: no network needed |
| `bun run build`, `bun run start`, `bun run preview:local` | `dist/assets/`, next to the page |

So the game's code is the same everywhere, and there is no asset URL to configure.

- The bucket is **private**. Assets are reachable only through the Worker, behind the
  same gate as the page.
- A changed file gets a new name. The old one stays in the bucket, so older previews and
  players with a cached page keep working. Nothing is deleted automatically; to tidy up,
  empty the bucket and deploy again.
- Previews and the main deployment share the bucket (`<worker-name>-assets`).
- Browsers keep a hashed asset for a year (`immutable`), since its name changes when it does.
- One file can be up to 300 MB. Without R2 the limit is Cloudflare's 25 MB per static file.
- Files in `game/public/` are copied to `dist/` under their own names and stay with the
  Worker. Use imports for anything large.
- To deploy without R2, delete both `"r2_buckets"` entries in `wrangler.jsonc`.

## Try the gate locally

```bash
cp .dev.vars.example .dev.vars
```

```bash
bun run preview:local
```

Open http://localhost:8787 and enter the password from `.dev.vars`. Locally there is no
Access, and the assets are read from `dist/assets/`.

## What has and has not been run

[setup.md](setup.md), "What a real run has confirmed", has the record. In short: against
a real account, the pull-request workflow built, created the Worker, the bucket and the
Access application, uploaded only changed assets and linked the preview. Opening that
preview failed at first (the Worker could not see the Access sign-in); with `ACCESS_AUD`
it opened, for a visitor signed in by emailed code and for one signed in with Cloudflare.
`bun run cloudflare:check` has run against an account too. So has `bun run cloudflare:teardown`,
through the Teardown workflow: it deleted the Worker, the Access application and the bucket. The deploy switching on
emailed codes by itself is tested against a stand-in (`scripts/deploy.test.ts`) only. Worker Previews are in open beta in Wrangler; `bunx wrangler preview --help`
shows the current options.

Wrangler's usage reports to Cloudflare are switched off for this project
(`"send_metrics": false` in `wrangler.jsonc`).

Because every request runs the Worker, each one counts as a Worker invocation against
your Cloudflare plan's limits.

## Build-time configuration

Only environment variables starting with `PUBLIC_` are compiled into the bundle (for
example `PUBLIC_CONVEX_URL`). They are visible to anyone who can open the game, so never
put a secret in one. Pull-request previews take `PUBLIC_CONVEX_URL` from the repository
variable of that name; a deploy by hand takes it from `.env.local` or the command line.
