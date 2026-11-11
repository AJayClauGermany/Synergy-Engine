# CLAUDE.md

The project guide is shared with other agents and lives in AGENTS.md:

@AGENTS.md

## Claude Code notes

- Project skills are in `.claude/skills/`. Load the matching one before starting a task
  it covers (for example `gameplay-scripting` before writing behaviours, `verify-changes`
  before reporting a change as done).
- In cloud sessions Playwright and Chromium are preinstalled, so `bun run screenshot`
  works without extra setup. Read the PNG it saves to see the game.
