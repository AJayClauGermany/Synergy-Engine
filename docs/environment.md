# Environment variables and Convex setup

Every variable the project reads is listed in **`.env.schema`**, with its type, a comment,
and whether it is secret. The file is committed; it holds names, never secret values.
[varlock](https://varlock.dev) reads it, checks your values against it, and hands them to
the scripts. The scripts in `package.json` (`dev`, `build`, `start`, `screenshot`,
`deploy`, ...) all run through `varlock run --`, so you do not load anything yourself.

Nothing is required. With no values at all the game runs single-player and peer-to-peer.
Values you set turn on more.

## Setting up Convex (the lobby)

Once per developer, with two terminals:

```bash
bun install
```

```bash
bun run backend
```

The first time, `convex dev` asks you to log in and creates a development deployment for
you. It pushes the functions in `convex/` and writes `CONVEX_DEPLOYMENT` and `CONVEX_URL`
to `.env.local` (git-ignored). Leave it running while you work: it re-pushes when you edit
`convex/`.

```bash
bun run dev
```

`PUBLIC_CONVEX_URL` is defined in the schema as `${CONVEX_URL}`, so the game finds your
deployment with nothing to copy. Everyone who clones the project runs these same commands
and gets a deployment of their own; to share one instead, put the same
`PUBLIC_CONVEX_URL=...` in each person's `.env.local`.

Check what the project sees:

```bash
bun run env
```

It prints every variable and whether it resolved, with secrets masked.

## Where values come from

Later wins:

1. the defaults in `.env.schema`
2. `.env`, then `.env.local` (git-ignored; this is where `convex dev` and you write values)
3. the process environment, which is how CI and hosting dashboards set them

So `PUBLIC_CONVEX_URL=https://other.convex.cloud bun run build` builds against another
deployment without touching any file.

## Secrets

`CONVEX_DEPLOY_KEY` and `CLOUDFLARE_API_TOKEN` are marked `@sensitive`: varlock masks them
in output and logs. Keep them in `.env.local` or your CI's secret store, never in a
committed file.

```bash
bunx varlock reveal CLOUDFLARE_API_TOKEN     # show one to yourself
```

```bash
bunx varlock encrypt --file .env.local       # replace plaintext secrets with device-encrypted ones
```

```bash
bunx varlock scan --install-hook             # refuse commits that contain a secret
```

For secrets a team shares, varlock has plugins that read from 1Password, Infisical, AWS
and others; the schema then holds a reference, not a value. See varlock's documentation.

Only variables starting with `PUBLIC_` are built into the web page, and anyone who opens
the game can read them. Never put a secret in one.

## Adding a variable

1. Add it to `.env.schema` with a comment, a `@type` if it is not plain text, and
   `@sensitive` if it is a secret.
2. If the browser needs it, name it `PUBLIC_...` and read it through `game/src/env.ts`
   (an unset variable is left as a bare `process.env` reference that would throw there).
3. Run `bun run env` to check it.

## Analytics

varlock sends anonymous usage statistics unless told not to. The scripts here turn that off
with `VARLOCK_TELEMETRY_DISABLED=1`. If you run `bunx varlock ...` yourself, add
`DO_NOT_TRACK=1` to your shell or run `bunx varlock telemetry disable` once; to opt in
for the project's scripts, remove the prefix in `package.json`.

## CI and deploys

CI needs no values to type-check, test and build. To deploy, give the job
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (and `CONVEX_DEPLOY_KEY` if it pushes
Convex functions) as secrets. See [deploying.md](deploying.md) for the password gate, which
is separate: it is a Worker secret, not a build variable.
