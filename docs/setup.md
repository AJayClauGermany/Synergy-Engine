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
| 3 | Names | nothing | `bun run rename <name>` has put your name in place of `synergy-game` |
| 4 | Backend (lobby, stored matches) | a Convex account (free) | *Host (persistent)* in the game creates a row in the `rooms` table |
| 5 | Private previews | a Cloudflare account (free, but R2 asks for a payment method) | a pull request shows *View deployment*, and the link opens the game once you sign in |
| 6 | Main deployment (optional) | step 5 | `bun run deploy` prints an address that opens for you |
| 7 | Optional extras | | commit hook, desktop app, agent skills |

A first run takes about an hour, most of it in step 5. Steps 1 and 2 need no account. Steps 4 and 5 do not depend on each other; skip either and
the rest still works (without Convex the game is single-player and peer-to-peer; without
Cloudflare the preview workflow passes and does nothing).

A coding agent can do most of this for you, and every check has a command you can run
as well: [If an agent does the set-up](#if-an-agent-does-the-set-up) says which parts
are yours and which commands do the rest.

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
(peer-to-peer) already work; they need no backend. Try them with two browser windows:
*Host* in one, *Join* with the code in the other. When the host leaves, the match ends for
the client too, as with a Unity host.

Peer-to-peer play connects the two browsers directly, which a VPN often blocks. If *Host*
or *Join* hangs, switch the VPN off, or use *Host (persistent)* after step 4: that one goes
through Convex and works behind a VPN.

## 2. CI on GitHub

Push the project to your GitHub repository. `.github/workflows/ci.yml` runs
`bun run check` and `bun run build` on every pull request and on pushes to `main`; it
needs no secrets.

**Check:** the repository's *Actions* tab shows a green *CI* run. (If the tab says
workflows are disabled, enable them there.)

The *Preview* workflow also runs on pull requests. Until step 5 it passes with the notice
"Previews are off" and its deploy job shows as skipped.

From here on, work on a branch and open a pull request rather than pushing to `main`:
previews exist per pull request, and CI then checks a change before it lands. Nothing
breaks if a set-up commit goes straight to `main`.

**Recommended: protect `main`.** It makes GitHub refuse a change to `main` that did not
come through a pull request with a green *CI* run, so a broken build cannot land by
accident, by you, a teammate or an agent. Two minutes, once:

1. *Settings > Branches > Add branch ruleset* (or *Add classic branch protection rule*).
   Name it `main`; under *Target branches* choose *Include default branch*; set
   *Enforcement status* to *Active*.
2. Tick **Require a pull request before merging**. Working alone, set *Required
   approvals* to 0: the rule then only asks for the pull request, not for a second person.
3. Tick **Require status checks to pass** and add the check called `check` (it is the job
   of the *CI* workflow, and appears in the list once CI has run).
4. Leave *Block force pushes* ticked. Save.

On a free plan this is available for public repositories; a private one needs GitHub Pro
or Team. Without it, the habit above is all there is, and that works too.

## 3. Names

Pick the game's name now, because the first deploy creates cloud resources under it. For
a test run a throwaway name such as `mygame-test` is fine; this step is the one you redo
for the real game.

```bash
bun run rename mygame-test "My Game Test"
```

The name is lowercase letters, digits and dashes; the title (optional) is what players
see. It changes every place a name lives:

| File | What changes |
|------|--------------|
| `wrangler.jsonc` | `"name"`, and **both** `"bucket_name"`s to `<name>-assets`. The three must agree; `bun run check` fails when they do not |
| `game/src/online.ts`, `game/src/frontier/session.ts` | `PEER_PREFIX`: keeps your room codes apart from other games on PeerJS's shared server |
| `game/index.html` | `<title>` |
| `desktop/electrobun.config.ts` | `app.name`, and the last part of `app.identifier` (change the `dev.synergy` before it by hand to a domain of yours) |
| `package.json` | `name` (change `description` and `license` by hand) |

Run `bun run check`, commit, push.

## 4. Backend: Convex

Convex holds the lobby and stored matches. A Convex project has a **development**
deployment per developer and one **production** deployment. Local work uses yours;
everything deployed to Cloudflare uses production.

