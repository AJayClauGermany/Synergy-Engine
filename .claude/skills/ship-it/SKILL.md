---
name: ship-it
description: >
  Ships builds of the game: a gated preview or the main deployment on Cloudflare Workers
  (Access or a password, assets on R2), preview deploys from CI, and the desktop app with
  Electrobun; also build-time environment variables. Use when asked to deploy, publish,
  share a preview link, set up or tear down the Cloudflare side, package for desktop, or
  when a deployed build shows a blank page or missing assets. Not for checking that a
  change works before it ships (use `verify-changes`), or for the multiplayer backend's
  functions (use `multiplayer`).
---

# Shipping builds

## Web previews (Cloudflare Workers)

Details: `docs/deploying.md`. First-time set-up (accounts, secrets, names) and how to
clear what a test run created: `docs/setup.md`. The moving parts:

- `bun run build` → `dist/` (static site). Imported files land in `dist/assets/` under a
  content-hashed name; the game asks for `./assets/<name>-<hash>.<ext>`.
- `scripts/deploy.ts` (`bun run preview:deploy`, `bun run deploy`) → build, move
  `dist/assets/` to the R2 bucket (only files it lacks; never deletes), make Cloudflare
  Access admit `PREVIEW_ALLOWED_EMAILS` (and switch on sign-in by emailed code), run
  wrangler with `--var ACCESS_AUD:<tag>`. The R2 and Access steps need
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; without them the deployment is
  locked unless it has a password. `bun run cloudflare:check` reads the account and says
  what is missing, changing nothing.
- `wrangler.jsonc` → Worker with static assets; `run_worker_first: true` sends every
  request through `cloudflare/worker.ts`. The `ASSET_BUCKET` R2 binding appears twice
  (top level and `previews`), because previews inherit nothing.
- `cloudflare/worker.ts` → the gate. Serves when `PUBLIC_ACCESS` is `"true"`, or Cloudflare
  Access is in front (`ACCESS_AUD`, set by the deploy; or `context.access`), or the visitor
  knows the `PREVIEW_PASSWORD` secret. It fails closed when none is set. `/assets/*` is
  read from R2 first, then from the Worker's own files.
- Why `ACCESS_AUD`: a Worker with static assets runs behind Cloudflare's asset router,
  which does not pass `ctx.access` on. Access still checks every visitor before the
  Worker; the Worker just cannot see it. Do not "fix" this by trusting a request header.
- `.github/workflows/preview.yml` → a preview per non-draft pull request, deleted on close.
- `scripts/teardown.ts` (`bun run cloudflare:teardown`) → the opposite of a deploy: lists
  the Worker, the Access application and the bucket, and with `--confirm <worker name>`
  deletes them, Worker first (a Worker without its Access application serves everyone).
  `.github/workflows/teardown.yml` runs it with the repository's secrets, started by hand
  or by an agent: you need no Cloudflare login to clean up. It deletes for good, so start
  it only when the user asked for a clean-up, and list (empty `confirm`) before deleting.

Commands:

```bash
bun run preview:local
```

```bash
bun run preview:deploy
```

```bash
bun run deploy
```

Before deploying, validate without touching the network:

```bash
bunx wrangler deploy --dry-run
```

Secrets are entered by the user, never by you and never in files that get committed
(GitHub repository secrets for CI, `.env.local` locally). The optional `PREVIEW_PASSWORD`
lives in the same two places; a deploy hands it to wrangler (`--secrets-file`), and the
Worker asks for it only where Access is not in front.

Deploying publishes content to the internet and needs the user's Cloudflare credentials.
Ask before running `preview:deploy` or `deploy` unless they already told you to.

Changing the gate: edit `cloudflare/worker.ts`, keep `cloudflare/worker.test.ts` passing
(`bun test cloudflare`), and keep these properties: assets are gated as well as HTML,
nothing configured → nothing served, only `ACCESS_AUD` or `context.access` (never a request
header) counts as Access, `ACCESS_AUD` is set only by `scripts/deploy.ts` after the Access
application exists, the cookie never contains the password, comparisons are constant-time.

Changing the deploy: `scripts/deploy.test.ts` runs the upload and the Access calls against
a stand-in for Cloudflare's API. `docs/setup.md`, "What a real run has confirmed", records
what has run against a real account; say which side of that line a change is on. Assets must keep working from disk for the desktop build, so never
make the game depend on an absolute asset URL.

`wrangler preview` is in open beta; check `bunx wrangler preview --help` rather than
assuming flags. Cloudflare's own skills: `bunx skills add cloudflare/skills -s wrangler`.

## Desktop (Electrobun)

Details: `docs/desktop.md`.

```bash
bun run desktop:dev
```

```bash
bun run desktop:build
```

- Electrobun 2 is not Electron, and differs from Electrobun 1: main-process imports come
  from `electrobun/main`, the build tool is Hutch, and the SDK is generated into
  `desktop/.hutch/` (git-ignored) on first use.
- The web build is copied from `desktop/dist` to `views/game` and loaded from
  `views://game/index.html`. Asset URLs in the build are relative, which that requires.
- Builds target the current OS only.
- `desktop:dev` has run on macOS; `desktop:build` is not verified. If a
  build fails, compare with `bunx electrobun init --template=vanilla-vite` output and fix
  the config; then update the status note in `docs/desktop.md`.

## Build-time configuration

Variables are declared in `.env.schema` and loaded by varlock: the package scripts run
through `varlock run --`. See `docs/environment.md`; run `bun run env` to check them.
Add new ones to the schema, mark secrets `@sensitive`, and never read or edit `.env.local`
(it may hold secrets).

`process.env.PUBLIC_*` is inlined into the browser bundle at build time (and by the dev
server). Read such variables through a guarded helper like `game/src/env.ts`, because an
unset variable is left as a bare `process.env` reference that would throw in a browser.

## Gotchas

- **A blank page after deploying, fine locally.** An asset was referenced by an absolute
  URL (`/images/x.png`) or a `PUBLIC_` variable was unset at build time, leaving a bare
  `process.env` in the bundle. Asset URLs stay relative; read variables through
  `game/src/env.ts`.
- **A secret in the browser.** Every `PUBLIC_*` variable is inlined into the bundle
  anyone can download. Secrets have no `PUBLIC_` prefix and are marked `@sensitive` in
  `.env.schema`.
- **The preview asks for a password nobody set, or lets everyone in.** The gate is
  decided at deploy time from the environment: `bun run cloudflare:check` says what the
  account has switched on, without changing anything.
- **Guessing `wrangler` flags.** `wrangler preview` is in open beta and changes; read
  `bunx wrangler preview --help`.
- **Deploying from a branch with failing checks.** A deploy does not run `bun run check`
  for you. Run it first.
- **Reporting a desktop build as working.** `desktop:dev` has run on macOS only;
  `desktop:build` is unverified. Say which you ran and where.
- **Tearing down the wrong thing.** `bun run cloudflare:teardown` lists first and deletes
  only with `--confirm <name>`. Read the list; ask the user before confirming.

## Verify

Before a deploy: `bun run check` ends in `PASSED`, and `bun run build` succeeds.

After it: open the URL the deploy printed and look, or
`bun run screenshot --url <preview url> --out .screenshots/preview.png` and read the
image; the run fails if the page logged an error. For a gated preview the screenshot is of
the gate, which is itself the check that the gate is on. Then say exactly what ran
against a real account and what did not: `docs/deploying.md` keeps that line for the
project, and a change that crosses it should update it.
