---
id: GEN-001
title: Browser code reads only public environment variables, and each is declared
domain: general
rules: true
files:
  [
    ".env.schema",
    "game/src/**/*.ts",
    "game/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "scripts/**/*.ts",
    "cloudflare/**/*.ts",
    "convex/**/*.ts",
  ]
---

## Context

Every environment variable is declared in `.env.schema` and loaded by varlock
(`docs/environment.md`). The build (`scripts/build.ts`) writes `process.env.NODE_ENV` and
the `PUBLIC_` variables into the page; nothing else reaches the browser. That boundary is
what keeps secrets out of the bundle, and the type-checker cannot see it: `process.env`
has a value of type `string | undefined` for any name.

- `process.env.CONVEX_URL` in game code compiles, works in a Bun test (where the variable
  is set), and is `undefined` in the page.
- A `PUBLIC_` variable that `.env.schema` does not declare is never validated or loaded by
  varlock, so the build sees it unset.
- A `PUBLIC_` variable marked `@sensitive` contradicts itself: it is published with the page.

## Decision

- Code bundled for the browser (`game/src`, `packages/*/src`) reads only `NODE_ENV` and
  `PUBLIC_` variables, and only through `process.env`. Game code reads them in one place,
  `game/src/env.ts`.
- Every `PUBLIC_` variable read anywhere is declared in `.env.schema`.
- No `PUBLIC_` variable is marked `@sensitive`.

## Do's and Don'ts

### Do

- Add `PUBLIC_NAME=` to `.env.schema` with a comment, then read it in `game/src/env.ts`
  with the guard shown there.
- Read secrets in `scripts/` or in the Worker (`cloudflare/worker.ts`), never in `game/`.

### Don't

- Don't read `import.meta.env` or `Bun.env` in game code: neither exists in a page.
- Don't rename a secret to `PUBLIC_` to make it reach the page.

## Consequences

### Positive

- A variable that would be `undefined` in the page, or a secret on its way into it, is
  reported before a build ships it.

### Negative

- Only reads written as `process.env.NAME` or `process.env['NAME']` are seen.

### Risks

- None known. The browser list is every package source folder; a package that never runs
  in the browser can be taken off it in the rules file.

## Compliance and Enforcement

### Automated Enforcement

- `GEN-001/browser-code-reads-only-public-variables`
- `GEN-001/public-variables-are-declared`
- `GEN-001/public-variables-are-not-secret`

### Manual Enforcement

`bunx varlock scan` looks for secrets that leaked into files (see `.env.schema`).

## References

- [docs/environment.md](../../docs/environment.md)
- [AGENTS.md](../../AGENTS.md), "Boundaries"
