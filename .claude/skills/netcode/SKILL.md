---
name: netcode
description: >
  Builds real-time multiplayer the Netcode-for-GameObjects way on this engine:
  NetworkManager, NetworkPrefab, NetworkBehaviour, NetworkVariable, RPCs, ownership,
  hidden information, networked scene loads, hosting and joining. Use when something must
  exist on every player's machine and move or change in real time, when porting Unity NGO
  code, or when a value, an RPC or an object reaches the host and not the clients. Not
  for turn-based games every machine can replay from commands (use `multiplayer`), or for
  deploying a build (use `ship-it`).
---

# Netcode (Netcode for GameObjects)

<!-- check: manager: NetworkManager -->

Read `docs/netcode.md` first; it has the Unity-to-Synergy map. One player hosts and is
the server and a client at once; clients connect only to the host. Convex is the lobby;
the match never goes through it.

Use this for real-time play and many moving objects. For turn-based or asynchronous games
that every machine can simulate identically, command sessions (`multiplayer` skill) fit.

**Start from the sample.** `game/src/frontier/` is a complete, tested match built this
way: `Match.ts` (the match's own state), `Soldier.ts` (a unit: variables, orders as RPCs,
the host's checks), `session.ts` (starting a match, hosting, joining),
`FrontierPlayer.ts` (local input), `game/test/frontier.test.ts` (tests). Copy its shape
and replace its contents.

## Making something networked

1. Make the prefab with `new NetworkPrefab('Name', (go) => { ... })` (it adds the
   `NetworkObject`). Names are unique and identical on every machine.
2. Register it on **every** machine: `manager.networkPrefabs.add(Prefab)`. A client whose
   list differs from the host's is refused.
3. Put the behaviour on it, extending `NetworkBehaviour`. Declare replicated members as
   **class fields**, because the field name is the identity on the wire:
   ```ts
   readonly health = new NetworkVariable(100);
   readonly squad = new NetworkList<number>();
   readonly attackRpc = this.serverRpc((targetId: number) => { /* host: validate, then act */ });
   readonly flashRpc = this.clientRpc((text: string) => this.flash(text));
   readonly pingRpc = this.rpc(SendTo.Everyone, (text: string) => this.flash(text));
   ```
4. On the host: `instantiate(Prefab, position).getComponent(NetworkObject)?.spawn()`
   (or `spawnWithOwnership(clientId)`). Clients receive a copy automatically.
5. Change state on the host only. Clients call a `serverRpc`; the host checks the request
   and sets `NetworkVariable`s; everyone's `onValueChanged` reacts and updates the view.

## Rules that prevent bugs

- Start work in `onNetworkSpawn`, not `awake`: `isServer`, `isOwner`, `ownerClientId` and
  the variables' initial values are valid only from there.
- Only the host spawns, despawns, destroys and changes ownership. A client that needs one
  of those asks with a `serverRpc`.
- A `serverRpc` handler **must validate its arguments**: ownership is checked for you,
  values are not. `this.rpcSenderClientId` says who asked.
- A variable is written by the server unless `write: NetworkVariableWritePermission.Owner`;
  writing without permission throws. Replace objects and arrays instead of mutating them
  (`value` is read-only, so `cell.value.x = 3` and `items.value.push(x)` do not compile).
- Everything on the wire is JSON. RPC arguments are plain data; use `Serializers.vector3`
  (etc.) for `Vector3`, `Quaternion`, `Vector2`, `Color` variables. A value JSON would
  change (a class instance, a `Map`, `Infinity`, `NaN`) is refused on the machine that
  sends it, with a message naming it.
- Keep the manager across scenes: `dontDestroyOnLoad(manager.gameObject)` right after
  creating it. One that was destroyed with its scene refuses to start.
- `onValueChanged` does not fire for a late joiner's initial values; read `.value` in
  `onNetworkSpawn`.
- Create the `NetworkManager` before scripts that use it (its `update` reads the network).
- Nested `NetworkObject`s inside a prefab are refused. Variables and RPCs must be fields,
  not entries in a Map or array.
- Hidden information: `checkObjectVisibility` / `networkShow` / `networkHide` and
  `read: Owner` variables. A hidden object does not exist on that client at all.
- Moving things: add `NetworkTransform` (`authority = 'owner'` for client-driven).
- Online: `hostGame` / `joinGame` from `@synergy/netcode/lobby`, with an optional Convex
  `lobby`. Without one, the PeerJS code is the join code.
- Units a player commands do not have to be owned by that player. Keep them owned by the
  server, store the team in a variable, and declare the order RPCs with
  `{ requireOwnership: false }`; the handler checks that the caller's team matches.
- Refer to another networked object by its `networkObjectId` in RPC arguments, and look
  it up in `networkManager.spawnManager.spawnedObjects` on arrival: it may be gone.
- No `static instance` on a NetworkBehaviour: tests run several machines in one process
  and a static is shared by all of them. Keep a `WeakMap` keyed by the NetworkManager
  (`Match.of(manager)` in the sample).
- Set `networkConfig.protocolVersion` (the sample uses `buildId` from `game/src/env.ts`)
  so two different builds refuse to connect instead of misreading each other.

## Starting a match: scenes and readiness

Everyone must be in the same scene, with its map loaded, before anyone acts.

1. Register the match scene on every machine (`SceneManager.register`).
2. Host: `manager.sceneManager.loadScene('Match')`. Clients load it before handling
   anything else the host sends; late joiners are sent the scene first.
3. Host, in `sceneManager.onLoadComplete` for client 0: spawn the match's objects, with
   `spawn(true)` so they are removed when another scene loads.
4. Host, in `sceneManager.onLoadEventCompleted`: every machine has reported in. Flip a
   `phase` variable to `'playing'`; RPC handlers refuse orders until then.

Spawn from the events rather than after `await loadScene(...)`: in a test with several
machines, the code after an `await` can run with another machine's engine current.
`loadScene` throws while an earlier load is still being answered, so guard a "play
again" button (`rematch` in the sample's `session.ts`).

Three things the sample gets right that are easy to get wrong:

- **What a newcomer is sent.** The host builds a joining client's first picture of the
  world before `onClientConnectedCallback` runs. A `checkObjectVisibility` that treats
  "nothing known about this client yet" as "may see everything" leaks hidden objects to
  everyone who joins. Default to hidden; show after you have decided who they are.
- **Who may call an RPC.** `this.rpc(SendTo.X, ...)` can be called by any client and is
  relayed. For something only the host should say, use `clientRpc`, and still check the
  arguments' types in the handler.
- **Listeners you add for one start.** Remove them when that start ends, including when
  it ends early (the network was shut down mid-load), or the next start runs them too.

## Known limits (say so, do not paper over them)

The host is trusted and there is no authentication. No scene-placed network objects or
additive networked scenes, no reparenting, no prediction or reconciliation, no host
migration or reconnect. The network clock pauses through a stall instead of catching up. The PeerJS and Convex helpers are untested against live services.

## Gotchas

- **An RPC that only runs where it is called.** `fireServerRpc() { ... }` written as a
  method (NGO's attribute style) is an ordinary method. An RPC is a field:
  `readonly fireRpc = this.serverRpc(...)`. Lint reports the method.
- **A variable that never leaves the machine.** Declared as a `#private` field, inside
  an array or object (`readonly resources = [new NetworkVariable(0), ...]`), in
  `onNetworkSpawn`, or on a class that extends `MonoBehaviour`. Only direct fields of a
  `NetworkBehaviour`, created with the object, are bound. Lint reports the first three
  shapes; hold a collection in one `NetworkVariable` or a `NetworkList`.
- **`instantiate(prefab).getComponent(NetworkObject)?.spawn()` does nothing.** The
  prefab was made with `new Prefab`, not `new NetworkPrefab`, so there is no
  NetworkObject and `?.` hides it. The object exists on the host only.
- **Instantiated and never spawned.** `isServer` and `isOwner` are false, variables are
  freely writable, and no other machine has the object. Spawning is always explicit, also
  for objects a scene builder creates.
- **It moves for its owner and nobody else.** `NetworkTransform` is server-authoritative
  by default and does not snap back, so the owner sees nothing wrong. Set
  `authority = 'owner'` **in the prefab** (not on the host's instance), or move it on
  the host.
- **Objects spawned right after `loadScene` are gone.** From inside a frame the load has
  not happened yet. Spawn in `sceneManager.onLoadComplete` for client 0.
- **The host changed scene and the clients did not.** `SceneManager.loadScene` is this
  machine only; use `manager.sceneManager.loadScene`.
- **`this.rpcSenderClientId` is -1.** It is valid while the handler runs, not after a
  `yield` or an `await` inside it. Read it into a `const` first.
- **`isServer` is false in `awake`.** Roles and variable values are valid from
  `onNetworkSpawn`.
- **A listener per respawn.** `manager.onTick.add(...)` in `onNetworkSpawn`, never
  removed, runs once more for each time the object was spawned. Keep what `add` returned
  and call it in `onNetworkDespawn`.
- **A module-level `Map` or `static instance`** is one object for every simulated
  machine in a test, so a client-side read passes there and is empty on a real client.
  Key shared lookups by the manager (`Match.of(manager)` in the sample).
- **NGO's other callbacks** (`onOwnershipChanged`, `onNetworkPostSpawn`) are never
  called: `onGainedOwnership` / `onLostOwnership` and `onNetworkSpawn`. Lint reports them.
- **Order on the wire.** A value written and an RPC called in the same frame arrive in
  that order, and the last value written before `despawn()` arrives before the despawn.
  Do not add delays to "let the variable sync first".

## Verify

Always test with simulated machines; the real transports need live services. Use
`TestNetwork` from `@synergy/netcode/testing` (`host()`, `client(id)`, `pump()`,
`settle()`; each machine has its own `Engine` and `NetworkManager`): pass it a function
that registers your prefabs on every machine. Create objects inside `machine.run(...)`
or `machine.make(prefab)`, because each engine must be current while you use it.
`game/test/frontier.test.ts` is the pattern for a game; `packages/netcode/test` for the
package itself.

Write the test for: the value or call reaching the right machines, the wrong machine
being refused, and a late joiner seeing the current state. **Assert on a client's copy,
not the host's**: the host holds the originals, so a test that only looks there passes
with values that never arrived.

A pass is `bun run check` ending in `PASSED`. PeerJS, Convex and the lobby helpers have
no automated tests: say so, and ask the user to host in one browser and join from another.
