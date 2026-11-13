# Porting notes: what the original Unity game used

> This file is about **one game**: the Unity project this template was first set up to
> receive. It lives in `game/` with the rest of that game. The engine's own, generic
> guide to porting is [docs/porting-from-unity.md](../../docs/porting-from-unity.md);
> replace or delete this file when you start a different game.

An inventory of the original Unity project (packages, imported assets, custom systems),
mapped onto this engine: what exists today, what was added because of it, and what is
still to build. It was produced from a static inspection of that project, so "used"
means "installed or referenced", not "proven necessary".

Rendering is PlayCanvas throughout: the 3D globe and the tactical map are scenes in the
same engine, so there is no second renderer to integrate.

## Status at a glance

| Unity package / feature | Used for | Here | Status |
|---|---|---|---|
| **2D Tilemap** (hex) | Tactical terrain, selection overlays, fog layers | `Grid`, `Tilemap`, `Tile`, `TilemapRenderer`, same hex coordinates. [tilemaps.md](../../docs/tilemaps.md) | **Built in** |
| Custom hex maths, weighted pathfinding | Movement, weapon patterns | `Hex`, `findPath`, `findReachable` in `@synergy/engine/grid` (pure, usable server-side) | **Built in** |
| **DOTween / DOTween Pro** | UI transitions, fades, health-bar effects, camera tweens | `Tween` (`to`, `move`, `rotate`, `scale`, eases, loops, delay, `yield` in coroutines). CSS transitions for the Preact HUD | **Built in** (core subset) |
| Unity `Random` in rules and generation | Combat rolls, map generation | Seeded `Random` class. Same seed gives the same sequence everywhere, but **not** Unity's sequence | **Built in**, see caveat below |
| **uGUI, TextMesh Pro** | Menus, HUD, notifications | In-scene `Canvas`, `CanvasScaler`, `RectTransform`, `Image` for UI images; Preact via `@synergy/ui` for text and interactive UI | **Built in** (images in-scene; text and buttons in Preact) |
| **Multiplayer Widgets** | Lobby, player list | Build from Preact + `ConvexLobby.watchOpenRooms` / `watchRoom` | Building blocks exist |
| **Kamgam UI blur** | Blurred panel backgrounds | CSS `backdrop-filter` (the sample HUD uses it) | **Covered** |
| **Newtonsoft.Json** | Transport, saves, schemas | Native JSON and TypeScript types; Convex validators on the server. Add Zod if client-side validation of untrusted data is needed | **Covered** |
| **Unity Test Framework** | EditMode tests | `bun test`, including whole scenes headlessly | **Covered** |
| **Input System** | Mouse, actions, UI input | `Input` (keys, mouse, axes, named buttons via `defineAxis` / `defineButton`) | Partly: no gamepad, touch gestures or rebinding UI |
| **Cinemachine** | Tactical camera: move, focus, confine | Sample `CameraRig` (pan, rotate, zoom, bounds). Focus moves with `Tween.move` | Partly: lives in the sample, not the engine |
| **Netcode for GameObjects + Transport** | Authoritative actions, RPCs, replicated state | `@synergy/netcode`: `NetworkManager`, `NetworkObject`, `NetworkVariable`, RPCs, host-authoritative. [netcode.md](../../docs/netcode.md). Also command sessions (`@synergy/net`) with `startTicker` | **Built** (host-authoritative; no scene sync yet) |
| **Unity Authentication / Multiplayer Services** | Identity for the campaign backend, sessions | Not built. Needs an auth provider on the Convex side | **To do**, see below |
| **URP, custom shaders, post-processing** | Globe rendering and effects | PlayCanvas materials through `material.pcMaterial`; nothing Unity-specific carries over | **To rebuild** |
| **All In 1 Sprite Shader** | Outlines, construction fade | Fade: `material.color` alpha or a `Tween`. Outline: not wrapped | **To do** |
| **2D Sprites** (SpriteRenderer) | Units and props as sprites | `Sprite` (pivot, pixels per unit), `SpriteRenderer` (`color`, `flipX/Y`, `sortingOrder`), `Assets.loadSprite`. No sorting layers or sprite animation | **Built in** |
| **Unity Audio** | Music, sound effects | Not wrapped | **To do** |
| 2D Animation, Aseprite/PSD importers, SpriteShape, Tilemap Extras | Authoring pipeline | Export images and data; no runtime equivalent needed unless sprite animation is required | Later, if needed |
| Timeline, Visual Scripting, Vivox | Installed; no clear use found | Nothing planned | Not needed |
| Burst, Collections, Mathematics, Jobs | Runtime performance infrastructure | Plain TypeScript; Web Workers if profiling calls for it | Not needed yet |
| Recorder, IDE integrations, vFolders/vHierarchy/..., Unity MCP | Editor workflow | No runtime equivalent. Agent tooling is described in [agent-skills.md](../../docs/agent-skills.md) | Not applicable |

