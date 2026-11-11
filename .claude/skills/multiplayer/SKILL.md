---
name: multiplayer
description: Use when adding or changing player actions (commands), game rules that must stay in sync, online sessions (PeerJS or Convex), lobby features, or Convex backend functions.
---

# Multiplayer

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
  Random outcomes come from a seed stored in the state.
- Pure: no engine, DOM or network access. State is plain JSON-serialisable data.
- Never change synced state anywhere else (not in `update`, not in a click handler).

## Session types

`Session<C>` has `submit`, `onCommand`, `players`, `log`, `onPlayersChanged`,
`onRejected`, `onClosed`. Implementations:

- `CommandSession.local()`: one player, no network.
- `CommandSession.host(transport, { validate })` / `.join(transport, hostId)` over any
  `Transport`: `LoopbackHub` in tests, `PeerJsTransport` online.
- `lobby.openSession(code)` (`ConvexSession`): ordered and stored by Convex.

Game code should depend only on `Session<C>`.

## Testing sync

```ts
const hub = new LoopbackHub({ manual: true });   // nothing is delivered until flush()
const host = CommandSession.host<Command>(hub.connect('host'));
const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
hub.flush();
guest.submit(...); host.submit(...); hub.flush();
// assert both sides computed the same state
```

Loopback serialises messages through JSON, so non-serialisable commands fail in tests.

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
