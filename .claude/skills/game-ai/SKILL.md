---
name: game-ai
description: >
  Builds computer opponents and unit behaviour for strategy games on this engine: an
  opponent that picks among the legal commands by scoring the result, seeded so a game
  can be replayed, and small state machines for units in real-time play. Use when asked
  for an AI player, a bot, an enemy turn, single-player against the computer, difficulty
  levels, or units that patrol, chase or retreat. Not for the pathfinding and range
  helpers themselves (use `tile-maps`), or for how commands and RPCs stay in sync (use
  `multiplayer` or `netcode`).
---

# Game AI

An opponent is a player that happens to be code. It sees what a player sees, and it acts
the only way a player can: by submitting a command, or by calling the same RPC. It never
reaches into the state. That one rule gives the rest for free: the rules still decide
what is legal, multiplayer stays in sync, a replay still works, and a test can play
thousands of games.

## Workflow

1. **Find how a player acts** in this game (AGENTS.md, "Decide how shared state works").
   Commands: `check()` and `apply()` in `game/src/rules/`. Netcode: the `serverRpc`s on
   the units and the pure checks beside them (`game/src/frontier/rules.ts`).
2. **List the legal actions.** Write `legalCommands(state, team)`: build the candidates
   from the helpers the rules already export (`reachable`, `attackable`), then keep those
   `check()` accepts. The opponent chooses from this list and nothing else.
3. **Score a position, not an action.** `score(state, team)` is a number: material
   first, then position. The opponent applies each legal command to get the state after
   it, and takes the best. Rules are pure, so trying a command costs nothing and changes
   nothing.
4. **Break ties with the seeded generator.** `new Random(seed)`; never `Math.random()`.
   The same seed then plays the same game, which is what makes a bug reproducible.
5. **Play it through the session.** The opponent submits one command and waits for it to
   come back before choosing the next, exactly as a human's click does.
6. **Pace it for the viewer.** Pause between the opponent's commands in the view
   (a coroutine), not in the rules.
7. **Verify** by letting it play itself (below).

## Patterns

Everything here is pure and belongs in a file of its own beside the rules, so it runs in
a test with no scene. Written against the
sample's rules (`game/src/rules/skirmish.ts`):

```ts
import { Hex } from '@synergy/engine/grid';
import type { Random } from '@synergy/engine/math';
import { apply, attackable, check, type Command, type GameState, reachable, type Team } from './skirmish';

/** Every command `team` could submit now. */
export function legalCommands(state: GameState, team: Team): Command[] {
  const commands: Command[] = [{ type: 'endTurn' }];
  for (const unit of state.units.filter((candidate) => candidate.team === team)) {
    for (const target of attackable(state, unit)) commands.push({ type: 'attack', unit: unit.id, target: target.id });
    for (const cell of reachable(state, unit)) commands.push({ type: 'move', unit: unit.id, x: cell.x, y: cell.y });
  }
  return commands.filter((command) => check(state, command, team) === null);
}

/** How good the position is for `team`: health first, then closing the distance. */
export function score(state: GameState, team: Team): number {
  let total = state.winner === team ? 1000 : 0;
  for (const unit of state.units) total += unit.team === team ? unit.hp : -unit.hp;
  const enemies = state.units.filter((unit) => unit.team !== team);
  for (const unit of state.units.filter((candidate) => candidate.team === team)) {
    total -= 0.01 * Math.min(99, ...enemies.map((enemy) => Hex.distance(unit, enemy)));
  }
  return total;
}

/** The command the opponent plays: the best result, ties broken by the seeded generator. */
export function chooseCommand(state: GameState, team: Team, random: Random): Command {
  const standingStill = score(state, team);
  let best: Command[] = [];
  let bestScore = standingStill;
  for (const command of legalCommands(state, team)) {
    if (command.type === 'endTurn') continue;
    const value = score(apply(state, command), team);
    if (value > bestScore + 1e-9) {
      best = [command];
      bestScore = value;
    } else if (best.length > 0 && Math.abs(value - bestScore) <= 1e-9) {
      best.push(command);
    }
  }
  // Nothing improves on standing still: end the turn. Without this the opponent shuffles for ever.
  return best.length > 0 ? random.pick(best) : { type: 'endTurn' };
}
```

