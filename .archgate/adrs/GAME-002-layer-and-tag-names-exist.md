---
id: GAME-002
title: Layer and tag names refer to layers and tags that exist
domain: game
rules: true
files: ["game/src/**/*.ts", "game/src/**/*.tsx"]
---

## Context

Unity keeps layers and tags in the Tag Manager, and its editor offers only names that
exist. Here they are strings in code: `LayerMask.define(8, 'Units')` names a layer,
`go.tag = 'Enemy'` sets a tag, and `LayerMask.getMask('Units')`,
`GameObject.findWithTag('Enemy')` and `compareTag('Enemy')` look them up. The type-checker
accepts any string, so a name nobody defined compiles:

- `LayerMask.nameToLayer('Untis')` gives -1, and setting `layer` to it throws when the
  game runs; `getMask('Untis')` throws.
- `findWithTag('Enemy')` with no object ever tagged `Enemy` returns nothing, every time,
  with no error at all. `'mainCamera'` next to `'MainCamera'` is two different tags.

## Decision

- Every layer the game looks up by name is one of Unity's built-in layers or is defined
  with `LayerMask.define(index, name)` somewhere in `game/src`, at an index from 0 to 31.
- Every tag the game looks up is assigned with `.tag = '...'` somewhere in `game/src`.
- No two tags differ only in letter case; Unity's built-in spelling (`MainCamera`) wins.

## Do's and Don'ts

### Do

- Define the game's layers once, where the game starts, and look them up by the same
  literal.
- Set a tag in the prefab or scene builder that makes the object.

### Don't

- Don't look up a tag that only a test sets.
- Don't build layer or tag names from other strings at run time; the check cannot follow
  them, and neither can a reader.

## Consequences

### Positive

- A misspelt layer or tag is reported with the names that do exist, before the game runs.

### Negative

- Names held in variables are not followed.

### Risks

- A tag set only by data loaded at run time (a JSON prefab) looks unassigned. Suppress
  that finding with a reason naming the data file.

## Compliance and Enforcement

### Automated Enforcement

- `GAME-002/layers-are-defined`: names in `LayerMask.nameToLayer(...)` and
  `LayerMask.getMask(...)` are built in or defined; `LayerMask.define` indices are at most 31.
- `GAME-002/looked-up-tags-are-assigned`: names in `findWithTag`, `findGameObjectsWithTag`
  and `compareTag` are assigned somewhere; no two tags differ only in case.

### Manual Enforcement

None.

## References

- `packages/engine/src/physics/Physics.ts` (`LayerMask`)
- [docs/unity-to-synergy.md](../../docs/unity-to-synergy.md)
