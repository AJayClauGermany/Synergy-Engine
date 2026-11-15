---
id: GAME-005
title: Shipped content files and every command have a test
domain: game
rules: true
files: ["game/**/*.ts", "game/**/*.tsx", "game/**/*.json"]
---

## Context

Two kinds of game code fail quietly when nobody tests them.

Content files. A tile palette or a painted map is JSON (`docs/content.md`,
`docs/tilemaps.md`). A tile id that is not in the palette, or a row one cell short, is not
an error anywhere: the tile is simply blank. The engine ships `checkTilePaletteData` and
`checkTilemapData`, which describe every such problem in a sentence, and AGENTS.md asks for
one test that runs them over every palette and map the game ships
(`game/test/content.test.ts`). A new map added without it is checked by nothing.

Commands. In the commands model every machine runs `check()` and `apply()` on each command
(`docs/multiplayer.md`). The type-checker makes sure each variant is handled
(`switch-exhaustiveness-check`), not that the handling is right. A wrong rule for one
variant plays wrong for every player alike, so nothing looks out of step, and no test fails.

## Decision

- Every tile palette and tile map under `game/` is run through `checkTilePaletteData` or
  `checkTilemapData` by a test that imports it, or imports the module that loads it.
- Every variant of the command type a session carries (`type: 'move'`, ...) is named in a
  test under `game/`.

## Do's and Don'ts

### Do

- Add a new map or palette to `game/test/content.test.ts` in the same change that adds it.
- Write the rule test with the variant: what `check()` accepts and refuses, what `apply()`
  changes (`game/test/skirmish.test.ts` shows the shape).

### Don't

- Don't test content only by looking at a screenshot: a blank tile is easy to miss.
- Don't count an end-to-end scene test that happens to send the command as its rule test.

## Consequences

### Positive

- Adding content or a command without its test is reported at once, by file.

### Negative

- A command variant named in any test counts; the check cannot judge how good the test is.

### Risks

- Content loaded by URL at run time, not imported, is found by its shape alone; it still
  needs a test that imports it for the check to pass.

## Compliance and Enforcement

### Automated Enforcement

- `GAME-005/shipped-content-is-checked`: JSON under `game/` shaped like a palette (`tiles`
  with ids) or a map (`layers` with tiles) is reached from a test that calls the matching check.
- `GAME-005/command-variants-are-tested`: each `type: '...'` in the command union appears as
  `type: '...'` in a test file under `game/`.

### Manual Enforcement

Reviewers read the new rule test: it should refuse what the rule refuses, not only accept.

## References

- [AGENTS.md](../../AGENTS.md), "Conventions" (content files) and "Add a player action (commands)"
- [docs/content.md](../../docs/content.md)
