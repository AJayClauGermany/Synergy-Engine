---
name: ship-it
description: Use when deploying a password-protected preview or the main build to Cloudflare Workers, changing the preview gate, configuring CI previews, or packaging the desktop app with Electrobun.
---

# Shipping builds

## Web previews (Cloudflare Workers)

Details: `docs/deploying.md`. The moving parts:

- `bun run build` → `dist/` (static site).
- `wrangler.jsonc` → Worker with static assets; `run_worker_first: true` sends every
  request through `cloudflare/worker.ts`.
- `cloudflare/worker.ts` → password gate. Secret `PREVIEW_PASSWORD`; var `PUBLIC_ACCESS`
  (`"true"` disables the gate). It fails closed when neither is set.

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

Secrets are entered interactively by the user, never by you and never in files that get
committed:

```bash
bunx wrangler preview base-config secret put PREVIEW_PASSWORD
```

```bash
bunx wrangler secret put PREVIEW_PASSWORD
```

Deploying publishes content to the internet and needs the user's Cloudflare login. Ask
before running `preview:deploy` or `deploy` unless they already told you to.

Changing the gate: edit `cloudflare/worker.ts`, keep `cloudflare/worker.test.ts` passing
(`bun test cloudflare`), and keep these properties: assets are gated as well as HTML, no
password → nothing served, the cookie never contains the password, comparisons are
constant-time.

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

`process.env.PUBLIC_*` is inlined into the browser bundle at build time (and by the dev
server). Read such variables through a guarded helper like `game/src/env.ts`, because an
unset variable is left as a bare `process.env` reference that would throw in a browser.
