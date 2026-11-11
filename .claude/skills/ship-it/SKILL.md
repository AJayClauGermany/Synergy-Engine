---
name: ship-it
description: Use when deploying a password-protected preview or the main build to Cloudflare Workers, changing the preview gate, configuring CI previews, or packaging the desktop app with Electrobun.
---

# Shipping builds

## Web previews (Cloudflare Workers)

Details: `docs/deploying.md`. First-time set-up (accounts, secrets, names) and how to
clear what a test run created: `docs/setup.md`. The moving parts:

- `bun run build` → `dist/` (static site). Imported files land in `dist/assets/` under a
  content-hashed name; the game asks for `./assets/<name>-<hash>.<ext>`.
- `scripts/deploy.ts` (`bun run preview:deploy`, `bun run deploy`) → build, move
  `dist/assets/` to the R2 bucket (only files it lacks; never deletes), run wrangler, make
  Cloudflare Access admit `PREVIEW_ALLOWED_EMAILS`. The R2 and Access steps need
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; without them it deploys the old way.
- `wrangler.jsonc` → Worker with static assets; `run_worker_first: true` sends every
  request through `cloudflare/worker.ts`. The `ASSET_BUCKET` R2 binding appears twice
  (top level and `previews`), because previews inherit nothing.
- `cloudflare/worker.ts` → the gate. Serves when `PUBLIC_ACCESS` is `"true"`, or Cloudflare
  Access authenticated the request (`context.access`), or the visitor knows the
  `PREVIEW_PASSWORD` secret. It fails closed when none is set. `/assets/*` is read from
  R2 first, then from the Worker's own files.
- `.github/workflows/preview.yml` → a preview per non-draft pull request, deleted on close.

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
(GitHub repository secrets for CI, `.env.local` locally, `wrangler secret put` for the
optional password).

Deploying publishes content to the internet and needs the user's Cloudflare credentials.
Ask before running `preview:deploy` or `deploy` unless they already told you to.

Changing the gate: edit `cloudflare/worker.ts`, keep `cloudflare/worker.test.ts` passing
(`bun test cloudflare`), and keep these properties: assets are gated as well as HTML,
nothing configured → nothing served, only `context.access` (never a request header) counts
as Access, the cookie never contains the password, comparisons are constant-time.

Changing the deploy: `scripts/deploy.test.ts` runs the upload and the Access calls against
a stand-in for Cloudflare's API. Neither has been run against a real account here; say so
when you change them. Assets must keep working from disk for the desktop build, so never
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
- This setup was written from the official 2.0.6 templates but not build-verified. If a
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
