---
id: GAME-004
title: Commands, RPC arguments and network variables carry plain data
domain: game
rules: true
files: ["game/src/**/*.ts", "game/src/**/*.tsx"]
---

## Context

Both multiplayer models send values to other machines as JSON (`docs/multiplayer.md`,
`docs/netcode.md`). JSON keeps numbers, strings, booleans, null, arrays and plain objects.
Everything else changes on the way: a `Vector3` arrives as `{ x, y, z }` without its
methods, a `Map` or `Set` arrives empty, `Infinity` and `NaN` arrive as `null`. The player
who sent it would not notice; everyone else would play a different game.

The engine refuses such values where they are sent: `session.submit()` for a command, the
RPC call, the `NetworkVariable` assignment. That guard runs only when the code runs. The
types that decide it are written down long before: the command union, the RPC handler's
parameters, the variable's initial value or type argument.

## Decision

- The command type a session carries (`CommandSession.local<Command>()`,
  `Session<Command>`, `openSession<Command>(...)`) and every game type it names are plain
  data: numbers, strings, booleans, null, arrays, plain objects, and unions of those.
- `serverRpc` and `clientRpc` handlers take plain data.
- A `NetworkVariable` or `NetworkList` either holds plain data or is given a serializer
  (`Serializers.vector3` and the others in `@synergy/netcode`).

## Do's and Don'ts

### Do

- Send a cell as `{ x: number; y: number }`, another object by its id, a set as an array.
- `new NetworkVariable({ x: 0, y: 0 })`, or `new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 })`.

### Don't

- Don't put a `Vector3`, `Map`, `Set`, `Date`, `GameObject` or a function in a command type.
- Don't type an RPC parameter as a `Vector3`; take `(x: number, y: number, z: number)`.
- Don't start a variable at `Infinity`: JSON turns it into `null`. Use a large number or `-1`.

## Consequences

### Positive

- A command or RPC that would desynchronise players is reported where its type is
  declared, with the path to the offending part (`Command > Order > Vector3`).

### Negative

- Only the game's own types are followed. A type imported from a package is taken as
  plain unless its name is one of the known class types.

### Risks

- A plain interface that happens to be named like an engine class (`Color`) is reported.
  Rename it; the name would mislead a reader too.

## Compliance and Enforcement

### Automated Enforcement

- `GAME-004/commands-are-plain-data`
- `GAME-004/rpc-arguments-are-plain-data`
- `GAME-004/network-variables-are-plain-or-serialized`

### Manual Enforcement

Reviewers check that state changes only in `apply()` (commands) or on the host
(netcode); the type of a value is checked here, where it changes is not.

## References

- [docs/multiplayer.md](../../docs/multiplayer.md)
- [docs/netcode.md](../../docs/netcode.md)
- `packages/netcode/test/pitfalls.test.ts`
