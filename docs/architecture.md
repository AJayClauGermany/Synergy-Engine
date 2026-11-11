# Architecture

## Layers

```
game/                 your game: scenes, behaviours, rules, HUD        (depends on everything below)
packages/ui           React HUD helpers                                 (engine + react)
packages/netcode      Netcode for GameObjects: objects, variables, RPCs (engine + net)
packages/net          command sessions, transports, Convex lobby        (no engine dependency)
packages/engine       Unity-style runtime                               (playcanvas only)
PlayCanvas            rendering, scene graph, asset loading
```

Packages are consumed as TypeScript source through Bun workspaces; there is no build step
between them. Three parts of the engine import nothing outside themselves and are exposed
as their own entry points, so game rules and server code can use them without pulling
in a renderer: `@synergy/engine/math` (vectors, colours, `Random`),
`@synergy/engine/grid` (cell layouts, hex maths, pathfinding) and
`@synergy/engine/data` (`Catalog`, and the shapes of tile and map files).

## How the engine sits on PlayCanvas

| Synergy | PlayCanvas |
|---------|------------|
| `Engine` | `pc.AppBase` created with only the render, camera, light, screen and element systems |
| `GameObject` | wraps one `pc.Entity` (`gameObject.entity`) |
| `Transform` | reads and writes that entity's graph node |
| `Scene` | a root entity under `app.root`; `new GameObject()` is parented to the active scene's root |
| `Camera`, `Light` | wrap the entity's `camera` / `light` component |
| `MeshFilter` + `MeshRenderer` | share the entity's `render` component |
| `Material` | wraps a `pc.StandardMaterial` |
| `SpriteRenderer` | a `render` component with one quad and its own unlit `pc.StandardMaterial` |
| `Canvas`, `RectTransform`, `Image` | wrap the entity's `screen` / `element` components (PlayCanvas UI, drawn on the UI layer) |
| `Grid`, `Tilemap` | Synergy data structures over `grid/`; `TilemapRenderer` keeps one `pc.Mesh` per 16 x 16 block of cells and texture, added to the world layer directly |
| `MonoBehaviour`, coroutines, `Time`, `Input`, `Physics` | implemented by Synergy, not PlayCanvas scripts |

Wrapping is lazy in the other direction too: any `pc.Entity` (for example the nodes of a
loaded glTF model) becomes a `GameObject` the first time it is reached, and gets
`MeshFilter`/`MeshRenderer`/`Camera`/`Light` components for whatever it already carries.

## The frame

PlayCanvas owns `requestAnimationFrame`. Synergy hooks three points of its update:

1. component systems `update` → `Time` advances, input edges latch, pending `start`s,
   the fixed-step loop (`fixedUpdate`, `WaitForFixedUpdate`), `onMouse*` messages,
   `update`, coroutines
2. component systems `postUpdate` → `lateUpdate`
3. application `update` → `WaitForEndOfFrame`, the destroy queue, queued scene loads,
   input edges cleared

then PlayCanvas renders. `packages/engine/src/core/Engine.ts` is the whole loop.

## Lifecycle rules worth knowing

- `addComponent` on an active object runs `awake` then `onEnable` immediately; `start`
  runs before the first update that follows.
- While a scene builder, a `Prefab` build or an `instantiate` clone is running, those
  callbacks are **deferred** until it finishes, then run in creation order. A script's
  `awake` therefore sees the complete hierarchy and the values assigned during the build.
  For scenes the deferral applies only to objects in the scene being built: the rest of
  the game keeps running normally while an asynchronous load is in progress.
- Scene loads run one at a time, never in the middle of a frame or of another load.
  Calling `loadScene` from `awake`, `onDestroy` or twice in a row simply queues it.
- `destroy` is deferred to the end of the frame. `onDisable` runs before `onDestroy`.
- Coroutines stop when their GameObject is deactivated or destroyed (not when the
  behaviour is merely disabled), as in Unity.
- In a browser an exception in a script is logged and the game keeps running. A headless
  engine rethrows it, so tests fail loudly.

## Headless mode

`Engine.createHeadless()` builds the same app on PlayCanvas's null graphics device with a
stub canvas: no DOM, no GPU, no frame loop. You advance it with `engine.step(dt)` and feed
input through `engine.input` (`pressKey`, `moveMouse`, `pressMouseButton`, ...). Camera
projection, raycasts and grid picking work (they are computed from transforms, not from
rendered frames), so a test can click on things. See `game/test/scene.test.ts`.

## The sample game's shape

```
input ──submit(command)──▶ session ──onCommand──▶ rules.apply ──▶ views + HUD observables
                             ▲
              local │ PeerJS (WebRTC) │ Convex
```

- `game/src/rules/` is pure data and functions: no scene, DOM or network (it uses only
  `@synergy/engine/grid` for hex maths and pathfinding).
- The map is a hexagonal `Grid` with two `Tilemap` layers (terrain and highlights).
- `GameController` is the only place state changes, and only in response to a command
  coming back from the session.
- Views (`BoardView`, `UnitView`) render state and know nothing about rules.
- The HUD reads `Observable`s from `game/src/hud.ts`.

Keeping that separation is what makes the game testable headlessly and playable online
without special cases.

## The netcode sample's shape

`game/src/frontier/` is the other way to build a multiplayer game, for real-time play:

```
click ──soldier.moveRpc(x, y)──▶ host: check against rules.ts ──▶ NetworkVariables change
                                                                        │
              every machine that may see the unit ◀── replicated ───────┘
              onValueChanged ──▶ views + HUD observables
```

- `rules.ts` is content (map, tiles, unit types from data) and pure functions over it.
- State lives in `NetworkVariable`s on `Match` and `Soldier`. Only the host writes them,
  in RPC handlers that check each order and can refuse it.
- The host decides which clients receive which units (fog of war), with the same rule
  the fog layer is drawn from.
- `session.ts` starts a match: load the scene on every machine, spawn into it, begin
  when all have reported in. Playing alone is hosting with no clients.
- `FrontierPlayer` is this machine's selection and clicks; `FrontierBoard` draws the map
  from the data files. Neither holds game state.