## The tactical simulation is the real work

The package list is the small part. The original's custom simulation (weighted hex
pathfinding, combat patterns, fog of war, supply lines, construction, AI, map editing,
authoritative action handling) has to be ported from C# by hand. How it fits here:

- **Choose where the state lives before porting it.** If the Unity code keeps it in
  `NetworkBehaviour`s (`NetworkVariable`s changed by server RPCs), the direct port keeps
  that shape with `@synergy/netcode`, script by script ([netcode.md](../../docs/netcode.md)). The
  alternative is to pull it out into pure rules modules like `game/src/rules/` (state,
  commands, `check`, `apply`), which is more work up front and gives replays, saves and
  server-side validation. Either way, keep calculations (costs, ranges, damage) in pure
  functions with no engine imports beyond `@synergy/engine/grid`, so they run in the
  browser, in tests, and on a server.
- **Use the existing Unity EditMode tests as the specification.** Port each as a
  `bun test` and make it pass. Add fixtures exported from Unity (maps, saves, combat
  outcomes) and assert the TypeScript port reproduces them.
- **Hex coordinates carry over.** `Grid` with `CellLayout.Hexagon` uses Unity's offset
  layout, so cell coordinates in existing map and scenario data mean the same thing.
- **Pathfinding and patterns** build on `findReachable` / `findPath` (terrain costs,
  blocked cells) and `Hex.range` / `Hex.ring` / `Hex.line` (weapon patterns, line of sight).
- **Fog of war and overlays** are extra `Tilemap` layers over the terrain (semi-transparent
  tiles, `setColor` per cell, or a tinted whole layer).

### Simultaneous control, cooldowns and world ticks

The original ruleset is not turn-based: players act at the same time, each action has a
cooldown, and the world advances on a shared two-second tick. With netcode the host runs
that tick and stores each cooldown as a "ready at" time in a `NetworkVariable`. The
command model handles it too, without special support for "turns":

- `startTicker(session, 2000, { type: 'tick' })` makes the host submit a tick command
  every two seconds, in the same ordered stream as player actions.
- `apply` advances the world on `tick`, and stores cooldowns as "ready at tick N".
- Any player may submit at any time; `check` refuses an action whose cooldown has not
  expired *as of that point in the stream*. Every machine evaluates it identically.

See "Simultaneous play" in [multiplayer.md](../../docs/multiplayer.md).

### Random numbers and generated maps

Unity's random and noise functions cannot be reproduced bit-for-bit from the same seed.
Do not regenerate existing maps here from their Unity seeds: **export generated maps as
data** and load them. For new content, use the seeded `Random` class and keep its `state`
in the game state so every player rolls the same numbers.

## Multiplayer and backend

- **The Convex campaign backend carries over.** It is already TypeScript on Convex. Call
  it from the browser with the Convex client (`ConvexLobby` accepts an existing
  `ConvexClient`, or use `convex/browser` directly; `convex/react` needs React, which
  this project does not ship). Merge its
  functions into `convex/`, or point `PUBLIC_CONVEX_URL` at the existing deployment.
- **Authentication must change.** That backend trusts Unity-issued identities. A browser
  client needs another identity provider wired into Convex (Convex Auth or any OIDC
  provider), and every function should take the player from `ctx.auth`. This is a
  backend change, not just a client swap, and it is the main blocker for going beyond
  prototypes. The lobby in this template is likewise unauthenticated.