### Your development deployment

```bash
bun run backend
```

The first time it asks you to log in and to name a project (name it like the game). It
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
*Join (persistent)* from a second window joins it, and the match survives a reload.

Convex also adds files for coding agents the first time: a block at the end of `AGENTS.md`
and `CLAUDE.md`, `convex/_generated/ai/`, and skills under `.claude/skills/` and
`.agents/skills/`. Commit them or delete them, as you prefer; run `bun run check` before
committing either way.

Every other developer runs the same command and gets a development deployment of their
own in the same project (invite them in the Convex dashboard, *Team settings*).

### The production deployment

```bash
bunx convex deploy
```

pushes the functions to production and ends with its address:
`Deployed Convex functions to https://....convex.cloud`. Run it again whenever a change
to `convex/` reaches `main`. Deployed builds learn that address in step 5.

To deploy from a script or CI without logging in, create a key in the Convex dashboard
(*Settings > URL & Deploy Key*) and provide it as `CONVEX_DEPLOY_KEY`. No workflow in
this template uses it yet.

## 5. Private previews: Cloudflare

Each pull request gets its own private copy of the game, which only the people you list
can open. This step has three parts, done in this order so that each is proven before the
next one starts: **A** prepares Cloudflare, **B** deploys a preview from your machine
(GitHub is not involved yet), **C** hands the same three values to GitHub.

### 5A. Cloudflare: three switches and a token

