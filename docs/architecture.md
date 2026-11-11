# Architecture

## Layers

```
game/                 your game: scenes, behaviours, rules, HUD        (depends on everything below)
packages/ui           React HUD helpers                                 (engine + react)
packages/net          command sessions, transports, Convex lobby        (no engine dependency)
packages/engine       Unity-style runtime                               (playcanvas only)
PlayCanvas            rendering, scene graph, asset loading
```

Packages are consumed as TypeScript source through Bun workspaces; there is no build step
between them. `packages/engine/src/math` imports nothing, so game rules and server code
can use `Vector3` and friends without pulling in a renderer.

## How the engine sits on PlayCanvas

| Synergy | PlayCanvas |
|---------|------------|
| `Engine` | `pc.AppBase` created with only the render, camera and light systems |
| `GameObject` | wraps one `pc.Entity` (`gameObject.entity`) |
| `Transform` | reads and writes that entity's graph node |
| `Scene` | a root entity under `app.root`; `new GameObject()` is parented to the active scene's root |
| `Camera`, `Light` | wrap the entity's `camera` / `light` component |
| `MeshFilter` + `MeshRenderer` | share the entity's `render` component |
| `Material` | wraps a `pc.StandardMaterial` |
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
- `destroy` is deferred to the end of the frame. `onDisable` runs before `onDestroy`.
- Coroutines stop when their GameObject is deactivated or destroyed (not when the
  behaviour is merely disabled), as in Unity.
- In a browser an exception in a script is logged and the game keeps running. A headless
  engine rethrows it, so tests fail loudly.

## Headless mode

`Engine.createHeadless()` builds the same app on PlayCanvas's null graphics device with a
stub canvas: no DOM, no GPU, no frame loop. You advance it with `engine.step(dt)` and feed
input through `engine.input` (`pressKey`, `moveMouse`, `pressMouseButton`, ...). Camera
projection and raycasts work, so a test can click on things. See
`game/test/scene.test.ts`.

## The sample game's shape

```
input ──submit(command)──▶ session ──onCommand──▶ rules.apply ──▶ views + HUD observables
                             ▲
              local │ PeerJS (WebRTC) │ Convex
```

- `game/src/rules/` is pure data and functions: no engine, DOM or network.
- `GameController` is the only place state changes, and only in response to a command
  coming back from the session.
- Views (`BoardView`, `UnitView`) render state and know nothing about rules.
- The HUD reads `Observable`s from `game/src/hud.ts`.

Keeping that separation is what makes the game testable headlessly and playable online
without special cases.
