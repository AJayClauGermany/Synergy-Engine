---
id: GEN-002
title: Generated Convex code is regenerated, never edited
domain: general
rules: true
files: ["convex/**", "package.json", "bun.lock"]
---

## Context

`convex/_generated/` holds the typed API that `convex dev` writes from the functions in
`convex/` (AGENTS.md, "Boundaries": do not edit it; `bun run backend` regenerates it). It is
committed so that the type check works without a Convex login. That also makes it look
like ordinary source: an agent fixing a type error can "fix" the generated file, the type
check passes, and the edit is silently undone the next time anyone runs `convex dev`.

Whether a generated file was edited by hand is a fact about the change, not about the file,
which is the kind of rule only a check that sees the change set can hold.

## Decision

A change that touches `convex/_generated/` also touches what it is generated from: a
function file in `convex/`, `package.json` or `bun.lock` (a new `convex` version).

## Do's and Don'ts

### Do

- Change `convex/*.ts` and run `bun run backend`, then commit both.

### Don't

- Don't edit a file under `convex/_generated/` to make the type check pass.

## Consequences

### Positive

- A hand edit to generated code is reported in the same branch that made it.

### Negative

- Only runs when there is a change set: a branch compared with `origin/main`, or
  `archgate check --staged`. A full scan on `main` checks nothing.

### Risks

- A hand edit made in the same change as a real function change is not told apart.

## Compliance and Enforcement

### Automated Enforcement

- `GEN-002/generated-code-changes-with-its-sources`

### Manual Enforcement

None.

## References

- [AGENTS.md](../../AGENTS.md), "Boundaries"
- [docs/multiplayer.md](../../docs/multiplayer.md)
