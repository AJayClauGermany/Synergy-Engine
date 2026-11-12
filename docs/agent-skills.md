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
| `gameplay-scripting` | writing or changing behaviours, scenes, prefabs, input, coroutines; starting a mechanic |
| `tile-maps` | building maps and boards: hex or square tiles, layers, cell picking, pathfinding |
| `game-ai` | a computer opponent, an enemy turn, units that patrol or chase |
| `camera-controls` | the camera: pan, zoom, rotate, edge scroll, drag, limits, focus |
| `hud-ui` | HUD and menus in Preact: Observables, buttons, labels pinned to units |
| `game-feel` | feedback on something that works: pops, shake, hit-stop, eased motion |
| `save-load` | save and load, versions and migrations, autosave, replays |
| `multiplayer` | adding commands, command sessions, PeerJS or Convex functions |
| `netcode` | networked objects, `NetworkVariable`s, RPCs, ownership, hosting and joining |
| `port-from-unity` | translating Unity C# or a Unity tutorial into this engine |
| `debug-a-problem` | something is broken and the cause is not known yet |
| `verify-changes` | checking a change: the automatic checks, headless tests, screenshots |
| `extend-engine` | adding a component, an API or a guard to `packages/engine` |
| `ship-it` | deploying a Cloudflare preview or packaging the desktop app |

## Writing a skill

A skill is read by an agent at the moment it starts a task, in place of working the
approach out. It earns that by being what the agent would get wrong without it. Every
skill here has the same shape, and `bun run check` holds it (`scripts/docs.ts`):

- **A description that says what it does, when to use it, and what it is not for.** The
  description is all an agent sees when it chooses among skills, so it opens with the
  job, then `Use when` with the words a request would really contain (the symptom as
  well as the feature), and ends with `Not for ... (use \`other-skill\`)`, naming the
  neighbour that owns the nearby work. That last clause is what stops two skills from
  both claiming one request. 80 to 1024 characters.
- **A workflow that starts by looking** at what the project already has, and a small
  number of patterns in real code. Every ` ```ts ` block is compiled against the engine by
  the `docs` check, so a sample cannot fall behind the API it shows.
- **`## Gotchas`**, under exactly that heading: what goes wrong, why, and what to do,
  starting from the symptom a person would see. It is the most used part of most skills.
  Grow it from failures that happened, not from ones that might.
- **A last section that checks the work** (`## Verify`, `Check`, `Finish` or `Report`):
  something the agent can run itself, and what a pass looks like. Where only a person can
  judge (does it feel right, does the gamepad work), it says to ask the user and report
  what they said, not to claim it.
- **Under 400 lines.** A skill is read whole each time; detail that is needed for one
  branch of the work goes in a doc under `docs/` that the skill links.
- **Listed** in the table above and in `AGENTS.md`, and any skill it points to exists.

When an agent goes wrong in a way a skill could have prevented, add a line to that
skill's Gotchas. When it goes wrong in a way a program could have caught, prefer that:
a type, an error with the fix in its message, or a lint rule (`extend-engine`, "Make the
wrong thing hard"; [checks.md](checks.md), "Adding a rule"). A guide asks to be read; a
check does not.

The shape follows the authoring standard of
[awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)
(Apache-2.0), which follows the open [Agent Skills](https://agentskills.io/specification)
format. `game-ai`, `game-feel`, `camera-controls`, `save-load` and `hud-ui` cover the same
ground as that catalogue's discipline skills of similar names; they were written for this
engine and its API, with every sample run against it, and share no text with them.

## Tools an agent can use to check its own work

- `bun run check` runs every automatic check in a few seconds, without a browser, and
  ends with `PASSED` or `FAILED`: formatting, lint, types, tests, and the project graph.
  Each failure comes with what to do about it. `bun run fix` first applies what a tool
  can fix by itself. [checks.md](checks.md) describes all of it.
- The lint rules include ones written for this engine (`tools/lint/synergy.ts`): they
  report the Unity habits that compile and then misbehave (`==` on vectors,
  `Map<Vector3Int, T>`, `onStart()`, a method passed without its `this`, a vector result
  thrown away, an RPC written as a method) and say what to write instead. Tests that
  cannot fail (`test.skip`, no `expect`) are reported too.
- The engine stops on the mistakes that need running code to see, with the fix in the
  message: a world position used as a cell, a component looked up before it exists, a
  value in a command or an RPC that JSON would change, a prefab that builds nothing.
  `packages/engine/test/pitfalls.test.ts` and `packages/netcode/test/pitfalls.test.ts`
  list them, one test each.
- The guides are checked against the code (`bun run docs:check`): every TypeScript sample
  in `AGENTS.md`, `docs/` and the skills is compiled, and a member, script or file named
  in a sentence must exist.
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

## Optional: skills from elsewhere

### The game-development catalogue

[awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)
is a catalogue of skills for game work in general: genres (tower defence, card games,
roguelikes, puzzles), disciplines (audio, level design, procedural generation, dialogue)
and workflows (a game jam, a quick prototype). They are written for Godot, Unity, Unreal
and others, not for this engine, so use them for the *design* half of a task (what a wave
curve should look like, how a deck's zones work) and the skills above for the code.
Their samples are in other engines' languages: treat them as descriptions of an idea, not
as code to translate line by line.

If you install one, this is what it needs to know about the project, in the terms that
catalogue uses for an engine it has no skill for:

| | Here |
|---|---|
| Build and run | `bun run dev`; `bun run check` (must end `PASSED`); `bun run screenshot` |
| Lifecycle | `awake`, `onEnable`, `start`, `update`, `lateUpdate`, `fixedUpdate`, `onDisable`, `onDestroy` on a `MonoBehaviour`; scenes and prefabs are functions |
| Time | `Time.deltaTime` (scaled), `Time.unscaledDeltaTime`, `Time.timeScale`; coroutines are generators (`yield new WaitForSeconds(1)`) |
| Input | `Input.getKeyDown(KeyCode.Space)` (an edge, one frame), `Input.getKey` (held), `Input.getAxis('Horizontal')`; screen `y` grows downward |
| State and content | Rules state is plain data changed only by `apply()` (commands), or `NetworkVariable`s on the host (netcode). Content is JSON in a `Catalog` |
| Randomness | `new Random(seed)`, seed kept in the state; never `Math.random()` in rules |
| Not there | Rigidbody physics, triggers, animation, audio, particles, navmesh (`docs/unity-to-synergy.md`, "Not implemented yet") |

### The tool makers' own skills

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
