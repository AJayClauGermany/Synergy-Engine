# Deploying private previews to Cloudflare

The game builds to a static folder (`dist/`). `wrangler.jsonc` deploys it as a Cloudflare
Worker, and `cloudflare/worker.ts` runs in front of every request so that only the people
you chose can open it. Three things are automatic:

- **A preview per pull request.** Opening a pull request (or marking a draft ready)
  deploys it; each push updates it; closing it deletes it. Draft pull requests deploy nothing.
- **Sign-in with Cloudflare Access.** A visitor proves their email address with a code
  Cloudflare mails them, and gets in only when the address is on your list.
- **Assets in R2.** Images, models and sounds are stored once, under a name that holds a
  hash of their content. A deploy uploads only the ones the bucket does not hold yet, so
  a change to code uploads no assets at all.

## Set-up, once

[setup.md](setup.md), step 5, has the steps: switch on R2 and Zero Trust, create an API
token, and give GitHub two secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and
two variables (`PREVIEW_ALLOWED_EMAILS`, and `PUBLIC_CONVEX_URL` if the game uses Convex).
Step 3 there names the Worker and its bucket in `wrangler.jsonc`.

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

Both run `scripts/deploy.ts`: build, move the assets to R2, run wrangler, update Access.
The R2 and Access steps need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
`.env.local`, and `PREVIEW_ALLOWED_EMAILS` for Access. With only `bunx wrangler login`
the deploy still works, with the assets uploaded as part of the Worker and the gate
left as it is; the last lines of the output say which happened.

## Who gets in

The Worker serves a request when one of these holds, and otherwise serves nothing (a
deployment nobody configured is locked, not open):

1. `"PUBLIC_ACCESS": "true"` in `wrangler.jsonc`: the gate is off. This applies to the
   main deployment only; previews do not inherit it.
2. **Cloudflare Access** let the request through. While `PUBLIC_ACCESS` is `"false"`, Access
   covers the main deployment and every preview; once it is `"true"`, only the previews.
3. The visitor knows the **password**, if you set one. This is the fallback for a
   deployment without Access, and for scripts:

   ```bash
   bunx wrangler preview base-config secret put PREVIEW_PASSWORD
   ```

   ```bash
   bunx wrangler secret put PREVIEW_PASSWORD
   ```

   (the first for all previews, the second for the main deployment). A correct password
   sets a cookie for 7 days, derived from the password, so changing it signs everyone
   out; `curl -u x:"$PASSWORD" https://...` works too. It is one shared password with
   no rate limiting: use a long random one. Behind Access the password is never asked for.

Gated responses are marked `noindex` and `Cache-Control: private`. Scripts and assets are
gated as well as the page.

Access here is "Worker-level": Cloudflare checks the visitor before the Worker runs, and
the Worker trusts only the mark Cloudflare itself puts on the request, never a header.
The game's own WebSockets are unaffected (they go to PeerJS and Convex, not to the Worker).

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

The Worker, the asset upload and the Access set-up are tested against stand-ins
(`cloudflare/worker.test.ts`, `scripts/deploy.test.ts`); they have not been run against a
real Cloudflare account from this template. Worker Previews are in open beta in
Wrangler; `bunx wrangler preview --help` shows the current options. If the first real
deploy disagrees with this page, the error message says which step failed.

Because every request runs the Worker, each one counts as a Worker invocation against
your Cloudflare plan's limits.

## Build-time configuration

Only environment variables starting with `PUBLIC_` are compiled into the bundle (for
example `PUBLIC_CONVEX_URL`). They are visible to anyone who can open the game, so never
put a secret in one. Pull-request previews take `PUBLIC_CONVEX_URL` from the repository
variable of that name; a deploy by hand takes it from `.env.local` or the command line.
