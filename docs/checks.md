# Checks

Every check that can be decided by a program is, and one command runs them all:

```bash
bun run check
```

It ends with `PASSED` or `FAILED` (exit code 0 or 1) and takes a few seconds. A change is
not done until it passes. The checks cannot see a picture or know what the game should do;
for that there are tests you write and `bun run screenshot`
([verify-changes](../.claude/skills/verify-changes/SKILL.md)).

## The loop

```bash
bun run fix
```

applies everything a tool can fix by itself (safe lint fixes, then formatting) and then
runs the same checks. So the working loop, for a person or an agent, is:

1. Change something small: one script and its test.
2. `bun run fix`.
3. If it says `FAILED`, read the **first** failure, do what its "What to do" says, and go
   to 2. Later failures often disappear with the first.
4. `PASSED`: go on to the next thing.

A failing run looks like this:

```
---- lint FAILED: mistakes in one file (oxlint) ----
  game/src/behaviours/Patroller.ts:16:9: error synergy(no-identity-compare): `==` compares two
  Vector3 objects by identity, not by their numbers, so this is false for two equal values ...
  What to do:
    Run `bun run fix` for what can be fixed automatically, then fix the rest by hand, ...

ok      install   0.0s
ok      format    0.1s
FAILED  lint      1.4s  1 problem
ok      types     0.5s
ok      test      2.6s  419 pass
ok      project   1.0s

FAILED: lint. Fix what is listed above, top first, then run `bun run check` again.
```

Long output is cut to its first lines (60, or 100 for tests); the command named in the
cut line shows all of it. `bun run check lint types` runs only the checks you name.

## What runs