Driving it from the view, one command at a time. `this.state`, `this.random` and
`this.submit` are the controller's own:

```ts
private *opponentTurn(team: Team): IEnumerator {
  while (this.state.winner === null && this.state.turn === team) {
    yield new WaitForSeconds(0.4);                    // let the player see each step
    const before = this.state;
    this.submit(chooseCommand(before, team, this.random));
    yield new WaitUntil(() => this.state !== before);  // the command came back and was applied
  }
}
```

Where the generator's seed lives decides who may run the opponent. If only one machine
runs it (the host, or a single-player game) the seed is that machine's own. If every
machine must be able to work out the opponent's move, the seed is part of the game state
and `apply` stores `random.state` back after using it.

**Stronger without being slower.** Look two moves ahead only where it matters (after an
attack, score the best reply). Weight the score per difficulty rather than adding random
blunders: an "easy" opponent that values position less plays plausibly worse; one that
moves at random plays nonsense.

**Units in real-time play** (netcode) are small state machines on the host: a `state`
field (`'idle' | 'chase' | 'attack' | 'retreat'`), one function per state, and every
transition through one `changeState()` so entering and leaving code always runs. Sense on
a timer (`this.invokeRepeating(this.sense, 0, 0.25)`), not in `update`. Path with
`findPath` when the goal changes cell, not every frame. The state lives in a
`NetworkVariable` only if clients need to show it.

## Gotchas

- **The opponent cheats or desyncs** because it writes the state, or calls `apply`
  outside the session. Its only output is a command (or an RPC call on the host).
- **It plays a move the rules refuse**, and the turn hangs waiting for a command that
  never comes back. Every candidate goes through `check()`; assert it in the test.
- **It never ends its turn.** A legal move always exists (step back, step forward), so
  "play the best legal move" loops. Compare with the score of doing nothing, and end the
  turn when nothing beats it.
- **A different game each run**, so a reported bug cannot be replayed: `Math.random()`,
  or iteration order doing the tie-break. Use `Random` with a stored seed and choose with
  `random.pick`.
- **It moves the instant the turn changes**, three commands in one frame, and the player
  cannot follow. Pace it in the view with a coroutine.
- **It reads what the player cannot see** (fog, hidden hands). Give it the same view of
  the state a player on its team gets.
- **Flip-flopping between two states** when a distance sits on a threshold: chase at 10,
  give up at 10. Use two thresholds (chase at 10, give up at 14) and a minimum time in a
  state.
- **Pathfinding every frame** for every unit. Path when the target changes cell, and
  spread units over frames.
- **`Hex.distance` as the cost to reach something** ignores terrain and blocked cells.
  It is fine for scoring; for "can I get there this turn" use the range the rules compute.
- **`static instance` on the opponent or its controller** is shared by every simulated
  machine in a test. Keep it per session or per `NetworkManager`.

## Verify

Let it play itself. This runs in milliseconds and catches illegal moves, endless turns
and non-determinism at once:

```ts
function play(seed: number): { state: GameState; log: Command[] } {
  let state = createGame();
  const random = new Random(seed);
  const log: Command[] = [];
  for (let step = 0; step < 2000 && state.winner === null; step++) {
    const command = chooseCommand(state, state.turn, random);
    expect(check(state, command, state.turn)).toBeNull();   // only legal commands
    state = apply(state, command);
    log.push(command);
  }
  return { state, log };
}

test('the opponent finishes a game against itself', () => {
  expect(play(1).state.winner).not.toBeNull();
});

test('the same seed plays the same game', () => {
  expect(play(7).log).toEqual(play(7).log);
});
```

A pass is both tests green and `bun run check` ending in `PASSED`. Then
`bun run screenshot` after a few of its moves to see that the view follows. Whether the
opponent is *fun* to play against is not something a test shows: ask the user to play a
game and report where it felt unfair, passive or predictable.
