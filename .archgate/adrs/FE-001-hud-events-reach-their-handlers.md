---
id: FE-001
title: HUD events reach their handlers
domain: frontend
rules: true
files: ["game/src/**/*.tsx"]
---

## Context

The HUD is Preact over the canvas (AGENTS.md, "The HUD is Preact, not React"). Two of its
behaviours differ from what React code and most examples assume, and both compile:

- `onChange` on a text field. React fires it on every key; Preact hands it to the DOM's
  `change` event, which fires when the field loses focus. A field written the React way
  shows what was typed one edit late, or never, until the player clicks away.
- Clicks on the overlay. `mountUI` (`packages/ui/src/mount.tsx`) makes the overlay ignore
  the pointer so that the game underneath stays clickable, and lets controls opt back in:
  `button`, `a`, `input`, `select`, `textarea`, `label`, `summary` and anything with
  `data-interactive`. A `<div onClick>` outside such a panel never sees the click; the
  board under it does.

## Decision

- Text fields (`textarea`, and `input` of a text-like type) read what is typed with
  `onInput`, through `event.currentTarget.value`.
- An HTML element that handles clicks or pointer events is a control, or carries
  `data-interactive` itself.

## Do's and Don'ts

### Do

- `<input onInput={(event) => setCode(event.currentTarget.value)} />`.
- Prefer `<button type="button">` for anything clicked.
- Put `data-interactive` on the element that has the handler, even inside a panel that has
  it too: the element may be moved out of the panel later.

### Don't

- Don't use `onChange` to follow typing. (On a checkbox, a radio button or a `select`,
  `onChange` is right: their change event fires at once.)
- Don't give a `div` or `span` an `onClick` without `data-interactive`.

## Consequences

### Positive

- Two silent HUD bugs, invisible to the type-checker and to headless tests, are reported
  with the element and the line.

### Negative

- Components (`<Panel onClick>`) are not followed; only HTML elements are checked.

### Risks

- A handler on an element inside a `data-interactive` panel works without the attribute,
  and is still reported. Adding the attribute is harmless and makes the intent visible.

## Compliance and Enforcement

### Automated Enforcement

- `FE-001/text-fields-update-on-input`
- `FE-001/pointer-handlers-are-interactive`

### Manual Enforcement

Reviewers open the HUD (`bun run screenshot`) for any change to what can be clicked.

## References

- [AGENTS.md](../../AGENTS.md), "Show something in the HUD" and "The HUD is Preact, not React"
- `.claude/skills/hud-ui/SKILL.md`
