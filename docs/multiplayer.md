# Multiplayer

There are two ways to build online play here, and they can live in one game:

| | Command sessions (this page) | [Netcode for GameObjects](netcode.md) |
|---|---|---|
| Idea | every player applies the same ordered commands | the host owns the world; objects, variables and RPCs |
| Fits | turn-based, asynchronous, lockstep, replays and saves | real-time play, many moving objects, hidden information |
| Each machine | runs the whole simulation | receives the host's state |
| Persistence | Convex can store the command log | the match lives on the host; Convex keeps the lobby |
| Package | `@synergy/net` | `@synergy/netcode` (uses `@synergy/net`'s transports) |

The rest of this page is about command sessions.

`@synergy/net` is built on one idea: **every player applies the same commands in the same
order.** Game code does not change state directly. It submits a command, and changes
state only when a command comes back.

```ts
session.onCommand.add(({ playerId, command }) => {
  if (check(state, command, teamOf(playerId)) === null) state = apply(state, command);
});
session.submit({ type: 'move', unit: 3, x: 4, y: 2 });
```

If `apply` is deterministic, everyone stays in sync, and a late joiner or a reload simply
replays the log. This fits turn-based games directly. For lockstep real-time strategy,
stamp each command with the simulation tick it takes effect on and advance the simulation
in `fixedUpdate`.

Rules for deterministic `apply`: no `Math.random()`, no `Date.now()`, no reading from the
scene; plain data in, plain data out. For randomness, keep a seed in the state:

```ts
const random = new Random(state.seed);
const damage = random.rangeInt(2, 5);
return { ...state, seed: random.state };
```

`Random`, the hex helpers and pathfinding come from `@synergy/engine/grid`, which has no
renderer attached and is safe to import in rules and on a server.

## Simultaneous play: shared world ticks

When players act at the same time (real-time strategy, per-action cooldowns), game time
must be something everyone agrees on. Make it a command:

```ts
const stop = startTicker(session, 2000, { type: 'tick' });   // only the host's machine sends
```

```ts
function apply(state: State, command: Command): State {
  if (command.type === 'tick') return { ...state, tick: state.tick + 1 /* income, regen, ... */ };
  if (command.type === 'fire') {
    return { ...state, units: update(state.units, command.unit, { readyAtTick: state.tick + 3 }) };
  }
  return state;   // ... and the other commands
}

function check(state: State, command: Command, team: Team): string | null {
  if (command.type === 'fire' && unit.readyAtTick > state.tick) return 'Still cooling down.';
  return null;    // ... and the other rules
}
```

Ticks and actions travel in one ordered stream, so every machine sees each action land
between the same two ticks. Measure time in ticks stored in the state, never with a
local clock. Views can still animate smoothly between ticks.

If the host leaves, the clock stops with the session. For a clock that does not depend
on a player's machine, drive ticks from the server (a Convex scheduled function that
appends tick commands); that is not built yet.

## Three ways to run a session

All implement the same `Session<C>` interface, so game code does not care which is in use.

