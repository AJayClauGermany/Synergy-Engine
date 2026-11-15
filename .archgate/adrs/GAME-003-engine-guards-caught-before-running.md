---
id: GAME-003
title: Mistakes the engine refuses at run time are caught before it runs
domain: game
rules: true
files: ["game/src/**/*.ts", "game/src/**/*.tsx"]
---

## Context

Some Unity habits still compile after translation and are refused by the engine only when
the code runs (`docs/checks.md`, "Some mistakes are caught when the code runs";
`packages/engine/test/pitfalls.test.ts` lists them). The engine's message is good, but it
arrives late: in a test if one covers the line, otherwise in front of a player. Three of
them can be seen in the source:

- `private body = this.getComponent(MeshRenderer)` as a field. Field initialisers run while
  the script is being constructed, before the other components of its GameObject exist.
  The engine throws and points at `awake()`.
- A `Prefab` build function written as a Unity factory: it makes its own GameObject and
  returns it. `instantiate()` hands build the new instance to fill (`(go) => ...`), and
  throws when another object comes back.
- `new Vector3Int(width / 2, 0, 0)`. In C# integer division truncates; here `7 / 2` is
  `3.5`, and an integer vector refuses the fraction.

These are conventions of this engine rather than mistakes in one line of TypeScript, so
they are written down here, next to the check, for people and agents to read first.

## Decision

- Scripts look up other components in `awake()` or `start()`. A field may look up a
  component only when the class lists it in `static readonly requireComponents`.
- A prefab's build function takes the instance and adds to it; it may return something it
  added to the instance (an `instantiate(Child, go.transform)`), never an object of its own.
- A division inside `new Vector2Int(...)` or `new Vector3Int(...)` says how it rounds:
  `Math.trunc`, `Math.floor`, `Math.ceil`, `Math.round`, or the `Mathf` `...ToInt` helpers.

## Do's and Don'ts

### Do

- `private body: MeshRenderer | null = null;` then `awake() { this.body = this.getComponent(MeshRenderer); }`.
- `new Prefab('Enemy', (go) => { go.addComponent(Enemy); })`.
- `new Vector3Int(Math.trunc(width / 2), 0, 0)`.

### Don't

- Don't initialise a field with `this.getComponent(...)`, `this.getComponentInChildren(...)` or
  `this.gameObject.getComponent(...)`.
- Don't call `new GameObject(...)` in a build function that takes no parameter.
- Don't rely on an integer vector to round for you: it throws instead.

## Consequences

### Positive

- The engine's run-time guard becomes a finding with a file and line, before any test runs.

### Negative

- The checks read the source as text, so a lookup reached through a helper function
  (`readonly body = find(this)`) is not seen; the engine still catches it when it runs.

### Risks

- Regular-expression literals are not parsed. A regex containing a quote can hide the rest
  of its line from these checks (never cause a false finding).

## Compliance and Enforcement

### Automated Enforcement

- `GAME-003/no-component-lookups-in-field-initialisers`
- `GAME-003/prefabs-build-onto-their-instance`
- `GAME-003/integer-vectors-get-whole-numbers`

### Manual Enforcement

None: every case here has a run-time guard as well.

## References

- [AGENTS.md](../../AGENTS.md), "Unity knowledge transfers, with these differences", items 6 and 9
- `packages/engine/test/pitfalls.test.ts`