- **Authoritative tactical play.** In Unity the server validated actions (Netcode). The
  closest match is now `@synergy/netcode`: clients send `serverRpc`s, the host validates
  them with the pure rules and changes `NetworkVariable`s, and everyone sees the result
  ([netcode.md](../../docs/netcode.md)). The host is trusted, which is fine for prototyping. With
  command sessions there are three levels, in increasing strength:
  1. peer-to-peer with the host validating (`CommandSession.host({ validate })`);
  2. Convex ordering commands while every client runs `check`;
  3. Convex *validating* commands, by importing the pure rules module into the `submit`
     mutation. This is the path to a trustworthy server and needs no new technology.
- **A dedicated real-time server** (for example Colyseus, which the original assessment
  suggested) is not included. If server-side ticking with low latency becomes necessary,
  implement the `Session<C>` interface over it; game code does not change. Server-driven
  ticks can also come from Convex's scheduler instead of the host player's machine.
- **Hidden information.** Fog of war that must be secret from the other player cannot be
  enforced with a shared command log. With netcode the host decides what each client
  receives (`checkObjectVisibility`, `networkShow` / `networkHide`, `read: Owner`
  variables), which is enough while the host is trusted.
- **Voice chat** (Vivox) was installed but disabled. Nothing is planned.

## Rendering and presentation

- **The globe** is ordinary 3D here: a sphere, a camera, materials. Unity ShaderLab and
  URP shader graphs do not transfer; rebuild the looks with PlayCanvas's standard
  material first, then custom shader chunks or `ShaderMaterial` through
  `material.pcMaterial` where needed. Post-processing (bloom, colour grading) exists in
  PlayCanvas and is not wrapped yet.
- **Switching between globe and tactical map** is `SceneManager.loadScene`, or both
  loaded additively with one deactivated.
- **Sprites.** Tiles can be textured, and free-standing sprites (units, props) use
  `SpriteRenderer`, which shares the scene and depth buffer with 3D meshes. Sprite
  animation and sorting layers are not built.
- **Camera.** Promote `CameraRig` from the sample into the engine once its behaviour is
  settled (focus on a target, follow, confinement to the map bounds).

## Assets and data

- **Art and audio** files can be reused. Preserve sprite slicing, pivots and
  pixels-per-unit when exporting sheets; convert models to glTF/GLB.
- **ScriptableObject data** (units, buildings, weapons, rulesets, map configuration)
  becomes records in a `Catalog`, exported with `tools/unity` (Tools > Synergy > Export
  Selected Assets As Data). Keep the existing `SO_name` identifiers as the ids so saves
  and scenarios still refer to the same things.
- **Tile assets and painted Tilemaps** (terrain with climate, elevation and the rest)
  export the same way (Export Tilemaps In Open Scenes) to a palette file and a map file:
  see [content.md](../../docs/content.md).
- **Save, scenario and defense-layout formats** should be read by importers that accept
  the existing versions.
- **Licences.** DOTween Pro, All In 1 Sprite Shader and the Kamgam blur are Unity Asset
  Store assets. None of their code is used here. Check the licence of any third-party
  art, fonts or audio before moving it into a browser build, which ships the files to
  every visitor.

## Suggested order

1. Prove the Convex campaign backend from the browser, including the authentication change.
2. Port the rules, driven by the existing tests and exported fixtures.
3. Build the tactical scene on `Grid`/`Tilemap`, with placeholder art.
4. Prototype multiplayer with ticks, then decide whether Convex validation is enough or
   a dedicated server is needed.
5. Rebuild presentation: sprites, shaders, camera, audio, HUD.

## Scenes, models and local testing: decisions and open work

Notes from a review of how the original's scenes and assets land here (November 2026).
Nothing in this section is built yet unless it says so.

### Scene structure

The original has a main menu with a lobby, a game scene, and a metagame lobby holding a
live map that several people play on. Planned shape, all in the one page:

- **Three registered scenes.** A main menu scene that is empty (or a camera and a
  backdrop), the game scene, and the metagame scene. Loading the menu scene is what
  clears the game's objects when a player quits to the menu.
