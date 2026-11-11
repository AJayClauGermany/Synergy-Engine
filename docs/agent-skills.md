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
| `port-from-unity` | translating Unity C# or a Unity tutorial into this engine |
| `verify-changes` | checking a change: type-check, headless tests, screenshots |
| `multiplayer` | adding commands, sessions, online play or Convex functions |
| `ship-it` | deploying a Cloudflare preview or packaging the desktop app |
| `extend-engine` | adding a component or API to `packages/engine` |

## Tools an agent can use to check its own work

- `bun run check` type-checks everything and runs every test without a browser.
- `Engine.createHeadless()` runs real scenes in tests, with simulated input.
- `bun run screenshot` opens the built game in headless Chromium, can click and press
  keys, evaluates expressions against the live engine (`--eval`), saves a PNG, and fails
  if the page logged an error.
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
