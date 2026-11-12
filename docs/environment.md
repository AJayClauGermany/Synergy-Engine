# Environment variables and Convex setup

Every variable the project reads is listed in **`.env.schema`**, with its type, a comment,
and whether it is secret. The file is committed; it holds names, never secret values.
[varlock](https://varlock.dev) reads it, checks your values against it, and hands them to
the scripts. The scripts in `package.json` (`dev`, `build`, `start`, `screenshot`,
`deploy`, ...) all run through `varlock run --`, so you do not load anything yourself.

Nothing is required. With no values at all the game runs single-player and peer-to-peer.
Values you set turn on more.

## Setting up Convex (the lobby)

[setup.md](setup.md), step 4, has the steps. In short: `bun run backend` logs you in,
creates a development deployment, pushes the functions in `convex/` and writes
`CONVEX_DEPLOYMENT` and `CONVEX_URL` to `.env.local` (git-ignored); `bunx convex deploy`
pushes the functions to the production deployment, which the builds on Cloudflare use.

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

1. the defaults in `.env.schema`, including secrets fetched from Bitwarden once that is set
   up (below)
2. `.env`, then `.env.local` (git-ignored; this is where `convex dev` and you write values)
3. the process environment, which is how CI and hosting dashboards set them

So `PUBLIC_CONVEX_URL=https://other.convex.cloud bun run build` builds against another
deployment without touching any file.

## Secrets

`CONVEX_DEPLOY_KEY` and `CLOUDFLARE_API_TOKEN` are marked `@sensitive`: varlock masks them
in output and logs. Keep them in Bitwarden (below), `.env.local` or your CI's secret store,
never in a committed file.

```bash
bunx varlock reveal CLOUDFLARE_API_TOKEN     # show one to yourself
```

```bash
bunx varlock encrypt --file .env.local       # replace plaintext secrets with device-encrypted ones
```

```bash
bunx varlock scan --install-hook             # refuse commits that contain a secret
```

### Secrets from Bitwarden (optional, your own machine)

A secret in `.env.local` is plain text that any program you run can read, including an
agent that opens the file by mistake. The schema can fetch the secrets from
[Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) instead
(varlock's [Bitwarden plugin](https://varlock.dev/plugins/bitwarden/)). This is for
commands on your machine; CI keeps passing its secrets as environment variables.

It covers `CONVEX_DEPLOY_KEY`, `CLOUDFLARE_API_TOKEN` and `PREVIEW_PASSWORD`. Each one
is fetched only when both `BWS_ACCESS_TOKEN` and its `BWS_ID_...` are set. Otherwise
nothing changes and the value comes from `.env.local` as before, so a clone without
Bitwarden works as it always did.

1. In Bitwarden Secrets Manager, put the secrets in a project, and give a machine
   account *Can read* access to that project. Create an access token for the machine
   account. An existing machine account works too, if it can read the project.
2. Write each secret's ID into `.env.schema` (`BWS_ID_CLOUDFLARE_API_TOKEN=<uuid>` and
   so on) and commit it. IDs are not secret. The web app shows them, and so does
   `bws secret list <project-id>`. The token already names the organisation, so the
   schema needs no organisation or project ID.
3. Give varlock the access token without leaving it in plain text. It unlocks every
   secret the machine account can read. Either put `BWS_ACCESS_TOKEN=` in `.env.local`
   and encrypt it to this device:

   ```bash
   bunx varlock encrypt --file .env.local
   ```

   On macOS the key stays in the Secure Enclave and each decrypt asks for Touch ID or
   your password. On Linux, anything running as you can decrypt it, so it guards the
   file at rest only. Or export `BWS_ACCESS_TOKEN` in your shell, if it is set there
   already for another tool.
4. Delete those secrets from `.env.local`. A value in `.env.local` or the environment
   always wins over Bitwarden.
5. Run `bun run env`. The three show as resolved (masked), and the token is listed as
   `internal`: varlock uses it but never passes it to the commands it runs.

With the token and an ID set, a command fails to start if Bitwarden cannot be reached
(offline, or a revoked token), and the error names the secret. To work offline for a
while, unset `BWS_ACCESS_TOKEN` and put the values back in `.env.local`.

To add another secret: add a `BWS_ID_<NAME>` line marked `@type=bitwardenSecretId
@internal`, and set the variable to
`if(and($BWS_ACCESS_TOKEN, $BWS_ID_<NAME>), bitwarden($BWS_ID_<NAME>))`.

For other secret stores, varlock has plugins for 1Password, Infisical, AWS and others
that work the same way. See varlock's documentation.

Only variables starting with `PUBLIC_` are built into the web page, and anyone who opens
the game can read them. Never put a secret in one.

## Adding a variable

1. Add it to `.env.schema` with a comment, a `@type` if it is not plain text, and
   `@sensitive` if it is a secret.
2. If the browser needs it, name it `PUBLIC_...` and read it through `game/src/env.ts`
   (an unset variable is left as a bare `process.env` reference that would throw there).
3. Run `bun run env` to check it.

## Analytics

varlock sends anonymous usage statistics unless told not to (the command used, versions,
a hash of the repository name; never your configuration or values). This project turns
that off for everyone who clones it, with `.varlock/config.json`, which covers the
scripts and any `bunx varlock ...` you run in the project. To opt in, delete that file.
To opt out everywhere, run `bunx varlock telemetry disable` once, or set `DO_NOT_TRACK=1`.

## CI and deploys

CI needs no values to type-check, test and build. To deploy, give the job
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (and `CONVEX_DEPLOY_KEY` if it pushes
Convex functions) as secrets, and `PREVIEW_ALLOWED_EMAILS` as a repository variable: the
people Cloudflare Access admits, and `PUBLIC_CONVEX_URL`, the Convex deployment the build
talks to. [setup.md](setup.md) lists them in order. The optional password
gate is separate: it is a Worker secret, not a build variable.
