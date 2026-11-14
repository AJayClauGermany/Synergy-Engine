# Inside a Unity project

A web port can live in the same Git repository as the Unity project it comes from. Put
this template in a folder at the Unity project's root, next to `Assets/`. The two keep
their own code. The web build imports art and audio straight from Unity's folders, so
each file exists once and a change made for Unity reaches the browser on the next build.

Everything inside the folder works there unchanged: `bun run check`, the dev server,
builds, Convex, Cloudflare deploys, varlock and the desktop app all find their files from
the folder's own position, not from the Git root. What has to change is whatever Git or
GitHub runs from the root of the repository: the workflows, the pre-commit hook, and
large-file storage (LFS) when the Unity project uses it. This guide covers those.

## The three names

The guide is written for any Unity project. These stand for the real paths, each relative
to the Unity project's root (the folder that holds `Assets/` and `ProjectSettings/`, and
here also the root of the Git repository):

| Name | Means | For example |
|------|-------|-------------|
| `<web>` | the folder this template lives in | `Prototype-Web-Port` |
| `<art>` | the folder that holds the art both builds use | `Assets/Art` |
| `<audio>` | the folder that holds the audio both builds use | `Assets/Audio` |

There can be more than one art or audio folder; list each wherever the guide lists
`<art>`. Only these folders are shared. Scripts, shaders, scenes, prefabs and materials
under `Assets/` are Unity's own and are never read by the web build.

To hand the set-up to an agent, give it the three values and this guide, for example:
"The web port is in `Prototype-Web-Port`, shared art is `Assets/Art`, shared audio is
`Assets/Audio`. Follow `docs/inside-a-unity-project.md`."

```text
<Unity project>/            the root of the Git repository
  .github/workflows/        the web port's workflows, moved here (step 3)
  Assets/
    <art>/                  shared: the web build imports from here
    <audio>/                shared
    Scripts/, Shaders/ ...  Unity only
  Packages/  ProjectSettings/
  <web>/                    this template: package.json, game/, packages/, convex/, ...
  CLAUDE.md, AGENTS.md      a short pointer for agents (step 6)
```

`<web>` sits beside `Assets/`, never inside it. Unity imports only `Assets/` and
`Packages/`, so it ignores `<web>`. Inside `Assets/` it would try to import
`node_modules/` and every script.

## 1. Put the template in `<web>`

From the Unity project's root, copy the template into `<web>` without its Git history:

```bash
git clone --depth 1 <template repository URL> <web>
```

```bash
rm -rf <web>/.git
```

Then, inside `<web>`, install and check as in a standalone clone:

```bash
cd <web> && bun install && bun run check
```

Run every `bun run` command from `<web>` from now on. `<web>/.gitignore` and
`<web>/.gitattributes` keep working where they are: Git applies them to the folder they
sit in. The Unity project's own ignore rules (`/[Ll]ibrary/`, `/[Tt]emp/`, ...) are
anchored to the root and do not touch anything in `<web>`.

## 2. Names

Name the game (`bun run rename <name> "Title"`; [setup.md](setup.md), step 3), so that the
Cloudflare Worker, its R2 bucket and its Access application are not called
`synergy-game`.

## 3. Workflows

GitHub reads workflows only from `.github/workflows/` at the root of the repository, so
the ones in `<web>/.github/workflows/` do nothing where they are. Move them to the root
`.github/workflows/` (rename any whose file name is already taken there) and delete
`<web>/.github/`. Then change each of them:

- **Run in `<web>`.** Add `defaults.run.working-directory: <web>` at the top level. This
  covers every `run:` step, not steps that `uses:` an action, so also change
  `bun-version-file: .bun-version` to `bun-version-file: <web>/.bun-version`.
- **Check out only what the web build reads.** Give `actions/checkout` a
  `sparse-checkout` of `<web>`, `<art>` and `<audio>`. A Unity project is large, and the
  build needs nothing else from it.
- **Run only for changes that affect the web build** (CI and Preview, not Teardown): a
  `paths` filter of `<web>/**`, `<art>/**`, `<audio>/**` on `push` and `pull_request`.
  If CI is a required status check under branch protection, a pull request that changes
  only Unity files will wait for it forever, because a skipped workflow reports nothing.
  Leave it optional, or make the required check one that always runs.
- **Fetch the shared files from LFS**, if the Unity project stores them there (its root
  `.gitattributes` names `filter=lfs` for their file types). Without that, the checkout
  holds small pointer files instead of the images and sounds, and the build ships them
  without an error. Fetch only the shared folders, not every file in LFS.

The CI workflow, changed this way:

```yaml
name: CI

on:
  push:
    branches: [main]
    paths: ['<web>/**', '<art>/**', '<audio>/**']
  pull_request:
    paths: ['<web>/**', '<art>/**', '<audio>/**']

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

defaults:
  run:
    working-directory: <web>

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |
            <web>
            <art>
            <audio>
      # Only when the Unity project keeps these files in Git LFS.
      - name: Fetch shared art and audio
        working-directory: .
        run: git lfs pull --include "<art>/**,<audio>/**"
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: <web>/.bun-version
      - run: bun install --frozen-lockfile
      - run: bun run check
      - run: bun run build
```

