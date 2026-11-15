# Architecture decisions (optional)

The decisions in `adrs/` are this template's conventions written down as
[archgate](https://archgate.dev) ADRs: a short document an agent reads before it starts,
and a `.rules.ts` file next to it that checks the code. They cover what the other checks
cannot see: names that only meet at run time (a scene, a layer, a tag, an environment
variable), and engine guards that today throw only once the code runs.

This layer is optional. Nothing in `bun run check` needs archgate, and the game builds and
passes without it. It adds to the other checks and replaces none of them:

| Check | Sees | Example |
|-------|------|---------|
| `bun run typecheck` | Types | `Update()` instead of `update()` |
| `bun run lint` (oxlint, `tools/lint/synergy.ts`) | One file's syntax | `velocity == Vector3.zero` |
| `bun run lint:project` (fallow) | The import graph | an import cycle, an unused export |
| `bun run docs:check` | The guides against the code | a sample that no longer compiles |
| `bun run adrs` (archgate) | Facts that span files, each tied to a written decision | `loadScene('Skirmsh')` when only `'Skirmish'` is registered |

A new rule goes where it fits best: a mistake visible in one line of code belongs in
`tools/lint/synergy.ts`, which runs on every `bun run check`. A rule goes here when it
needs several files at once, or the change set, or when the decision behind it is worth
reading as much as the check.

## Running it

```bash
bun run adrs
```

That runs `archgate check` (pinned to 0.61.0 in `package.json`; the first run downloads
the binary to `~/.archgate/bin`). It prints each finding with the ADR it breaks, exits 1
on a violation, and needs no account. Other ways to run it, from the
[CLI reference](https://cli.archgate.dev/reference/cli/check/):

```bash
bunx archgate@0.61.0 check --staged
```

checks only what is staged (for a pre-commit hook);

```bash
bunx archgate@0.61.0 review-context --verbose
```

prints the Decision and Do's and Don'ts of each ADR that applies to the files the branch
changed: a briefing for an agent before it starts.

On a branch, `archgate check` runs only the ADRs whose `files` match something the branch
changed; on `main` (no change set) it runs all of them.

## What is checked

| ADR | Rules | Instead of |
|-----|-------|------------|
| [GAME-001](adrs/GAME-001-scenes-are-registered-and-complete.md) Scenes | a loaded scene name is registered; each scene has a `MainCamera` and a `Light` | a load that throws; `Camera.main` null, with a warning |
| [GAME-002](adrs/GAME-002-layer-and-tag-names-exist.md) Layers and tags | layer names are defined; looked-up tags are set somewhere; no two tags differ only in case | `getMask` throwing; `findWithTag` silently finding nothing |
| [GAME-003](adrs/GAME-003-engine-guards-caught-before-running.md) Engine guards | no `getComponent` in a field initialiser; prefabs fill `go`; integer vectors get whole numbers | the engine throwing when the script, prefab or vector is made |
| [GAME-004](adrs/GAME-004-plain-data-on-the-wire.md) Wire data | commands, RPC arguments and network variables are plain data | `session.submit()`, the RPC or the variable refusing the value |
| [GAME-005](adrs/GAME-005-content-and-commands-are-tested.md) Tests | each shipped palette and map is checked by a test; each command variant is named in one | a blank tile; a wrong rule nothing notices |
| [FE-001](adrs/FE-001-hud-events-reach-their-handlers.md) HUD | text fields use `onInput`; click handlers are on interactive elements | a field one edit behind; a click that lands on the board |
| [GEN-001](adrs/GEN-001-environment-variables.md) Environment | browser code reads only `PUBLIC_` variables; each is declared and not secret | `undefined` in the page, or a secret in the bundle |
| [GEN-002](adrs/GEN-002-generated-convex-code.md) Generated code | `convex/_generated/` changes only with its sources | a hand edit lost on the next `convex dev` |

## How the rules are tested

archgate runs a rules file in a sandbox: it may import nothing (bar a few `node:` modules)
and reaches the project only through `ctx`. So the rules are tested without archgate:
`tools/archgate/harness.ts` gives them the same context (project-relative paths, sorted
globs, line-by-line `grep`), and `tools/archgate/adrs.test.ts` runs each rule on small
projects it must accept and must report. Those tests are part of `bun test`; they check the
rules, not this repository. They also hold each file to what archgate's loader requires
and to the briefing budget (2000 characters for Decision, and for Do's and Don'ts).

`tsconfig.json` here type-checks the rules (`bun run typecheck`) against `rules.d.ts`, the
types archgate writes for them. It is committed so that the type check works without
archgate; archgate 0.61.0 writes the same file, and a newer version rewrites it, which then
shows as a change to commit. The tsconfig gives the rules no Bun, Node or DOM types, so
naming `Bun` or `process` in one, which archgate refuses, is a type error.

## Adding a decision

1. Copy an ADR and its rules file, with the next ID: `GAME-` for the game's conventions
   (registered in `config.json`), `FE-` for the HUD, `GEN-` for the rest.
2. Keep Decision and Do's and Don'ts short: they are what an agent is briefed with.
3. Each rule reports with `ctx.report.violation` (the project's checks are errors or off),
   says what happens at run time in `message`, and what to write instead in `fix`.
4. Add its cases to `tools/archgate/adrs.test.ts`: one it accepts, one it reports. The test
   fails for a rule without both.
5. `bun run check`, then `bun run adrs` to see it on the project.

A finding that is right to keep is suppressed in the code, with a reason:
`// archgate-ignore GAME-002/looked-up-tags-are-assigned set by the level data file`.