| | `CommandSession.local()` | `CommandSession` over `PeerJsTransport` | `ConvexSession` |
|---|---|---|---|
| Use for | single player, hot-seat, tests | fast online play | persistent or asynchronous play |
| Who orders commands | the local machine | the host player | the database |
| Needs a backend | no | no (PeerJS's public signalling server) | yes (Convex) |
| Survives a reload | no | no | yes |
| Latency | none | low (direct WebRTC) | a server round trip |
| Import from | `@synergy/net` | `@synergy/net/peerjs` | `@synergy/net/convex` |

### Peer-to-peer

```ts
// Host
const transport = await PeerJsTransport.host({ prefix: 'my-game' });
const session = CommandSession.host<Command>(transport, { validate });
showCode(transport.roomCode);

// Guest
const transport = await PeerJsTransport.join(code, { prefix: 'my-game' });
const session = CommandSession.join<Command>(transport, transport.hostId);
```

- The host is the referee: `validate` runs there before a command is accepted.
- It is a star: guests talk only to the host. If the host leaves, the session ends.
- Some networks need a TURN server before WebRTC can connect. Pass your own through
  `peerOptions.config.iceServers`.

### Convex

```ts
const lobby = new ConvexLobby(convexUrl, { playerName: 'Ada' });
const room = await lobby.createRoom({ name: "Ada's game" });   // or lobby.joinRoom(code)
const session = lobby.openSession<Command>(room.code);
lobby.watchOpenRooms((rooms) => showRooms(rooms));              // a live room browser
```

Set-up, once:

```bash
bun run backend
```

That runs `convex dev`: it asks you to log in, creates a deployment, pushes the functions
in `convex/` and keeps them in sync while it runs. It also writes the deployment's address
to `.env.local`, and the game picks it up on the next `bun run dev` with nothing to copy
(see [environment.md](environment.md)).

What is in `convex/`:

- `rooms.ts`: create, join, leave, heartbeat, list open rooms
- `commands.ts`: `submit` assigns sequence numbers inside a transaction; `list` is the
  query every player subscribes to
- `crons.ts`: closes rooms whose players stopped sending heartbeats

You can combine the two: use Convex as the lobby (store the PeerJS code in the room's
`peerCode`) and run the match itself peer-to-peer. [netcode.md](netcode.md) does exactly
that, with a host that plays and objects the host replicates.

## Before you launch publicly

- **Identity.** Player ids are generated by the client and not authenticated. Add Convex
  Auth and take the player from `ctx.auth` in every function.
- **Server-side rules.** `convex/commands.ts` orders commands but does not check them
  against your rules; clients each run `check` and ignore illegal ones. To make the
  server authoritative, import your pure rules module into the mutation and reject there.
- **Hidden information.** A shared command log shows everything to everyone. Games with
  fog of war or hidden hands need per-player views computed on the server.

## Not included

- A dedicated real-time game server for command sessions. If you need one, implement
  `Session<C>` over it (Colyseus or anything else); game code only depends on that
  interface. (Netcode can run a headless server with `startServer`.)
- Server-driven ticks, host migration, reconnection for peer-to-peer sessions.

## Testing

`LoopbackHub` is an in-memory network. With `{ manual: true }` nothing is delivered until
`hub.flush()`, so a test controls the exact interleaving. See
`packages/net/test/session.test.ts` and the sync test in `game/test/skirmish.test.ts`.

The PeerJS and Convex integrations are type-checked but have no automated tests here,
because they need live external services. Try them by hand after changing them.

### Several players on one machine

Unity's Multiplayer Play Mode, in a browser: each window of the game is a player, and a
`BroadcastChannelTransport` connects windows of one browser with no internet and no
signalling server. It has the same shape as `PeerJsTransport` (`host`, `join`,
`roomCode`, `hostId`), so a game switches between the two in one line:

```ts
import { BroadcastChannelTransport } from '@synergy/net';

const room = await BroadcastChannelTransport.host({ prefix: 'my-game' });   // one window
const guest = await BroadcastChannelTransport.join(room.roomCode, { prefix: 'my-game', id: 'player-2' });  // another
```

The sample game wires it up three ways (`game/src/localPlay.ts`):

- **Buttons**, in development builds: "Test in windows" hosts a local room and opens a
  second player's window; "+ Window" opens more. Keep them as separate windows side by
  side: browsers pause the game loop of a hidden tab.
- **Addresses**: `?net=local&host=CODE` in one window, `?net=local&join=CODE&player=2`
  in another. `player=N` gives the window its own id in the session and its own Convex
  player id (`persistentPlayerId(slot)` from `@synergy/net/convex`), because every
  window of a browser shares localStorage.
- **Headless**: `bun run screenshot --scene Frontier --players 2` opens both players in
  one browser, waits until each reports itself connected (`data-net` on the page), and
  saves `game-p1.png`, `game-p2.png` and a log for each. `--on 2` makes the following
  `--click`/`--key`/`--eval` actions player 2's.

Only windows of the same browser profile and site meet; a private window is a different
profile.