The Preview workflow takes the same `paths` filter. Its first job (`configured`) checks
out nothing, and a step whose working directory does not exist fails, so put `defaults`
on the two jobs that check out (`deploy` and `cleanup`) rather than on the whole
workflow. `deploy` takes the checkout above, with the LFS step; `cleanup` needs a
checkout of `<web>` only, no art or audio. Teardown takes `defaults` and a checkout of
`<web>`; it has no `paths`, since it runs only when started by hand.

The secrets and variables the workflows read
([setup.md](setup.md), step 5C: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`PREVIEW_ALLOWED_EMAILS`, `PUBLIC_CONVEX_URL`, `PREVIEW_PASSWORD`, `CONVEX_DEPLOY_KEY`)
belong to the Unity project's repository, as repository secrets and variables.

## 4. Use the shared art and audio

Import a shared file by its path relative to the importing file, as for a file inside
`game/`. Count the `../` up to the Unity project's root: from a file in
`<web>/game/src/<folder>/` that is four.

```ts sketch
import terrainUrl from '../../../../Assets/Art/Tiles/terrain.png' with { type: 'file' };
import clickUrl from '../../../../Assets/Audio/click.ogg' with { type: 'file' };
```

The build copies each imported file into `dist/assets/` under a name that holds a hash of
its content, as it does for files inside `game/` ([deploying.md](deploying.md), "Assets in
R2"). Only imported files are copied: the rest of `<art>`, and Unity's `.meta` files
beside them, never reach the build.

Do not give these folders an alias in `tsconfig.json` (`"paths": { "@art/*": ... }`).
Bun builds with it, but `bun run check` reports each import as a package missing from
`package.json`, because the folder is outside the project.

What the browser can use, and what needs a copy in another format:

| In `<art>` or `<audio>` | In the web build |
|---|---|
| `.png`, `.jpg`, `.svg` | Import as they are |
| `.psd`, `.tga`, `.tif`, `.exr` | Browsers cannot read them. Export a `.png` or `.jpg` beside the original and import that |
| `.fbx`, `.blend`, `.obj` | Convert to `.glb` and load it with `Assets.loadModel` |
| `.ogg`, `.mp3`, `.wav` | Import as they are. `.aif` plays in Safari only: convert it |
| Unity's import settings (sprite slicing, pixels per unit, atlases, compression) | Not read. Tile sheets come across with the exporter in `tools/unity` ([content.md](content.md)) |

`game/src/assets.d.ts` declares the file types an import may name. Add the audio types
the game uses there:

```ts sketch
declare module '*.ogg' {
  const url: string;
  export default url;
}
```

The engine has no audio API yet (see "Not implemented yet" in
[unity-to-synergy.md](unity-to-synergy.md)): play a sound with the browser's
`new Audio(url)`, or PlayCanvas's sound component through `gameObject.entity`.

The build ID that stops two different builds from playing together online is a hash of
the code only, so a build whose only change is a shared image keeps the same ID. Builds
that differ only in art can still play together.

## 5. The pre-commit hook

Do not turn on the hook (`bun run hooks`) in the Unity repository. Git looks for its folder
from the root of the repository, finds no `.githooks/` there, and commits without running
anything, with no message. A hooks folder that Git did find would also replace
`.git/hooks/`, where Git LFS keeps the hook that uploads large files on push. Rely on CI,
and run `bun run check` in `<web>` before committing.

## 6. Agents

An agent opened in `<web>` sees `AGENTS.md`, `CLAUDE.md` and the skills in `.claude/skills/`
as in a standalone clone, so open it there for work on the web port. For one opened at
the Unity project's root, add a short `AGENTS.md` (and a `CLAUDE.md` that says
`@AGENTS.md`) at the root, or add this to the ones that are already there:

```markdown
## The web port

The browser version of this game lives in `<web>/`. Its guide is `<web>/AGENTS.md`: read
it before changing anything there, and run every `bun run` command from `<web>/`. It
imports art from `<art>/` and audio from `<audio>/`; everything else under `Assets/` is
Unity's alone. Moving or renaming a file in those folders breaks an import in `<web>`:
run `bun run check` there afterwards.
```

A cloud agent's environment set-up script that installs dependencies needs the same
`cd <web>` first.

## Convex and Cloudflare

Nothing to change: `bun run backend`, `bun run preview:deploy` and `bun run deploy` run in
`<web>` and read `<web>/convex/`, `<web>/wrangler.jsonc` and `<web>/dist/`. If you connect
the repository to Cloudflare's own Git builds instead of the workflows, set the build's
root directory to `<web>`.

## Checking it works

1. In `<web>`: `bun run check` ends with `PASSED`.
2. `bun run build`, then `ls dist/assets`: the shared files that the game imports are
   there, with a hash in their names.
3. `bun run screenshot`, then look at `.screenshots/game.png`: the shared art is drawn.
4. On GitHub: a pull request that changes `<web>` or a shared file runs CI and deploys a
   preview; one that changes only Unity scripts runs neither.