All of it is in the [Cloudflare dashboard](https://dash.cloudflare.com).

1. **Workers subdomain.** Open *Workers & Pages*. A new account is asked to choose its
   `workers.dev` subdomain; an account that has deployed before already has one. Copy the
   **Account ID** shown on that page.
2. **R2.** Open *R2 Object Storage* and enable it. It asks for a payment method; the free
   allowance is 10 GB.
3. **Zero Trust.** Open *Zero Trust*, pick a team name and the free plan (50 people).
4. **Sign-in by emailed code: nothing to do.** A new Zero Trust account offers only "Sign
   in with Cloudflare", which works for you but not for a tester without a Cloudflare
   login. The first deploy adds sign-in by a code mailed to the tester, using the last
   permission of the token below. (By hand, should you ever need it: *Zero Trust >
   Integrations > Identity providers*, *Add new identity provider*, **One-time PIN**.)
5. **API token.** *My Profile > API Tokens > Create Token*, then *Use template* next to
   **Edit Cloudflare Workers**. On the form:

   | Field | What to choose |
   |-------|----------------|
   | Permissions, already listed | leave them. *Workers R2 Storage: Edit* is among them; *Edit* includes reading, so *Read* stays unticked |
   | Permissions, *Add more* | *Account* / **Access: Apps and Policies** / *Edit* |
   | Permissions, *Add more* | *Account* / **Access: Organizations, Identity Providers, and Groups** / *Edit*. This is what lets a deploy do item 4, so that people without a Cloudflare login can sign in |
   | Account Resources | *Include* / your account |
   | Zone Resources | *Include* / *All zones*. The form will not continue without a choice; the game uses no zone |

   *Continue to summary*, *Create Token*, and copy the token: it is shown once.

Put the three values in `.env.local` (git-ignored; create it, or add to what
`bun run backend` wrote):

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
PREVIEW_ALLOWED_EMAILS=you@example.com
```

`PREVIEW_ALLOWED_EMAILS` is who may open a preview, separated by commas (spaces or new
lines work too): `ada@studio.com, bob@studio.com, @studio.com`. An entry starting with `@`
admits a whole domain. Include your own address, the one you will sign in with.

**Check:**

```bash
bun run cloudflare:check
```

changes nothing in the account. It prints one line per requirement and ends with `READY`,
or names what is `MISSING` and where to switch it on.

### 5B. A preview from your machine

```bash
bun run preview:deploy --name setup-test
```

The first deploy creates everything else: the Worker, the R2 bucket `<name>-assets`, the
Access application `<name> (Synergy preview gate)`, and sign-in by emailed code if the
token may switch it on. It runs wrangler twice that first time, because Access can only be
attached to a Worker that exists.

**Check:**

- The output ends with a `Deployed https://setup-test-<name>.<subdomain>.workers.dev`
  line, an `Assets:` line and a `Cloudflare Access: created, admitting ...` line.
- The address shows Cloudflare's sign-in page. Enter your email, receive a code, and the
  game opens. "Sign in with Cloudflare" works as well, for an address on the list. Once
  signed in you are not asked again for 7 days, on any preview; use a private window to
  see the sign-in page again.
- In a private window, an address that is not on the list gets no further than the
  sign-in page (it is told a code was sent; none is).

If the sign-in page offers only **Sign in with Cloudflare**, sign-in by emailed code is
off: do item 4 of 5A, then reload the page. Nothing needs deploying again.

If after signing in the page says **Preview locked**, the deployment was made without
Access: the `Cloudflare Access:` line of that deploy says why (usually an empty
`PREVIEW_ALLOWED_EMAILS`). [deploying.md](deploying.md), "Who gets in", explains the gate.

Delete the test preview when you are done:

```bash
bunx wrangler preview delete --name setup-test
```

### 5C. GitHub: the same values

Cloudflare now works; this part only tells GitHub what you already have in `.env.local`.
On GitHub open the repository's *Settings > Secrets and variables > Actions*. The page has
two tabs, *Secrets* and *Variables*, and each has a *Repository* section with a green
*New repository ...* button. Use those, not the *Environment* sections:

| Tab | Button | Name | Value |
|-----|--------|------|-------|
| Secrets | New repository secret | `CLOUDFLARE_API_TOKEN` | the token |
| Secrets | New repository secret | `CLOUDFLARE_ACCOUNT_ID` | the account id |
| Variables | New repository variable | `PREVIEW_ALLOWED_EMAILS` | the list, as in `.env.local` |
| Variables | New repository variable | `PUBLIC_CONVEX_URL` | the production address from step 4, e.g. `https://happy-animal-123.convex.cloud`. Leave it out without Convex |

The last two are variables, not secrets: the workflow reads them as variables, and a
secret of the same name is ignored. (The Convex address is built into the page anyway.)

With the [GitHub CLI](https://cli.github.com) the same takes four commands, run in the
repository. The first two ask for the value, so it never appears on screen or in history:

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
```

```bash
gh variable set PREVIEW_ALLOWED_EMAILS --body "you@example.com"
```

```bash
gh variable set PUBLIC_CONVEX_URL --body "https://happy-animal-123.convex.cloud"
```

**Check:** open a pull request that is not a draft (any change will do).

- The *Preview* workflow goes green, and the pull request shows a *View deployment* button
  leading to `https://pr-<number>-<name>.<subdomain>.workers.dev`.
- The run's summary page repeats the three lines of 5B. `Cloudflare Access: ... admitting`
  followed by your address means GitHub passed the list on.
- The link signs you in as in 5B and shows the game; with step 4 done it offers
  *Host (persistent)*.
- Push another commit: the summary says `0 uploaded to R2`, because no asset changed.
- Close the pull request: the workflow runs once more and deletes the preview.

To change who gets in, edit the variable; the next deploy applies it. A password
(`PREVIEW_PASSWORD`, a repository *secret*) is an optional fallback for deployments
without Access; with a list of emails set, Access comes first and the password is never
asked for. See [deploying.md](deploying.md), "Who gets in".

## 6. The main deployment (optional)

Previews are per pull request. The main address, `https://<name>.<subdomain>.workers.dev`,
is deployed only by hand, never by CI, so a game that ships as a desktop app alone can
skip this step. The values are already in `.env.local` from step 5.

A build made on your machine would use your development Convex deployment, so name the
production one for this command:

```bash
PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud bun run deploy
```

**Check:** the output ends with a line for `Assets` and one for `Cloudflare Access`, and
the address asks you to sign in like a preview does. It stays private until you set
`"PUBLIC_ACCESS": "true"` in `wrangler.jsonc` and deploy again.

## 7. Optional extras

- **Check before every commit:** `bun run hooks`, once per clone ([checks.md](checks.md)).
  A commit that fails `bun run check` is then refused.
- **Desktop app:** `bun run desktop:dev` ([desktop.md](desktop.md)). The first run
  downloads Electrobun's tools, which a VPN can block, and the system may ask whether the
  app may use the network.
- **Agent skills** from PlayCanvas, Cloudflare and Convex: [agent-skills.md](agent-skills.md).
- **Stop secrets being committed:** `bunx varlock scan --install-hook`
  ([environment.md](environment.md)). It looks for the values in `.env.local` anywhere in
  the files you commit, so a short everyday word used as a test password (`test`) is
  reported wherever that word appears. Use long random values.

## If an agent does the set-up

The steps above are written for a person clicking through dashboards. An agent (Claude
Code, Codex and the like) working in a clone of the repository can run nearly all of it
from a shell, but it cannot create accounts, pay, approve a login or read your email. This
section splits the work and gives the commands; they work just as well typed by you.

### Yours, whoever runs the rest

No command replaces these: each needs a browser, a login, a payment method or a decision.

- **The name** (step 3) and **who may open previews** (`PREVIEW_ALLOWED_EMAILS`).
- **Cloudflare, step 5A, items 1, 2, 3 and 5:** the account, the `workers.dev`
  subdomain, switching on R2 (a payment method) and Zero Trust, and creating the API token.
- **Convex, step 4:** approving the login, which the agent can start for you (below), and,
  only if you want the Teardown workflow to empty tables, the deploy key.
- **Writing `.env.local`.** The project's rules for agents (`AGENTS.md`, "Boundaries")
  forbid them to read or edit it, because it holds the token. You write it; the agent
  runs the commands that load it (`bun run env`, `bun run cloudflare:check`, the deploys),
  which never print a secret.
- **The GitHub repository's settings,** unless the agent's GitHub login is an admin of the
  repository: secrets, variables, rulesets and switching Actions on all need admin.
- **Signing in to a preview.** The code is emailed to you. The agent can prove the
  gate is up (below), not that it lets you through.

### What the agent needs

| | |
|---|---|
| Programs | Bun at the version in `.bun-version`, git, the [GitHub CLI](https://cli.github.com) logged in (`gh auth status`), and Chromium with Playwright for `bun run screenshot`. wrangler and the Convex CLI come with `bun install` |
| Network | GitHub, the npm registry, `api.cloudflare.com` (wrangler, R2 and Access all go through it), Convex's servers, and `0.peerjs.com` for peer-to-peer play |
| Credentials of its own | none. Cloudflare's come from your `.env.local` and the repository's secrets, Convex's from the login you approve |

An agent whose network blocks Cloudflare and Convex (some cloud sandboxes do) can still
take the [GitHub-only route](#the-github-only-route).

### Step by step

**1. Local development.** All the agent's, except trying *Host* and *Join* in two windows.

```bash
bun install
```

```bash
bun run check
```

```bash
bun run screenshot
```

The last one builds the game, opens it in headless Chromium and ends with
`Saved .screenshots/game.png`; it fails if the page logs an error.

**2. CI.** The agent pushes, then reads the latest run, which should say `completed` and
`success`:

```bash
gh run list --workflow ci.yml --limit 1
```

If workflows are switched off for the repository (admin):

```bash
gh api -X PUT "repos/{owner}/{repo}/actions/permissions" -F enabled=true
```

The `main` protection of step 2, as one command (admin; run CI once first so the check
`check` exists):

```bash
gh api -X POST "repos/{owner}/{repo}/rulesets" --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "check" }] } },
    { "type": "non_fast_forward" }
  ]
}
EOF
```

**3. Names.** You choose; the agent runs `bun run rename`, `bun run check`, commits and
pushes.

**4. Convex.** The agent starts the login; it prints a link and waits until you open it
and approve:

```bash
bunx convex login --login-flow poll --no-open
```

Then, without questions (the team's slug is listed by `bunx convex login status`):

```bash
bunx convex dev --once --configure new --team <team-slug> --project <name> --dev-deployment cloud
```

```bash
bunx convex deploy
```

The last line of `bunx convex deploy` is the production address that step 5C needs. To
check, list the game's buttons once the online panel is open: with Convex set up,
`Host (persistent)` is among them.

```bash
bun run screenshot --eval "[...document.querySelectorAll('button')].find(b => b.textContent === 'Play online').click()" --eval "[...document.querySelectorAll('button')].map(b => b.textContent)"
```

Click it and read the newest row of the `rooms` table, which should hold the room code
the game shows:

```bash
bun run screenshot --eval "[...document.querySelectorAll('button')].find(b => b.textContent === 'Play online').click()" --eval "[...document.querySelectorAll('button')].find(b => b.textContent === 'Host (persistent)').click()" --wait 3000 --eval "document.querySelector('.network code')?.textContent"
```

```bash
bunx convex data rooms --limit 1
```

**5A. Cloudflare.** Yours, then `.env.local`. The agent checks; it must end with `READY`:

```bash
bun run cloudflare:check
```

**5B. A preview from the agent's machine.**

```bash
bun run preview:deploy --name setup-test
```

That the gate is up: the address answers with a redirect to your Zero Trust team's
sign-in page (`https://<team>.cloudflareaccess.com/...`), never with the game.

```bash
curl -sI https://setup-test-<name>.<subdomain>.workers.dev | grep -i '^location'
```

You sign in by emailed code; then the agent deletes the test preview (it asks for
confirmation unless told not to):

```bash
bunx wrangler preview delete --name setup-test --skip-confirmation
```

**5C. GitHub.** With an admin login, this copies the values from `.env.local` into the
repository's secrets and variables without showing them to the agent, the screen or the
shell history:

```bash
bunx varlock run -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN && printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID && gh variable set PREVIEW_ALLOWED_EMAILS --body "$PREVIEW_ALLOWED_EMAILS"'
```

`PUBLIC_CONVEX_URL` is not copied: in `.env.local` it is your development address, and
GitHub needs the production one from step 4:

```bash
gh variable set PUBLIC_CONVEX_URL --body "https://happy-animal-123.convex.cloud"
```

```bash
gh secret list
```

```bash
gh variable list
```

The check, by the agent: open a pull request, wait for *Preview*, read its three lines.

```bash
gh pr create --fill
```

```bash
gh run list --workflow preview.yml --limit 1
```

```bash
gh run watch <run-id> --exit-status
```

```bash
gh run view <run-id> --log | grep -E 'Deployed|Assets:|Cloudflare Access:'
```

Then the same `curl` as in 5B on `https://pr-<number>-<name>.<subdomain>.workers.dev`,
your sign-in, and `gh pr close <number>`, after which *Preview* runs once more and
deletes it.

**6. Main deployment.** The agent runs it; you sign in.

```bash
PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud bun run deploy
```

**Clearing up.** The *Teardown* workflow, started from the command line. Without
`confirm` it only lists:

```bash
gh workflow run teardown.yml
```

```bash
gh workflow run teardown.yml -f confirm=<name> -f convex=true
```

```bash
gh run list --workflow teardown.yml --limit 1
```

```bash
gh run view <run-id> --log | tail -n 20
```

The log ends with `CLEAN` or `NOT CLEAN`. Leave out `-f convex=true` to keep the Convex
tables.

### The GitHub-only route

An agent that can reach GitHub but not Cloudflare or Convex skips step 5B and every
command that talks to them. You do steps 4 and 5A and enter the values of 5C in the
repository's settings; the agent does steps 1 to 3, opens the pull request, reads the
*Preview* run, and starts and reads *Teardown*. Nothing about Cloudflare needs to be on
its machine: the workflows use the repository's secrets. The clean-up recorded below was
done this way.

### Which of these commands have been run

On 12 November 2026, in a cloud sandbox: `bun install`, `bun run check` and
`bun run screenshot`, including the first `--eval` command of step 4 (without Convex it
lists `Close`, `Host`, `Join` and `End turn`), and `bunx varlock run -- sh -c` handing
values to the command inside. The flags of the Convex and wrangler commands were checked
against their `--help`. Not run yet: every `gh` command above against a real repository
(that sandbox's GitHub access could not set secrets or rulesets), the Convex login and
`--configure new` without questions, the `rooms` check, the `curl` gate check, and an
agent going through the whole page from start to finish.

## Where each value lives

Useful when something is missing, and when moving to another repository or machine.

| Value | Lives in | Follows the code? |
|-------|----------|-------------------|
| Names (`wrangler.jsonc`, `PEER_PREFIX`, title), written by `bun run rename` | the repository | yes |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub repository secrets; `.env.local` for deploys by hand | no: per repository, per machine |
| `PREVIEW_ALLOWED_EMAILS`, `PUBLIC_CONVEX_URL` | GitHub repository variables; `.env.local` for deploys by hand | no: per repository, per machine |
| `PREVIEW_PASSWORD` (optional fallback) | a GitHub repository secret; `.env.local` for deploys by hand. A deploy stores it with the Worker | no: per repository, per machine |
| Sign-in by emailed code | the Zero Trust account, once | no |
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
2. Re-enter the two secrets and two variables of [step 5C](#5c-github-the-same-values)
   in the new repository's settings. The Cloudflare token can be the same one; R2 and Zero Trust are already on
   for the account.
3. Convex: to start clean, run `bunx convex dev --configure=new` to create a new project,
   then `bunx convex deploy`, and put the new production address in `PUBLIC_CONVEX_URL`.
   To keep the test project, copy `.env.local` across and clear its tables instead.
4. On each machine: `bun install`, and `bun run hooks` if you use it.
5. Run the checks of steps 2, 4 and 5 once more; they take a few minutes now.

### Clearing what the test run created

None of this is needed for the real game to work; it only tidies up.

**Cloudflare** (everything is named after the test `"name"`). One command removes all of
it, and an agent can run it for you:

```bash
bun run cloudflare:teardown
```

That only lists what exists. Add `--confirm <name>`, with the `"name"` from
`wrangler.jsonc`, and it deletes, in this order:

1. the Worker, with every preview and version of it;
2. the Access application `<name> (Synergy preview gate)`;
3. the R2 bucket `<name>-assets`: every object, then the bucket.

It ends with `CLEAN`, or with `NOT CLEAN` and what was left and which token permission
was missing; running it again skips what is already gone. It needs the token and account
id of step 5, so there are two ways to run it:

- *From GitHub, with nothing on your machine:* the **Teardown** workflow (*Actions*,
  *Teardown*, *Run workflow*). Leave *confirm* empty to list, or type the Worker's name to
  delete. It uses the repository's secrets, so an agent that can start workflows can do
  the whole clean-up without a Cloudflare login.
- *Locally:* the command above, with the two values in `.env.local`.

What it leaves alone, because it belongs to the account and not to this game: the API
token (keep it, or roll it and update the GitHub secret), sign-in by emailed code, your
`workers.dev` subdomain, and R2 and Zero Trust being switched on. The next deploy under
the same name creates the Worker, the application and the bucket again.

By hand instead: `bunx wrangler delete` for the Worker; *R2 Object Storage*, the bucket,
delete its objects, then the bucket under *Settings*; *Zero Trust > Access > Applications*
for the application. Delete the Worker first: while it exists without its Access
application, it serves everyone.

**Convex:**

- *Keep the project, drop the data* (enough for a test run; changing `convex/schema.ts`
  later needs nothing special while the tables are empty). Either the dashboard: *Data*,
  each table (`rooms`, `commands`), *Clear table*, in both the development and the
  production deployment. Or the same command: `bun run cloudflare:teardown --confirm <name>
  --convex dev` empties every table of `convex/schema.ts` in your development deployment,
  `--convex prod` in the production one. In the Teardown workflow, tick *convex*; that
  needs a repository secret `CONVEX_DEPLOY_KEY`: Convex dashboard, the production
  deployment, *Settings*, *Deploy keys*, with exactly these four permissions ticked:
  `deployment:data:view`, `deployment:data:write`, `deployment:backups:view` and
  `deployment:backups:import` (emptying a table goes through Convex's import, which
  counts as restoring a backup). A key made only for deploying lacks them, and the run
  then names the one that is missing.
- *Drop the project:* only you can, in the dashboard: *Project settings*, *Delete project*.
  Then remove the `CONVEX_*` lines from `.env.local` (or delete the file) and run
  `bun run backend` again.

**GitHub:** remove secrets and variables only from a repository you are abandoning; that,
and deleting the repository, is done in its *Settings* by you.

## What a real run has confirmed

One complete run was made on 12 November 2026 (macOS, a private repository, a Cloudflare
account that had deployed Workers before). It found the faults that the steps above now
avoid; the last column says what has been run since.

| Step | Result of that run | Since |
|------|--------------------|-------|
| 1, 2 | Worked as written. CI was green on the first push with no settings changed | |
| 3 | Worked, but changing `"name"` alone failed `bun run check` | `bun run rename` added. **Confirmed the same day** on a fresh copy: it changed every file, and `bun run check` passed |
| 4 | Worked as written, including `bunx convex deploy`. Peer-to-peer hosting needed the VPN off; Convex's agent files failed the format check | both noted above; `.yaml` files are no longer format-checked |
| Multiplayer, locally | Skirmish peer-to-peer and on Convex (it survived a reload), and Frontier host and join, all connected | |
| 5A | The token from the template plus *Access: Apps and Policies: Edit* was enough. *Zone Resources* had to be filled in | `bun run cloudflare:check` added. **Confirmed the same day** against the account: it ended with `READY`, and reported an empty `PREVIEW_ALLOWED_EMAILS` as `MISSING` |
| 5C | The workflow ran on a private repository, created the Worker, the bucket and the Access application, linked `pr-1-<name>.<subdomain>.workers.dev`, and a second push uploaded no assets | **Confirmed the same day:** closing or merging a pull request deleted its preview (`pr-1` and `pr-2`) |
| 5, opening the link | **Failed.** Access offered only "Sign in with Cloudflare"; after signing in, the Worker answered "Preview locked". Cloudflare does not tell a Worker with static assets that Access admitted the visitor | the deploy now tells the Worker (`ACCESS_AUD`). **Confirmed the same day:** a pull-request preview opened after signing in, by emailed code (One-time PIN added by hand) and with "Sign in with Cloudflare". An address that is not on the list received no code |
| 6 | `bun run deploy` deployed and reported; the address was locked for the same reason | same fix; not run again |
| 7 | The commit hook refused a failing commit; `bun run desktop:dev` opened the game; `varlock scan` works | |
| Clearing the test run | Not part of that run | `bun run cloudflare:teardown` and the *Teardown* workflow added. **Confirmed the same day**, started by an agent with no Cloudflare login: the listing run found the Worker, the Access application and the bucket; the run with `confirm` deleted all three (the bucket held 1 object) and ended with `CLEAN`; a third run found nothing. The token of step 5A was enough. A pull request opened afterwards created the bucket, the Worker and the Access application again with nothing done by hand, and a second teardown removed them. With `convex` ticked it emptied `rooms` and `commands` in the production deployment, once the deploy key had the four permissions listed above (with three, Convex answered `You do not have permission to perform this operation (deployment:backups:view)`) |

A deploy also passed a `PREVIEW_PASSWORD` repository secret on to the Worker ("stored with
the Worker, but not asked for", since Access was in front). That run showed why the
password must be long: GitHub hides a secret's value wherever it occurs in a log, so a
short one blanks out parts of ordinary words, which gives it away, and the pull request
loses its "View deployment" link because the address contains it.

A second complete run was made later the same day, by a person following this page as
written, on a new repository made from the template and renamed with `bun run rename`. It
went from start to end with nothing to correct. The Cloudflare account was the one of the
first run, so the subdomain, R2 and Zero Trust were already on: step 5A on a new account
has been run only once. In the same run, multiplayer connected between two machines on
the same network. Frontier hosted and joined with a VPN switched on, but the two machines
could have found each other on the local network without going through it, so that
shows nothing about different networks.

Not run yet: a deploy switching on emailed codes by itself (the test token lacked that
permission), the password prompt on a deployment without Access, multiplayer on a deployed
preview and between two networks, the `PUBLIC_CONVEX_URL=... bun run deploy` form reaching
production Convex, and, of the clean-up:
emptying a bucket of more than a handful of objects, `--convex dev`, and the by-hand and
Convex dashboard routes. When a step
disagrees with this page, the command's last lines say which part failed; please correct
the page.