| Check | Tool | Alone | Catches |
|-------|------|-------|---------|
| `install` | `bun install --frozen-lockfile` | | `node_modules` or `bun.lock` out of step with `package.json` |
| `format` | `bun fmt` (built into Bun) | `bun run format:check` | Layout. Never fixed by hand: `bun run fix` |
| `lint` | [oxlint](https://oxc.rs), type-aware, plus `tools/lint/synergy.ts` | `bun run lint` | Mistakes visible in one file, including the Unity habits below |
| `types` | `bun check` (built into Bun; TypeScript 7's checker) | `bun run typecheck` | Type errors, Unity-cased messages (`Update`), operators on vectors |
| `test` | `bun test` | `bun test` | Behaviour: rules, scenes run headless, simulated networks |
| `project` | [fallow](https://fallow.tools) | `bun run lint:project` | What only shows across files: unused files and exports, undeclared packages, import cycles, layering |

All of it runs on Bun alone; Node is not needed. Settings live in `bunfig.toml` (`[fmt]`,
`[test]`), `.oxlintrc.json` and `.fallowrc.jsonc`. To lint or test one file while working
on it: `bun run lint game/src/behaviours/Unit.ts`, `bun test game/test/unit.test.ts`.

## Rules for Unity habits

These are in `tools/lint/synergy.ts`. Each one is a line of C# that is still valid
TypeScript after translation, passes the type-checker, and then does something else.

| Rule | Reported | Write instead |
|------|----------|---------------|
| `no-identity-compare` | `if (velocity == Vector3.zero)` | `if (velocity.equals(Vector3.zero))` |
| `no-value-keys` | `new Map<Vector3Int, Unit>()`, `Set<Vector2Int>` | `new Map<string, Unit>()` keyed by `cellKey(cell)` |
| `no-detached-method` | `button.onClick.addListener(this.onClick)` | `addListener(() => this.onClick())`, or declare `onClick = () => { ... }` |
| `no-unsent-message` | `onStart() {}`, `onTriggerEnter() {}` in a script | `start() {}`; for triggers, `Physics.overlapSphere` in `update()` |
| `no-z-axis-literal` | `new Vector3(0, 0, 1)` | `Vector3.back` (or `Vector3.forward`, which is -Z here) |
| `no-skipped-test` | `test.skip(...)`, `test.only(...)` | Fix the test. `test.todo('name')` marks one still to write |
| `test-needs-expect` | A test with no `expect(...)` | Assert the result; `expect(() => run()).not.toThrow()` if that is the point |
| `behaviour-file-name` | `export class Health extends MonoBehaviour` in `health.ts` | The file is `Health.ts`; one exported script per file (game code only) |

Why each matters:

- **Identity.** `Vector3`, `Quaternion`, `Color` and the `Int` vectors are structs in C#
  and objects here. `==` and `===` ask "is this the same object", so two equal vectors
  made separately are not equal, and a `Map` or `Set` keyed by one never finds a key built
  from the same numbers.
- **Detached methods.** C# binds `OnClick` to its object when you pass it. JavaScript
  passes the bare function, and `this` is `undefined` when it runs. The rule knows the
  two calls that bind for you: the `invoke` family (`this.invoke(this.tick, 1)` is
  correct) and any call that is also given `this`.
- **Messages.** The engine calls `start`, `update` and the others by name. A method named
  almost like one is never called and nothing fails; the script just does nothing.
  (`Update()` in Unity's capitals is a type error, so the type check reports that one.)
- **Tests that cannot fail** pass whatever the code does, which hides exactly what tests
  are for.

The stock rules that were turned on for the same reason: `eqeqeq`,
`require-array-sort-compare` (`[10, 9].sort()` sorts as text),
`switch-exhaustiveness-check` (a new `Command` variant must be handled in `check()` and
`apply()`), `no-floating-promises`, `no-explicit-any`, `no-non-null-assertion`.

Files of game rules (`game/src/rules/**`, any `rules.ts`) get three more, because rules
must give every machine the same answer: no `Math.random()` (use `new Random(seed)`), no
`Date` or `performance.now()`, and no import of `@synergy/engine` itself (use
`@synergy/engine/math`, `/grid` and `/data`, which have no scene in them).

## Layering

`.fallowrc.jsonc` says which folder may import which. A file belongs to the first zone
that matches it; an arrow means "may import".

```
engine-math   packages/engine/src/math      → nothing
engine-grid   packages/engine/src/grid      → engine-math
engine-data   packages/engine/src/data      → engine-math
engine        packages/engine/src           → engine-math, engine-grid, engine-data
net           packages/net/src              → nothing
netcode       packages/netcode/src          → engine*, net
ui            packages/ui/src               → engine*
game-rules    game/src/rules, any rules.ts  → engine-math, engine-grid, engine-data
game          game/src                      → anything
```

Nothing imports `game`. A boundary violation is fixed by changing the import: move the
code to where it may be used, or pass the value in instead of importing its source.

The same run reports:

- **Unused files and exports** in game code. Something was written and never wired up (a
  scene not registered, a script nothing adds), or was left behind. Import it where it
  belongs, give it a test, or delete it. A test counts as a use, so "one script, one
  test" keeps a port clean as it goes. The engine packages are libraries: their exports
  are API and are not reported.
- **Undeclared packages**: an import of something no `package.json` lists. `bun add` it in
  the package that uses it. Not in `packages/engine`, though: it depends on PlayCanvas
  and nothing else, and a test holds it to that.
- **Import cycles.** C# has no load order, so Unity classes refer to each other freely.
  Here, if `A.ts` and `B.ts` import each other, one of them is still empty while the
  other loads; `class B extends A` then fails at startup. If one side needs only the
  type, `import type` ends the cycle. Otherwise move what both need into a third file.

## Suppressing a finding

Change the code first. When a finding really is wrong for one place, say so next to it,
with the reason:

```ts
// oxlint-disable-next-line synergy/no-unsent-message -- the mistake this test is about
onStart() {}

// fallow-ignore-next-line circular-dependency -- each side uses the other in methods, never while loading
import { NetworkManager } from './NetworkManager';
```

A suppression that no longer suppresses anything is itself reported, and a fallow one
without a reason is an error. Turning a rule off in the config is a decision about the
whole project: make it in its own change and say why in the config, as the existing
entries do.

Three stock rules are off on purpose: `unbound-method` (it reports
`this.invoke(this.tick, 1)`; `no-detached-method` covers the real mistake),
`await-thenable` (it reports `await expect(...).rejects`), and
`no-unnecessary-type-assertion` (its automatic fix removed a cast the code needed).

## Adding a rule

When a port trips over something a rule could have caught, add the rule:

1. Write it in `tools/lint/synergy.ts`. A rule sees one file's syntax tree and no types,
   so it should report only what the text makes certain. A false alarm costs more than a
   miss.
2. Add snippets it must accept and must report to `tools/lint/synergy.test.ts`. They run
   through the real linter.
3. Turn it on in `.oxlintrc.json` and add a row to the table above.

If it needs types, look for an existing oxlint rule first
(`bun --bun oxlint --rules -f json` lists them; `type_aware` marks the ones that read types).

## Other tools

- `bun run coverage` runs the tests with Bun's coverage and lists, per file, the lines no
  test reached. Use it to see what a new script's test misses. It is not part of
  `bun run check`.
- `bun run hooks` makes git run `bun run check` before every commit in this clone
  (`.githooks/pre-commit`). It is off until you run that. `git commit --no-verify` skips it.
- CI (`.github/workflows/ci.yml`) runs the same `bun run check`, then the build.

## When a check itself is wrong

`bun run check` prints the tools' own words, so a search for the rule name in brackets
(`synergy(no-value-keys)`, `typescript(no-floating-promises)`) leads to its description.
The tools are pinned by `bun.lock`; `bun update oxlint fallow` is a change like any other
and may surface new findings.

Limits worth knowing:

- oxlint's support for plugins written in JavaScript, which `tools/lint/synergy.ts`
  uses, is marked alpha by oxlint. The rules are tested through the real linter, so an
  update that breaks them fails `bun test`.
- The custom rules read text, not types. `no-detached-method` only knows methods of the
  class it is looking at; `no-identity-compare` only sees a comparison with a named
  constant (`Vector3.zero`) or a `new Vector3(...)`. `a.position == b.position` is not
  caught: tests are.
- fallow does not check class members, because a script's fields are set from outside
  and its messages are called by name.
