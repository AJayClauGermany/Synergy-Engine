---
name: netcode
description: Use when making things multiplayer the Netcode-for-GameObjects way - NetworkManager, NetworkPrefab, NetworkBehaviour, NetworkVariable, RPCs, ownership, hosting and joining, the Convex lobby, or porting Unity NGO code - in packages/netcode or game code that uses @synergy/netcode.
---

# Netcode (Netcode for GameObjects)

Read `docs/netcode.md` first; it has the Unity-to-Synergy map. One player hosts and is
the server and a client at once; clients connect only to the host. Convex is the lobby;
the match never goes through it.

Use this for real-time play and many moving objects. For turn-based or asynchronous games
that every machine can simulate identically, command sessions (`multiplayer` skill) fit.

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
   readonly pingRpc = this.rpc(SendTo.Everyone, (text: string) => ...);
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
  writing without permission throws. Replace objects and arrays instead of mutating them,
  or call `setDirty()`.
- Everything on the wire is JSON. RPC arguments are plain data; use `Serializers.vector3`
  (etc.) for `Vector3`, `Quaternion`, `Vector2`, `Color` variables.
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

## Testing

Always test with simulated machines; the real transports need live services. Use
`packages/netcode/test/harness.ts` (`TestNetwork`: `host()`, `client(id)`, `pump()`; each
machine has its own `Engine` and `NetworkManager`). Create objects inside `machine.run(...)`
or `machine.make(prefab)`, because each engine must be current while you use it. Write
the test for: the value or call reaching the right machines, the wrong machine being
refused, and a late joiner seeing the current state. The loopback round-trips JSON, so
non-serialisable values fail in tests.

## Known limits (say so, do not paper over them)

The host is trusted and there is no authentication. No scene synchronization or
scene-placed network objects, no reparenting, no prediction or reconciliation, no host
migration or reconnect. The PeerJS and Convex helpers are untested against live services.
