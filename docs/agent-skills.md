# Agent skills

This repository is set up to be worked on by AI coding agents as well as people.

## What is included

| File | Read by | Purpose |
|------|---------|---------|
| `AGENTS.md` | most agents | The project guide: commands, layout, conventions, pitfalls |
| `CLAUDE.md` | Claude Code | Imports `AGENTS.md` |
| `.claude/skills/*/SKILL.md` | Claude Code (others can read them as plain files) | Task-specific playbooks, loaded on demand |

Project skills:

| Skill | Use it when |
|-------|-------------|
| `gameplay-scripting` | writing or changing behaviours, scenes, prefabs, input, coroutines |
| `tile-maps` | building maps and boards: hex or square tiles, layers, cell picking, pathfinding |
| `port-from-unity` | translating Unity C# or a Unity tutorial into this engine |
| `verify-changes` | checking a change: the automatic checks, headless tests, screenshots |
| `multiplayer` | adding commands, command sessions, PeerJS or Convex functions |
| `netcode` | networked objects, `NetworkVariable`s, RPCs, ownership, hosting and joining |
| `ship-it` | deploying a Cloudflare preview or packaging the desktop app |
| `extend-engine` | adding a component or API to `packages/engine` |

## Tools an agent can use to check its own work

- `bun run check` runs every automatic check in a few seconds, without a browser, and
  ends with `PASSED` or `FAILED`: formatting, lint, types, tests, and the project graph.
  Each failure comes with what to do about it. `bun run fix` first applies what a tool
  can fix by itself. [checks.md](checks.md) describes all of it.
- The lint rules include ones written for this engine (`tools/lint/synergy.ts`): they
  report the Unity habits that compile and then misbehave (`==` on vectors,
  `Map<Vector3Int, T>`, `onStart()`, a method passed without its `this`) and say what to
  write instead. Tests that cannot fail (`test.skip`, no `expect`) are reported too.
- The layering between packages, import cycles, and files or exports nothing uses are
  checked across the whole project (`.fallowrc.jsonc`).
- `Engine.createHeadless()` runs real scenes in tests, with simulated input.
- `TestNetwork` (`@synergy/netcode/testing`) runs a host and clients as simulated
  machines in one test, so networked code is checked without a browser or a connection.
- `checkTilePaletteData` / `checkTilemapData` turn a mistake in a content file into a
  sentence; `Catalog.get` names the ids that exist when given one that does not.
- `bun run screenshot` opens the built game in headless Chromium, can click and press
  keys, evaluates expressions against the live engine (`--eval`), saves a PNG, and fails
  if the page logged an error.
- `Debug.hierarchy()` returns the scene as text (objects, components, positions, script
  fields); `bun run screenshot --hierarchy` prints it from the running game.
- A script with a Unity-cased message (`Update`) fails the type-check and throws when it
  is added; near misses (`onStart`) fail the lint check and are warned about once at run time.
- In a running game, `window.synergy` exposes the engine API and the `engine` instance.

## Optional: the vendors' own skills

The makers of the underlying tools publish agent skills too. They are not vendored here;
install the ones you want (they are copied into `.claude/skills/` and recorded in
`skills-lock.json`). Review what a skill says before committing it, as you would any
dependency.

PlayCanvas (engine conventions, lighting, assets, finding official examples):

```bash
bunx skills add playcanvas/skills -s apply-conventions light-scene load-assets find-examples -a claude-code -y --copy
```

Cloudflare (Wrangler and Workers):

```bash
bunx skills add cloudflare/skills -s wrangler workers-best-practices -a claude-code -y --copy
```

Convex (guidelines plus skills, managed by the Convex CLI):

```bash
bunx convex ai-files install
```

Sources: [playcanvas/skills](https://github.com/playcanvas/skills) (MIT),
[cloudflare/skills](https://github.com/cloudflare/skills) (Apache-2.0),
[convex/agent-skills](https://github.com/convex/agent-skills) (Apache-2.0).
Electrobun, Bun and PeerJS do not publish skills; the notes in `AGENTS.md` and `docs/`
cover them.

Two MCP servers are also worth knowing about: Convex (`bunx convex mcp start`) lets an
agent inspect tables, logs and functions of your deployment, and Cloudflare hosts one at
`https://mcp.cloudflare.com/mcp`.