- **One HUD root, mounted once at boot**, showing the menu, lobby, game or metagame
  screen from an `Observable`. Today `game/src/main.tsx` picks a HUD once from the
  starting scene; that has to change before scenes switch at run time.
- **The connection lives outside the scenes**, created at boot, as
  `game/src/frontier/session.ts` does. The host moves everyone between scenes through
  the network manager.
- **The metagame map fits netcode**: many players, one map, people joining late.
- **Open question: who hosts the metagame map?** Netcode is hosted by a player's
  machine, so the map ends when that player leaves. If it must stay up with nobody
  online, its state belongs in Convex instead. Decide this before building it.
- **No loading screen exists.** A scene's assets load when the scene does (register it
  with `preload` and `build`), and the canvas is empty meanwhile. Show a HUD overlay
  around `SceneManager.loadScene`.

### 3D models

The original's models are FBX. The engine loads glTF only (`Assets.loadModel`, `.glb`).

- **Convert once, offline, and commit the `.glb` files**: Blender, or a glTF exporter
  inside Unity when the Unity materials matter. `tools/unity` does not export models.
- **Check after converting**: size (FBX often carries a factor of 100 that Unity hides),
  materials (custom shaders do not come across), and that moving parts are still
  separate, named nodes with their pivots at the centre.
- **Vehicle wheels, turrets, rotors: no animation clips.** Find the part with
  `transform.find` and turn it in `update()` from the vehicle's speed. This works today.
  Drop the animation tracks from those files when exporting.
- **Walkers (two-legged and four-legged mechs) need skeletal clips, and the engine
  cannot play them yet.** See "Engine work this implies", item 1. When exporting them:
  put every clip in the one `.glb` under a clear name; rebuild Animator Controller
  logic in code (states and transitions are Unity assets); bake clips shared through
  Unity's Humanoid retargeting onto each skeleton; expect no IK and no root motion, so
  use clips that walk in place and match their speed to the unit's.
- **Check whether the mechs are skinned at all.** If they are rigid parts on animated
  nodes, the clips are still needed but skinned rendering, which nothing here has
  exercised, is not.

### Several players on one machine (Unity's Multiplayer Play Mode)

Unity's virtual players open up to four windows of the game for testing. Here:

- **In a browser this works now**: each tab or window of `bun run dev` is its own
  player. They find each other through PeerJS, so it needs a connection.
- **They share one stored player id.** `ConvexLobby` remembers the id in localStorage,
  which every tab of the same origin shares, so two tabs join a lobby as the same
  player unless each is given its own id. Private windows or separate browser profiles
  are the workaround.
- **The desktop app opens one window** (`desktop/src/bun/index.ts`). Electrobun can open
  more; nothing here does.
- **To build**: a development option that opens up to four windows, each with its own
  player id (for example from the URL), and a transport between windows of the same
  machine so that it works offline. `LoopbackTransport` only reaches inside one page;
  the browser's BroadcastChannel is the likely base, written against the `Transport`
  interface in `packages/net`. Whether windows of the packaged desktop app share an
  origin for that has not been checked.
- Match logic does not need any of this: `TestNetwork` runs a host and clients as
  simulated machines in one test (`game/test/frontier.test.ts`).

## Engine work this implies

In rough priority order for this game:

1. Skeletal animation for the walkers: switch on PlayCanvas's anim component system and
   its resource handlers in `Engine.create`, let a loaded `Model` hand out its clips by
   name (it keeps them private today), and add an Animator component in Unity's shape
   (play, cross-fade, speed). Test with a real walker `.glb`, including a screenshot of
   a skinned mesh.
2. Several windows on one machine for testing multiplayer (above)
3. Sprite animation, if units are animated sheets (`SpriteRenderer` itself is built)
4. `AudioSource` / `AudioClip`
5. Camera helper in the engine (focus, follow, confine)
6. Outline and other per-object effects; post-processing wrappers
7. Isometric layout, animated tiles, elevation (large maps are handled: tilemaps draw in blocks)
8. Gamepad and touch gestures; input rebinding
9. Rigidbody physics, if a future game needs it
