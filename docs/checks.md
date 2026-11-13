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
ok      test      2.6s  422 pass in 28 files
ok      docs      0.4s  58 code blocks compiled
ok      project   1.0s

FAILED: lint. Fix what is listed above, top first, then run `bun run check` again.
```

Long output is cut to its first lines (60, or 100 for tests); the command named in the
cut line shows all of it. `bun run check lint types` runs only the checks you name, and ends with
`OK so far` and the checks it left out: only a run of all of them says `PASSED`. A test
that was skipped or left as a todo is counted on the `test` line as `NOT RUN`.

## What runs

| Check | Tool | Alone | Catches |
|-------|------|-------|---------|
| `install` | `bun install --frozen-lockfile` | | `node_modules` or `bun.lock` out of step with `package.json` |
| `format` | `bun fmt` (built into Bun) | `bun run format:check` | Layout. Never fixed by hand: `bun run fix` |
| `lint` | [oxlint](https://oxc.rs), type-aware, plus `tools/lint/synergy.ts` | `bun run lint` | Mistakes visible in one file, including the Unity habits below |
| `types` | `bun check` (built into Bun; TypeScript 7's checker) | `bun run typecheck` | Type errors, Unity-cased messages (`Update`), operators on vectors |
| `test` | `bun test` | `bun test` | Behaviour: rules, scenes run headless, simulated networks |
| `docs` | `scripts/docs.ts` | `bun run docs:check` | Guides that have drifted from the code: a sample that no longer compiles, a member, script or file that is not there, a skill out of shape |
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
| `no-unsent-message` | `onStart() {}`, `onTriggerEnter() {}`, `onPointerClick() {}` in a script | `start() {}`; for triggers, `Physics.overlapSphere` in `update()` |
| `no-discarded-result` | `transform.position.add(step);` `bounds.encapsulate(point);` | `transform.position = transform.position.add(step);` |
| `no-inline-remove` | `event.removeListener(() => this.onHit())` | Keep what `addListener` returned and call it, or make the handler a field |
| `no-engine-member` | `_started = false;` `_destroy() {}` in a script | Another name: the engine has members of those names on every script |
| `network-members` | `healServerRpc() {}`, `#hp = new NetworkVariable(10)`, variables inside an array | `readonly healRpc = this.serverRpc(...)`, `readonly hp = new NetworkVariable(10)`: one field each |
| `no-module-state` | `let nextId = 0;` at the top of a rules file | Keep it in the game state; rules files only |
| `no-skipped-test` | `test.skip(...)`, `test.only(...)`, `test.skipIf(true)(...)`, `test.failing(...)`, `test.todo('name', () => ...)` | Fix the test. `test.todo('name')`, with no body, marks one still to write |
| `test-needs-expect` | A test with no `expect(...)`, or `expect(x);` with no matcher | Assert the result; `expect(() => run()).not.toThrow()` if that is the point |
| `behaviour-file-name` | `export class Health extends MonoBehaviour` in `health.ts` | The file is `Health.ts`; one exported script per file (game code only) |

Why each matters:

- **Identity.** `Vector3`, `Quaternion`, `Color` and the `Int` vectors are structs in C#
  and objects here. `==` and `===` ask "is this the same object", so two equal vectors
  made separately are not equal, and a `Map` or `Set` keyed by one never finds a key built
  from the same numbers.
- **Detached methods.** C# binds `OnClick` to its object when you pass it. JavaScript
  passes the bare function, and `this` is `undefined` when it runs. The rule knows the
  two calls that bind for you: the `invoke` family (`this.invoke(this.tick, 1)` is
  correct) and any call that is also given `this`. `this.startCoroutine(this.run)` gets its own
  message, because there the fix is to call the method: `this.startCoroutine(this.run())`.
