# Netcode for GameObjects

`@synergy/netcode` is Unity's **Netcode for GameObjects** (NGO) in TypeScript: a
`NetworkManager`, `NetworkObject`s you spawn, `NetworkVariable`s that replicate, RPCs,
ownership, a player prefab. If you have used NGO you already know it; the differences
are listed [below](#differences-from-ngo).

It is built for prototyping. One player **hosts**, and is the server and a client at the
same time; everyone else connects to the host. Convex keeps the lobby; the match itself
never touches it.

```
   Convex (persistent)                      the match (live)
  ┌────────────────────┐                  ┌──────────────────────────────┐
  │ rooms, join codes, │   peerCode       │   host = server + client     │
  │ player names, the  │ ───────────────▶ │   ┌─────────┐                │
  │ open-games list    │                  │   │ player 0│◀── WebRTC ──┐  │
  └────────────────────┘                  │   └─────────┘             │  │
        ▲        ▲                        │      ▲   ▲                │  │
        │        │                        │      │   └── WebRTC ──┐   │  │
   browse/join  create                    │  client 1          client 2 │  │
        └────────┴──── players ───────────┴──────────────────────────────┘
```

A star, not a mesh: clients talk to the host and never to each other, so adding players
adds one connection each. The host owns the truth, which keeps the code simple and means
the host's own machine plays with zero latency. Nothing stops a modified client from
lying to its *own* host, and the host can see everything it sends. For prototypes
that is a good trade; [Trust](#trust) lists what the host does check.

Use this for real-time play and many moving objects. For turn-based or asynchronous games
where every machine can run the same rules, the simpler [command sessions](multiplayer.md)
may fit better; the two coexist.

## Quick start

```ts
import { dontDestroyOnLoad, GameObject } from '@synergy/engine';
import { NetworkManager } from '@synergy/netcode';
import { hostGame, joinGame } from '@synergy/netcode/lobby';

// Once, at boot. Create it before the scripts that use it: its update() reads the network.
const manager = new GameObject('NetworkManager').addComponent(NetworkManager);
dontDestroyOnLoad(manager.gameObject);
manager.networkConfig.playerPrefab = PlayerPrefab;   // every player gets one
manager.networkPrefabs.add(SoldierPrefab);           // everything else you spawn

// One player hosts...
const { code } = await hostGame(manager, { prefix: 'my-game' });
showCode(code);

// ...the others join with the code.
await joinGame(manager, code, { prefix: 'my-game' });
```

`hostGame` and `joinGame` open a PeerJS connection (see [Lobby](#the-lobby-with-convex)).
To use your own transport, call `manager.startHost(transport)` or
`manager.startClient(transport, hostId)`; any `Transport` from `@synergy/net` works.

A networked unit, with a request the host validates:

```ts
type Cell = { x: number; y: number };

export class Soldier extends NetworkBehaviour {
  readonly health = new NetworkVariable(100);
  readonly cell = new NetworkVariable<Cell>({ x: 0, y: 0 });

  // A client asks. This runs on the host, whichever client asked.
  readonly moveRpc = this.serverRpc((x: number, y: number) => {
    const { x: fromX, y: fromY } = this.cell.value;
    if (Math.abs(x - fromX) + Math.abs(y - fromY) > 2) return;   // too far: refuse
    this.cell.value = { x, y };
  });

  onNetworkSpawn() {
    // Runs on every machine, the host included, when the value changes.
    this.cell.onValueChanged.add((_before, now) => this.walkTo(now));
  }
}

export const SoldierPrefab = new NetworkPrefab('Soldier', (go) => {
  go.addComponent(Soldier);   // plus meshes, colliders: whatever the unit looks like
});
```

```ts
// On the host: make one and give it to a player.
instantiate(SoldierPrefab, position).getComponent(NetworkObject)?.spawnWithOwnership(clientId);

// On the owning player's machine: ask.
if (soldier.isOwner) soldier.moveRpc(3, 4);
```

This exact example runs as a test: `packages/netcode/test/example.test.ts`.

## How NGO maps here

| Netcode for GameObjects | Synergy |
|---|---|
| `NetworkManager.Singleton` | `NetworkManager.singleton` |
| `StartHost()` / `StartServer()` / `StartClient()` | `startHost(transport)` / `startServer(transport)` / `startClient(transport, hostId)` |
| `Shutdown()`, `DisconnectClient(id)` | `shutdown()`, `disconnectClient(id, reason)` |
| `IsServer`, `IsClient`, `IsHost`, `LocalClientId`, `ConnectedClientsIds` | same, camelCase |
| `OnClientConnectedCallback += ...` | `onClientConnectedCallback.add(...)`; likewise `onClientDisconnectCallback`, `onServerStarted`, ... |
| `NetworkConfig.PlayerPrefab`, `NetworkPrefabsList` | `networkConfig.playerPrefab`, `networkPrefabs.add(prefab)` |
| Prefab with a `NetworkObject` | `new NetworkPrefab(name, build)` (adds the `NetworkObject` for you) |
| `Spawn()`, `SpawnWithOwnership(id)`, `SpawnAsPlayerObject(id)`, `Despawn(destroy)` | same, camelCase |
| `ChangeOwnership(id)`, `RemoveOwnership()`, `IsOwner`, `IsLocalPlayer`, `OwnerClientId` | same, camelCase |
| `NetworkBehaviour`, `OnNetworkSpawn()`, `OnNetworkDespawn()`, `OnGainedOwnership()` | same, camelCase |
| `NetworkVariable<T>` (`Value`, `OnValueChanged`, read/write permissions) | `NetworkVariable<T>` (`value`, `onValueChanged.add`, `read` / `write` options) |
| `NetworkList<T>` (`Add`, `Remove`, `Count`, `OnListChanged`) | `NetworkList<T>` (`add`, `remove`, `count`, `onListChanged.add`) |
| `[ServerRpc]` | `readonly fooRpc = this.serverRpc((a: number) => ...)` |
| `[ClientRpc]` | `readonly fooRpc = this.clientRpc((a: number) => ...)` |
| `[Rpc(SendTo.Everyone)]` and the other `SendTo` values | `this.rpc(SendTo.Everyone, handler)`; every `SendTo` is supported |
| `ServerRpcParams.Receive.SenderClientId` | `this.rpcSenderClientId`, inside the handler |
| `ClientRpcParams.Send.TargetClientIds` | `fooRpc.sendTo([2, 3], ...args)` |
| `ConnectionApprovalCallback`, `ConnectionData` | `connectionApprovalCallback(request, response)`, `networkConfig.connectionData` |
| `NetworkTransform`, `ClientNetworkTransform` | `NetworkTransform`; `authority = 'owner'` for the client-driven one |
| `NetworkShow` / `NetworkHide` / `CheckObjectVisibility` | same, camelCase |
| `NetworkTickSystem` (`TickRate`, `LocalTime`, `ServerTime`) | `networkConfig.tickRate`, `localTime`, `serverTime`, `onTick` |
| `CustomMessagingManager` named messages | same, camelCase |
| Unity Transport | a `Transport` from `@synergy/net`: `PeerJsTransport` online, `LoopbackHub` in tests |
| Unity Relay + Lobby | PeerJS signalling + the Convex lobby |

## Concepts

### Hosting and joining

`startHost` makes this machine the server and a client (client id 0). Others call
`startClient` and are given ids 1, 2, ... in order of arrival; ids are not reused. A
client is connected when `onClientConnectedCallback` fires on it; until then it has no
objects. `startServer` starts a server that does not play (no client, no player object),
for a headless dedicated server.

Everything that arrives over the network is queued and handled in
`NetworkManager.update()`, and changes are sent from its `lateUpdate()` once per tick.
So the manager should be created first. If a script runs before it in a frame it sees
the previous frame's state, which is harmless but a frame late.

### Spawning

Make the object with `instantiate(prefab)`, then call `spawn()` on the host. Clients create
their own copy from the same prefab, at the same transform, with the same owner and
variable values. A `NetworkPrefab` must be registered on every machine with
`networkManager.networkPrefabs.add(...)`; its name is its identity on the wire, and a
client whose list differs from the host's is refused with a clear message.

Only the host spawns, despawns and destroys. Destroying the host's copy of a spawned
object despawns it everywhere. If a client needs something spawned, it asks with a
`serverRpc` and the host decides.

`NetworkBehaviour`s on the prefab root and on its children belong to the object. A
`NetworkObject` nested inside another is refused when you spawn (NGO does not allow it
either): make them separate prefabs and parent them in your own code.

### Variables

```ts
readonly health = new NetworkVariable(100);
readonly squad = new NetworkList<number>();
readonly note = new NetworkVariable('', { write: NetworkVariableWritePermission.Owner });
readonly orders = new NetworkVariable(0, { read: NetworkVariableReadPermission.Owner });
readonly aim = new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 });
```

- Declare them as **fields**. The engine finds them on the instance when the object
  spawns, and the field name identifies the variable on the wire.
- By default the server writes and everyone reads. `write: Owner` lets the owner write;
  the host relays it to the others. `read: Owner` keeps it from everyone but the owner
  and the host. Writing without permission throws.
- Changes are collected and sent once per tick, as the last value. `onValueChanged` runs
  on every machine that sees the change, including the writer. It does not run for the
  value a late joiner receives: read `value` in `onNetworkSpawn`.
- Assigning an equal value sends nothing. To change an object or array, replace it
  (`this.cell.value = { ...this.cell.value, x: 3 }`); if you mutate it in place, call
  `setDirty()`.
- Values travel as JSON. Numbers, strings, booleans, arrays and plain objects work. For
  `Vector3`, `Vector2`, `Quaternion` and `Color` pass a serializer from `Serializers`;
  write your own `{ write, read }` for other classes.
- `NetworkList` sends only the operations (add, insert, remove, set, clear).

### RPCs

An RPC is a function you call on one machine that runs on others. Declare it as a
field and call it like a method. Arguments must be plain JSON data; the handler runs
on the receiving machines, not on the caller (unless the caller is in the audience).

| Declaration | Runs on | Who may call |
|---|---|---|
| `this.serverRpc(handler)` | the host | the owner (`{ requireOwnership: false }` allows any client) |
| `this.clientRpc(handler)` | every client and the host | the host only |
| `this.rpc(SendTo.X, handler)` | the audience `X` names | anyone |

`SendTo` values: `Server`, `NotServer`, `Owner`, `NotOwner`, `Me`, `NotMe`, `Everyone`,
`ClientsAndHost`, `SpecifiedInParams`. The caller runs the RPC immediately when it is in
the audience; there is no round trip for its own copy. `SpecifiedInParams` and `clientRpc`
accept a list at the call: `this.alertRpc.sendTo([2, 3], 'incoming')`.

Inside a handler, `this.rpcSenderClientId` is the client that called. **A `serverRpc`
handler must check its arguments**, as `moveRpc` does above: a modified client can call
it with anything.

RPCs have no return value. Calling an RPC on an object that is not spawned throws.

### Ownership

Every object has an owner: the server (0) or a client. `spawnWithOwnership(id)` sets it
at spawn; `changeOwnership(id)` and `removeOwnership()` (host only) change it. A client's
player object is owned by that client and is destroyed when it leaves; other objects it
owned are destroyed too, unless `dontDestroyWithOwner` is set, in which case the host takes
them over. `onGainedOwnership` and `onLostOwnership` run on the machine concerned;
`networkObject.onOwnershipChanged` runs everywhere.

### Connection approval

```ts
manager.networkConfig.connectionApproval = true;
manager.networkConfig.connectionData = { name: 'Ada', password: 'swordfish' };   // on the client

manager.connectionApprovalCallback = (request, response) => {                     // on the host
  const { password } = request.payload as { password: string };
  response.approved = password === 'swordfish';
  response.reason = 'Wrong password.';                  // shown to the client if refused
  response.position = new Vector3(request.clientNetworkId * 4, 0, 0);   // where the player appears
};
```

The callback may return a Promise. Set `response.createPlayerObject = false` to spawn the
player yourself in `onClientConnectedCallback`. Refused clients find the reason in
`manager.disconnectReason`.

### Hiding things (fog of war, hidden hands)

`networkObject.checkObjectVisibility = (clientId) => canSee(clientId, this)` keeps an object
from some clients. It is checked at spawn and when a client joins; after the answer changes
call `networkObject.updateVisibility()`, or use `networkShow(id)` / `networkHide(id)` directly.
A client that cannot see an object has no copy of it, receives none of its changes or
RPCs, and cannot call its RPCs. `read: Owner` variables hide a field from other players on
an object they can see. This is the part of NGO that the [command log](multiplayer.md)
cannot do.

### Moving things

Add `NetworkTransform` to the prefab. The host moves the object and everyone follows;
set `authority = 'owner'` to let the owning player move it instead (Unity's
`ClientNetworkTransform`). The side with authority moves the object however it likes;
once per tick, if it moved past the thresholds, the new transform is sent. Everyone else
shows it two ticks in the past and blends between updates. `teleport(position)` skips the
blend. Set these fields in the prefab's build function, so every machine agrees.

### Ticks

The network runs at `networkConfig.tickRate` (default 30) updates a second, on real time:
pausing with `Time.timeScale = 0` does not stop it. The host's rate wins. `manager.onTick`
fires once per tick just before changes are sent, `localTime` is this machine's tick and
`serverTime` the host's (exact on the host, an estimate within a tick or two on clients).

### Custom messages

```ts
manager.customMessagingManager.registerNamedMessageHandler('chat', (sender, text) => show(sender, text));
manager.customMessagingManager.sendNamedMessage('chat', 'hello');           // client to host
manager.customMessagingManager.sendNamedMessageToAll('chat', 'welcome');   // host to everyone
```

## The lobby with Convex

Convex keeps what should outlive a connection: which games exist, their join codes, who is
in the waiting room. `@synergy/netcode/lobby` joins that to the match:

```ts
import { ConvexLobby } from '@synergy/net/convex';

const lobby = new ConvexLobby(convexUrl, { playerName: 'Ada' });

// Host: opens a PeerJS room, starts hosting, and lists the game in the lobby.
const game = await hostGame(manager, { prefix: 'my-game', lobby: { client: lobby, name: "Ada's game" } });
showCode(game.code);                       // the lobby code
await game.setStatus('playing');           // hide it from the open-games list once it starts

// Guest: look the game up by lobby code, read the host's PeerJS code from it, connect.
await joinGame(manager, code, { prefix: 'my-game', lobby });

// A live list of open games for a browser screen:
lobby.watchOpenRooms((rooms) => showRooms(rooms));
```

Without `lobby` the PeerJS code is the join code and Convex is not involved at all, which
also means the game works with no backend. The lobby entry is removed when the host shuts
down. PeerJS's free server only introduces the two machines; the game data flows directly
between them. Some networks need a TURN server before WebRTC can connect: pass
`peerOptions: { config: { iceServers: [...] } }`.

Set up Convex once with `bun run backend`; see [environment.md](environment.md).

## Differences from NGO

- **Variables and RPCs are fields.** Unity finds them with attributes and code
  generation. Here you declare each as a class field (`readonly hp = new NetworkVariable(100)`,
  `readonly hitRpc = this.serverRpc(...)`), and the field name is its identity.
- **JSON on the wire**, not a binary format. Arguments and values must be plain data,
  or use a serializer. It is easy to read in the browser's dev tools, and heavier than NGO.
- **Prefabs are named.** A `NetworkPrefab`'s name replaces NGO's global object id hash.
- **`onValueChanged` is not called for a late joiner's initial values.** Read the value in
  `onNetworkSpawn`.
- **Create the `NetworkManager` first**, because the engine has no script execution order
  setting (see [Hosting and joining](#hosting-and-joining)).
- **`serverRpc` requires ownership by default** (NGO 1.x), `rpc(SendTo.Server, ...)` does not (NGO 2.x).
- **Several engines in one process** is supported for tests: see `Engine.run`.

## Trust

The host is the authority. For each message the host checks that:

- the sender is an admitted client, and cannot see or call objects hidden from it;
- a variable is written only by a client with write permission, and only by the owner for
  `write: Owner`;
- a `serverRpc` is called by the owner when it requires it, and a `clientRpc` is called
  by nobody but the host. The audience of an RPC comes from the host's own declaration,
  never from the message;
- the client's prefab list matches the host's when it connects, so every spawn it is sent is one it can build.

It does not check **what a client asks for**. That is the game's job, in the handler.
There is no authentication: client ids are handed out per connection and a player who
reconnects is a new client. A host can read everything it is sent and can cheat freely.
Make the match private (share the code with people you trust) until you add more. That is
the accepted limit for prototyping.

## Testing

Test netcode without a browser. Each simulated machine gets its own `Engine` and its own
`NetworkManager`, joined by an in-memory network that delivers only when you say so:

```ts
const hub = new LoopbackHub({ manual: true });
const host = engineWithManager(hub, 'host');       // Engine.createHeadless() + a NetworkManager
const guest = engineWithManager(hub, 'guest');
host.run(() => host.manager.startHost(host.transport));
guest.run(() => guest.manager.startClient(guest.transport, 'host'));
for (let i = 0; i < 6; i++) { hub.flush(); host.engine.step(1 / 30); guest.engine.step(1 / 30); }
```

`packages/netcode/test/harness.ts` has a ready-made `TestNetwork` (`host()`, `client(id)`,
`pump()`), and the tests next to it show how to check spawning, variables, RPCs, ownership,
visibility and transforms. `engine.run(() => ...)` makes an engine the current one while you
create objects in it. The loopback copies messages through JSON, so a value that would not
survive the real network fails in the test.

## Not built yet

Scene-placed network objects and synchronized scene loading (`NetworkSceneManager`),
reparenting network objects, prefab pooling handlers, `NetworkAnimator` and
`NetworkRigidbody` (the engine has no animation or rigidbodies yet), client-side prediction
and reconciliation, host migration, reconnecting to a running match, and distributed
authority. The PeerJS and Convex helpers are type-checked but, like the rest of
`@synergy/net`, not tested against the live services: try them by hand after changing them.
