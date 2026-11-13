---
name: multiplayer
description: >
  Builds multiplayer the command way on this engine: game state as plain data, player
  actions as commands, check() and apply() rules that every machine runs identically,
  command sessions over PeerJS or Convex, ticks for simultaneous play, and the Convex
  lobby functions. Use when adding or changing a player action or a rule that must stay
  in sync, hosting or joining a session, or when two players see different games. Not for
  replicated objects, NetworkVariables and RPCs (use `netcode`), a computer opponent (use
  `game-ai`), or saving a game (use `save-load`).
---

# Multiplayer

This skill covers **command sessions**: every machine applies the same ordered commands.
For real-time play with replicated objects, variables and RPCs (Unity's Netcode for
GameObjects), use the `netcode` skill and `docs/netcode.md` instead.

Read `docs/multiplayer.md` for the model. The short version: players exchange
**commands**; every machine applies the same commands in the same order with a
deterministic `apply`.

## Adding a player action

1. `game/src/rules/<game>.ts`: add a variant to the `Command` union.
2. `check(state, command, team)`: return a reason string when it is illegal, else `null`.
3. `apply(state, command)`: return the next state. Do not mutate the input.
4. `game/test/`: test the legal case, the illegal cases, and that the input state is unchanged.
5. Submit it from input or HUD code through `GameController.submit(command)`.
6. If it changes what is shown, update the view code in `GameController.refresh()`.

## Rules for `apply`

- Deterministic: no `Math.random()`, `Date.now()`, iteration over `Set`/`Map` insertion
  quirks you do not control, or floating-point paths that differ between machines.
  Random outcomes come from a seed stored in the state:
  `const random = new Random(state.seed); ...; return { ...state, seed: random.state }`.
- `check()` and `apply()` read the state and the command, and nothing else: not
  `session.players`, not a variable at the top of the file, not the clock. Whatever they
  need to know is in the state, put there by an earlier command.
- Import grid maths, pathfinding and `Random` from `@synergy/engine/grid` (pure), never
  from `@synergy/engine` (which brings the renderer).
- Pure: no engine, DOM or network access. State is plain JSON-serialisable data.
- Never change synced state anywhere else (not in `update`, not in a click handler).

## Real-time and simultaneous play

Players acting at once need a shared clock. `startTicker(session, 2000, { type: 'tick' })`
makes the host submit a tick command on an interval; `apply` advances the world on it and
stores cooldowns as "ready at tick N". Never use a local clock for game time. See
"Simultaneous play" in `docs/multiplayer.md`.

## Session types

`Session<C>` has `submit`, `onCommand`, `players`, `log`, `onPlayersChanged`,
`onRejected`, `onClosed`. Implementations:

- `CommandSession.local()`: one player, no network.
- `CommandSession.host(transport, { validate })` / `.join(transport, hostId)` over any
  `Transport`: `LoopbackHub` in tests, `PeerJsTransport` online, `BroadcastChannelTransport`
  between windows of one browser (testing several players on one machine; `?net=local`,
  `bun run screenshot --players 2`, see "Several players on one machine" in docs/multiplayer.md).
- `lobby.openSession(code)` (`ConvexSession`): ordered and stored by Convex.

Game code should depend only on `Session<C>`.

## Convex functions (`convex/`)

- New syntax only: `query({ args, returns, handler })` with validators from `convex/values`.
- Use indexes (`withIndex`), not `.filter()`. Add the index in `schema.ts`.
- `Date.now()` is fine in mutations, not in queries (results are cached).
- Throw `ConvexError` for expected failures; the message reaches the client.
- Never edit `convex/_generated/`. `bun run backend` (`convex dev`) regenerates it and
  pushes functions; it needs an interactive login the first time.
- `packages/net/src/ConvexLobby.ts` refers to functions by name and declares their
  argument/result types by hand. When you change a function's signature, update it there too.
- Type-check with `bun run typecheck`. There are no automated tests against a live
  deployment; state that when reporting.

Convex's own guidelines and skills can be installed with `bunx convex ai-files install`.

## Known limits (do not paper over them)

- Player ids are unauthenticated. No real security until Convex Auth is added.
- The server orders commands but does not validate them against game rules.
- No host migration for peer-to-peer sessions; no hidden information support.

## Gotchas

- **Two players see different games after the same moves.** Something outside the state
  decided an outcome. Lint reports the usual ones in rules files (`Math.random`, `Date`,
  `crypto`, `localeCompare` and the other locale functions, a `let` at the top of the
  file). Not reported: sorting or changing the state itself inside `check()`
  (`state.units.sort(...)` sorts in place, and a guest that only asked "may I?" now has
  another order), and reading `session.players`.
- **`session.submit()` throws "is a Vector3" / "is Infinity" / "is a Map".** A command
  is sent as JSON, and those would arrive as something else on the other machines. Send
  plain data: `{ x, y }`, `null`, an array.
- **It works alone and breaks with a guest.** The host used to apply the very object it
  submitted while guests got a copy; now every machine applies a copy, so this shows up
  alone too. If it still differs, look for state kept in a behaviour instead of the rules.
- **A late joiner sees an older or different game.** They replay the log from the
  start. Anything not derived from the log (who sits where, read from `session.players`
  as the sample's `teamOf` does) is replayed against today's players. With more than two
  participants, record seats in the state through a command.
- **The state changed without a command** (a click handler set `unit.hp`). The next
  command overwrites it on this machine and never reaches the others.
- **A new command type that does nothing.** `check()` and `apply()` switch on the
  type; the type checker reports a `switch` that misses a case, but an `if` chain falls
  through silently. Prefer the `switch`.
- **Applying after `submit()`**: on the host the command has already been applied when
  `submit` returns; on a guest it has not. React in `onCommand`, never right after
  `submit`.
- **A local clock in the rules** for cooldowns or turn timers. Count ticks in the state
  (`startTicker`).

## Verify

```ts
const hub = new LoopbackHub({ manual: true });   // nothing is delivered until flush()
const host = CommandSession.host<Command>(hub.connect('host'));
const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
hub.flush();
guest.submit({ type: 'endTurn' }); host.submit({ type: 'endTurn' }); hub.flush();
// assert both sides computed the same state
```

Loopback serialises messages through JSON, so non-serialisable commands fail in tests.

Assert on **both** sides, not just the host. Loopback serialises messages through JSON
as a real connection does, and `submit` refuses a command JSON would change.

Then the rules themselves: a test for the legal case, each illegal case, and that the
input state is unchanged (`const before = structuredClone(state); apply(state, c);
expect(state).toEqual(before)`). If the game has a computer opponent, letting it play
itself for a few hundred turns exercises every command (`game-ai` skill).

A pass is `bun run check` ending in `PASSED`. PeerJS and Convex need live services and
have no automated tests: say so, and ask the user to try a two-browser game.