- **Messages.** The engine calls `start`, `update` and the others by name. A method named
  almost like one is never called and nothing fails; the script just does nothing.
  (`Update()` in Unity's capitals is a type error, so the type check reports that one.)
- **Results thrown away.** Vectors, colours and bounds are immutable: `add` returns the
  sum and changes nothing. In Unity `position += step` moved the object, and in PlayCanvas
  or three.js `add` changes the vector in place, so the line reads as if it worked.
- **Removing a listener** needs the same function that was added. One written at the call
  is a new function, so nothing is removed, and the listener lives as long as the event.
- **The engine's own members.** A script is told to name its private fields with a leading
  underscore, and the engine names its own that way too. `_started = false` in a script
  replaces the engine's flag of that name, and messages stop arriving with no error.
- **Network members are fields.** A variable or RPC is bound to its object by its field
  name. A method named like an RPC is an ordinary method and runs only where it is
  called; a `#private` field, or one tucked into an array, is never bound, so it never
  leaves the machine.
- **Tests that cannot fail** pass whatever the code does, which hides exactly what tests
  are for. A skipped test is the same thing under another name, and `expect(x);` with no
  matcher after it compares nothing.

Some mistakes are caught when the code runs, because only then is there enough to go on.
Each of these throws (or warns) with what to write instead; `packages/engine/test/pitfalls.test.ts`
and `packages/netcode/test/pitfalls.test.ts` list them all:

- `tilemap.getTile(unit.transform.position)`: a world position where a cell is wanted,
  and `new Vector3Int(7 / 2, 0, 0)`: C#'s integer division, which here leaves 3.5.
- `private body = this.getComponent(MeshRenderer)` as a field: it runs before the other
  components exist.
- A `Prefab` whose build function makes and returns its own GameObject.
- `Camera.main` with a camera that is not tagged `MainCamera`.
- `new Random()` without a seed, `new Random(Math.random())`.
- `unit.layer = LayerMask.nameToLayer('Units')` for a layer nobody defined.
- A `Vector3`, a `Map`, `Infinity` or `NaN` in a command, an RPC argument or a
  `NetworkVariable`: JSON would change it on every machine but the sender's.
- `engine.stepSeconds(1)` in a test while `Time.timeScale` is 0.

And some are type errors: `*update()` or `async update()` (a message returns nothing;
only `start` and the mouse messages may be coroutines), `hud.value.gold += 5` and
`items.value.push(x)` on an `Observable` or a `NetworkVariable` (the value is read-only:
assign a new one), `engine.input.pressKey('w')` (it takes a `KeyCode`), and
`Mathf.smoothDamp` with Unity's last two arguments missing.

The stock rules that were turned on for the same reason: `eqeqeq`,
`require-array-sort-compare` (`[10, 9].sort()` sorts as text),
`switch-exhaustiveness-check` (a new `Command` variant must be handled in `check()` and
`apply()`), `no-floating-promises`, `no-explicit-any`, `no-non-null-assertion`,
`ban-ts-comment` (`@ts-ignore` and `@ts-nocheck` are refused; `@ts-expect-error` needs
its reason on the same line).

Files of game rules (`game/src/rules/**`, any `rules.ts`) get more, because rules must
give every machine the same answer: no `Math.random()` or `crypto` (use
`new Random(seed)`), no `Date` or `performance`, nothing that reads the player's language
settings (`localeCompare`, `toLocaleString`, `Intl`), no `globalThis`, `window`,
`document` or `localStorage`, no `let` at the top of the file (`no-module-state`), and no
import of `@synergy/engine` itself (use `@synergy/engine/math`, `/grid` and `/data`, which
have no scene in them).

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

## Documentation

`AGENTS.md`, `docs/` and the skills are what a person or an agent copies from, so a guide
that says something the code no longer does is a bug that spreads. The `docs` check reads
every Markdown file in the repository and holds it to the code:

- **Code blocks compile.** Each ` ```ts ` or ` ```tsx ` block is type-checked against the
  real packages, with the project's own settings. A block can be a whole file, the
  members of a script (`update() { ... }`), or statements from inside a method; the check
  works out which. A fragment need not import what it uses, and names it leaves to the
  reader (`unit`, `select(...)`, `Command`) are let through. Everything it says about the
  engine is checked: `tilemap.setTiles(...)` must exist and take those arguments.
- **A block that imports from a package imports everything it uses from it**, so a block
  that looks complete can be pasted as it is.
- **Bare names with a known meaning are typed.** In a fragment, `engine`, `gameObject`,
  `transform`, `grid`, `tilemap`, `networkManager` and `networkObject` are the engine's
  types. A file can add its own with a comment anywhere in it:
  `<!-- check: manager: NetworkManager; session: CommandSession<Command> -->`.
- **A member named in a sentence exists.** `` `Tween.move(...)` `` or
  `` `tilemap.setTile` `` in running text is checked like code. Names in Unity's capitals
  (`` `Physics.Raycast` ``) are taken as quotations and left alone.
- **`bun run <name>` names a script** in `package.json`.
- **A path to a file exists**: `` `game/test/scene.test.ts` ``, and relative Markdown
  links. A path that stands for a file the reader will make uses one of the example names
  (`Thing.ts`, `Mover.ts`, `Unit.ts`, ...; the list is `EXAMPLE_PATHS` in `scripts/docs.ts`).
- **A skill has its shape**: see [agent-skills.md](agent-skills.md), "Writing a skill".

A block that is not meant to be real code (two fragments from different files side by
side, something elided with `...`) opens with ` ```ts sketch ` and is not compiled. Use it
sparingly: a sketch can drift, a compiled block cannot.

When the check fails, decide which side is right. If the code is right, correct the
guide. If the guide describes what the API should have been, that is a finding about the
code.

## Suppressing a finding

Change the code first. When a finding really is wrong for one place, say so next to it,
with the reason:

```ts sketch
// oxlint-disable-next-line synergy/no-unsent-message -- the mistake this test is about
onStart() {}

// fallow-ignore-next-line circular-dependency -- each side uses the other in methods, never while loading
import { NetworkManager } from './NetworkManager';
```

A suppression that no longer suppresses anything is itself reported, and one without a
reason is an error: fallow checks its own, and `tools/lint/suppressions.test.ts` reads
every file for an `oxlint-disable` with no rule or no ` -- reason`, and for `@ts-ignore`
and `@ts-nocheck` (the linter cannot do this itself, since a blanket disable switches
off the rule that would report it). Turning a rule off in the config is a decision about the
whole project: make it in its own change and say why in the config, as the existing
entries do.

Six stock rules are off on purpose, each with its reason beside it in `.oxlintrc.json`:
`unbound-method` (it reports `this.invoke(this.tick, 1)`; `no-detached-method` covers the
real mistake), `await-thenable` (it reports `await expect(...).rejects`),
`restrict-template-expressions` (it reports `${vector}`, and the value types print
themselves), `no-this-alias`, `unicorn/no-useless-spread`, and `react/immutability` (it
does not know refs from `preact/hooks`).

## Adding a rule

When a port trips over something a rule could have caught, add the rule:

1. Write it in `tools/lint/synergy.ts`. A rule sees one file's syntax tree and no types,
   so it should report only what the text makes certain. A false alarm costs more than a
   miss.
2. Add snippets it must accept and must report to `tools/lint/synergy.test.ts`. They run
   through the real linter.
3. Turn it on in `.oxlintrc.json` and add a row to the table above.

If it needs types, look for an existing oxlint rule first. `bun --bun oxlint --rules -f json > rules.json`
lists them (write it to a file: piped, the output is cut short); `type_aware` marks the
ones that read types.

## Other tools

- `bun run coverage` runs the tests with Bun's coverage and lists, per file, the lines no
  test reached. Use it to see what a new script's test misses. It is not part of
  `bun run check`.
- `bun run hooks` makes git run `bun run check` before every commit in this clone
  (`.githooks/pre-commit`). It is off until you run that. `git commit --no-verify` skips it.
  The checks read the files on disk, so the hook first refuses a commit that leaves
  changes unstaged: it would be checking something other than what is committed.
- CI (`.github/workflows/ci.yml`) runs the same `bun run check`, then the build.
- Every TypeScript file must belong to one of the three `tsconfig.json` files
  (`scripts/check.test.ts` holds that): a file in a folder none of them includes would be
  linted and tested but never type-checked.

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
