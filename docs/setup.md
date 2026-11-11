# Setting up, start to finish

Do this once, before any game work, using the sample game that comes with the template.
At the end every piece around the game works: local checks, CI, the Convex backend,
private Cloudflare previews for each pull request. Then you replace the sample with your
game and none of this needs touching again.

Using the sample as a test game is deliberate. Everything set-up creates in the cloud (a
Worker, a bucket, an Access application, lobby rows in Convex) is disposable, so nothing
here has to be right the first time. [From the test game to the real one](#from-the-test-game-to-the-real-one)
says what to keep and what to clear.

This page is the one place for set-up. The other pages explain how each piece works:
[environment.md](environment.md), [deploying.md](deploying.md), [desktop.md](desktop.md).

## What you end up with

| Step | Piece | Needs | You know it works when |
|------|-------|-------|------------------------|
| 1 | Local development | [Bun](https://bun.sh) | `bun run check` ends with `PASSED`; the game opens at http://localhost:3000 |
| 2 | CI | a GitHub repository | the *CI* workflow is green on a push |
| 3 | Names | nothing | `wrangler.jsonc` and friends carry your name, not `synergy-game` |
| 4 | Backend (lobby, stored matches) | a Convex account (free) | *Host (persistent)* in the game creates a row in the `rooms` table |
| 5 | Private previews | a Cloudflare account (free, but R2 asks for a payment method) | a pull request shows *View deployment*, and the link asks for your email |
| 6 | Main deployment | step 5 | `bun run deploy` prints an address that opens for you |
| 7 | Optional extras | | commit hook, desktop app, agent skills |

Steps 1 and 2 need no account. Steps 4 and 5 do not depend on each other; skip either and
the rest still works (without Convex the game is single-player and peer-to-peer; without
Cloudflare the preview workflow passes and does nothing).

## 1. Local development

Install [Bun](https://bun.sh). The version the project is tested with is in `.bun-version`.

```bash
bun install
```

```bash
bun run check
```

must end with `PASSED`.

```bash
bun run dev
```

Open http://localhost:3000: click a blue unit, then a highlighted hex. `Host` and `Join`
(peer-to-peer) already work; they need no backend.

## 2. CI on GitHub

Push the project to your GitHub repository. `.github/workflows/ci.yml` runs
`bun run check` and `bun run build` on every pull request and on pushes to `main`; it
needs no secrets.

**Check:** the repository's *Actions* tab shows a green *CI* run. (If the tab says
workflows are disabled, enable them there.)

The *Preview* workflow also runs on pull requests. Until step 5 it passes with the notice
"Previews are off".

## 3. Names

Pick the game's name now, because the first deploy creates cloud resources under it. For
a test run a throwaway name such as `mygame-test` is fine; this step is the one you redo
for the real game.

| File | What to change |
|------|----------------|
| `wrangler.jsonc` | `"name"` (lowercase letters, digits, dashes), and **both** `"bucket_name"`s to `<name>-assets` |
| `game/src/online.ts` | `PEER_PREFIX`: keeps your room codes apart from other games on PeerJS's shared server |
| `game/index.html` | `<title>` |
| `desktop/electrobun.config.ts` | `app.name` and `app.identifier`, if you will ship a desktop build |
| `package.json` | `name` and `description` (cosmetic) |

Run `bun run check`, commit, push.

## 4. Backend: Convex

Convex holds the lobby and stored matches. A Convex project has a **development**
deployment per developer and one **production** deployment. Local work uses yours;
everything deployed to Cloudflare uses production.

### Your development deployment

```bash
bun run backend
```

The first time it asks you to log in and to create a project (name it like the game). It
pushes the functions in `convex/` and writes `CONVEX_DEPLOYMENT` and `CONVEX_URL` to
`.env.local` (git-ignored). Leave it running while you work on `convex/`: it re-pushes on
every edit. In a second terminal:

```bash
bun run env
```

should show `PUBLIC_CONVEX_URL` resolved to an `https://....convex.cloud` address. Restart
`bun run dev`.

**Check:** the game now shows *Host (persistent)*. Click it, then open the Convex
dashboard (`bunx convex dashboard`), *Data*, `rooms`: there is a row with your room code.

Every other developer runs the same command and gets a development deployment of their
own in the same project (invite them in the Convex dashboard, *Team settings*).

### The production deployment

```bash
bunx convex deploy
```

pushes the functions to production and prints its address. Run it again whenever a
change to `convex/` reaches `main`. Then tell the deployed builds where it is: on GitHub,
*Settings > Secrets and variables > Actions > Variables*, add

| Kind | Name | Value |
|------|------|-------|
| variable | `PUBLIC_CONVEX_URL` | the production address, e.g. `https://happy-animal-123.convex.cloud` |

It is a variable, not a secret: the address is built into the page and anyone who can
open the game can read it.

**Check:** comes with step 5, where a preview shows *Host (persistent)*.

To deploy from a script or CI without logging in, create a key in the Convex dashboard
(*Settings > URL & Deploy Key*) and provide it as `CONVEX_DEPLOY_KEY`. No workflow in
this template uses it yet.

## 5. Private previews: Cloudflare

Each pull request gets its own private copy of the game, which only the people you list
can open. Four things cannot be automated, because they are an account or a secret:

1. **Switch on R2 and Zero Trust.** In the Cloudflare dashboard open *R2 Object Storage*
   and enable it (it asks for a payment method; the free allowance is 10 GB). Open
   *Zero Trust*, pick a team name and the free plan (50 people).
2. **Create an API token.** *My Profile > API Tokens > Create Token*, starting from the
   template "Edit Cloudflare Workers", plus two account permissions: *Workers R2 Storage:
   Edit* and *Access: Apps and Policies: Edit*.
3. **Have a `workers.dev` subdomain.** Open *Workers & Pages* once; a new account is asked
   to choose one. The account id is on the same page, in the right-hand column.
4. **Give GitHub the values**, under *Settings > Secrets and variables > Actions*:

   | Kind | Name | Value |
   |------|------|-------|
   | secret | `CLOUDFLARE_API_TOKEN` | the token |
   | secret | `CLOUDFLARE_ACCOUNT_ID` | the account id |
   | variable | `PREVIEW_ALLOWED_EMAILS` | who may look, e.g. `ada@studio.com, bob@studio.com, @studio.com` |

   Include your own address. An entry starting with `@` admits a whole domain.

The first deploy creates everything else: the Worker, the R2 bucket, the Access
application.

**Check:** open a pull request that is not a draft (any change will do).

- The *Preview* workflow goes green, and the pull request shows a *View deployment* button.
- The link asks for your email, mails you a code, and then shows the game.
- An address that is not on the list is refused.
- With step 4 done, the game shows *Host (persistent)*.
- Close the pull request: the workflow runs once more and deletes the preview.

If the deploy fails, its last lines name the step (R2 not enabled, a permission missing
from the token, Zero Trust not set up). [deploying.md](deploying.md) explains each part.

## 6. The main deployment

Previews are per pull request; the main address is deployed by hand. Put the same values
in `.env.local` (git-ignored):

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
PREVIEW_ALLOWED_EMAILS=you@studio.com
```

A build made on your machine would use your development Convex deployment, so name the
production one for this command:

```bash
PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud bun run deploy
```

**Check:** the output ends with a line for `Assets` and one for `Cloudflare Access`, and
`https://<name>.<subdomain>.workers.dev` asks for your email like a preview does. It
stays private until you set `"PUBLIC_ACCESS": "true"` in `wrangler.jsonc`.

## 7. Optional extras

- **Check before every commit:** `bun run hooks`, once per clone ([checks.md](checks.md)).
- **Desktop app:** `bun run desktop:dev`. Not verified yet; see [desktop.md](desktop.md).
- **Agent skills** from PlayCanvas, Cloudflare and Convex: [agent-skills.md](agent-skills.md).
- **Stop secrets being committed:** `bunx varlock scan --install-hook`
  ([environment.md](environment.md)).

## Where each value lives

Useful when something is missing, and when moving to another repository or machine.

| Value | Lives in | Follows the code? |
|-------|----------|-------------------|
| Names (`wrangler.jsonc`, `PEER_PREFIX`, title) | the repository | yes |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secrets; `.env.local` for deploys by hand | no: per repository, per machine |
| `PREVIEW_ALLOWED_EMAILS`, `PUBLIC_CONVEX_URL` | GitHub variables; `.env.local` for deploys by hand | no: per repository, per machine |
| `CONVEX_DEPLOYMENT`, `CONVEX_URL` | `.env.local`, written by `bun run backend` | no: per developer |
| Convex and wrangler logins | your machine | no |
| Worker, previews, R2 bucket, Access application | your Cloudflare account, named after `"name"` in `wrangler.jsonc` | no |
| Functions, tables | your Convex project | no |

## From the test game to the real one

Once every check above has passed, the scaffolding is proven. What happens next depends
on where the real game will live.

### Same repository, same name

Nothing to do. Replace the sample under `game/` (README, "Making it yours") and keep
going. Optionally clear the test data, below.

### Same repository, new name

1. Redo [step 3](#3-names) with the real name, and push.
2. The next deploy creates a new Worker, bucket and Access application under that name.
   The GitHub secrets and variables stay as they are.
3. Delete what the old name left behind, below.
4. Convex: rename the project in its dashboard (the addresses do not change), or create a
   new one as in "A new repository" and update `PUBLIC_CONVEX_URL`.

### A new repository

1. Create it from this template (or copy the code) and redo [step 3](#3-names).
2. Re-enter the two secrets and two variables from steps 4 and 5 in the new repository's
   settings. The Cloudflare token can be the same one; R2 and Zero Trust are already on
   for the account.
3. Convex: to start clean, run `bunx convex dev --configure=new` to create a new project,
   then `bunx convex deploy`, and put the new production address in `PUBLIC_CONVEX_URL`.
   To keep the test project, copy `.env.local` across and clear its tables instead.
4. On each machine: `bun install`, and `bun run hooks` if you use it.
5. Run the checks of steps 2, 4 and 5 once more; they take a few minutes now.

### Clearing what the test run created

None of this is needed for the real game to work; it only tidies up.

**Cloudflare** (everything is named after the test `"name"`):

- *Previews:* closing a pull request deletes its preview. For one made by hand:
  `bunx wrangler preview delete --name <preview-name>`.
- *Worker:* with the test name still in `wrangler.jsonc`, `bunx wrangler delete`; or in
  the dashboard, *Workers & Pages*, the Worker, *Settings*, *Delete*.
- *R2 bucket* `<name>-assets`: dashboard, *R2 Object Storage*, the bucket; delete its
  objects, then the bucket under *Settings*. If you keep the name, emptying it is enough:
  the next deploy uploads what the build needs.
- *Access application* `<name> (Synergy preview gate)`: dashboard, *Zero Trust > Access >
  Applications*, delete. A deploy under the same name would recreate it.
- *API token:* keep it, or roll it and update the GitHub secret.

**Convex:**

- *Keep the project, drop the data:* dashboard, *Data*, each table (`rooms`, `commands`),
  *Clear table*, in both the development and the production deployment. Changing
  `convex/schema.ts` later needs nothing special while the tables are empty.
- *Drop the project:* dashboard, *Project settings*, *Delete project*. Then remove the
  `CONVEX_*` lines from `.env.local` (or delete the file) and run `bun run backend` again.

**GitHub:** remove secrets and variables only from a repository you are abandoning.

## What has not been run for real

The template's tests cover the Cloudflare gate, the asset upload and the Access set-up
against stand-ins, not a real account, and the Convex and PeerJS integrations are
type-checked only. A first run through this page is therefore also the first real test of
steps 4 to 6. When a step disagrees with this page, the command's error says which part
failed; please correct the page.
