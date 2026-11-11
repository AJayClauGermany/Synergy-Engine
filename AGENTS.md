# Synergy Engine: guide for agents and contributors

Synergy is a game engine template: **Unity's API and concepts, in TypeScript, running on
PlayCanvas**. You clone it and build your game in `game/`. It targets strategy games
(turn-based or real-time) but the engine itself is generic.

Stack: Bun (runtime, bundler, test runner, package manager) · PlayCanvas (rendering) ·
React (HUD) · PeerJS and Convex (multiplayer) · varlock (environment variables) ·
Cloudflare Workers (preview deploys) · Electrobun (desktop).

## Commands

| Command | What it does |
|---------|--------------|
| `bun install` | Install dependencies |
| `bun run dev` | Dev server with hot reload at http://localhost:3000 |
| `bun run check` | **Type-check everything and run all tests. Run this before you call a change done.** |
| `bun test` | Tests only (headless, about a second). `bun test game` runs one folder |
| `bun run typecheck` | Type-check only |
| `bun run build` | Production build into `dist/` |
| `bun run screenshot` | Build, open in headless Chromium, save `.screenshots/game.png`; fails on page errors. `--hierarchy` prints the scene as text |
| `bun run backend` | Convex dev deployment (interactive login the first time); writes its URL to `.env.local` |
| `bun run env` | Check environment variables against `.env.schema` (secrets masked) |
| `bun run preview:local` / `preview:deploy` / `deploy` | Cloudflare: local gate, branch preview, main deployment |
| `bun run desktop:dev` / `desktop:build` | Electrobun desktop app |

Use Bun, not Node/npm/Vite/Jest: `bun <file>`, `bun test`, `bun install`, `bunx <tool>`.
Environment variables are declared in `.env.schema` and loaded by varlock (the scripts run
through `varlock run --`); see `docs/environment.md`.

## Layout

```
game/                    THE GAME. Most work happens here. It holds two samples:
                         Skirmish (commands, turn-based) and Frontier (netcode, real-time).
  index.html             page shell: a canvas, plus the script tag
  src/main.tsx           boot: create engine, register scenes, mount HUD, load scene
  src/scenes/            scenes as functions (Unity: .unity files)
  src/behaviours/        MonoBehaviour scripts and prefabs
  src/rules/             Skirmish's pure rules: state, commands, check(), apply()
  src/ui/                React HUD and CSS
  src/hud.ts             Observables the HUD reads
  src/online.ts          host/join helpers (PeerJS, Convex)
  src/frontier/          the netcode sample, whole: data/ (map, tiles, sprite sheet as files),
                         rules.ts, Match.ts, Soldier.ts, board, player, scene, session, HUD
  test/                  rule tests, headless scene tests, simulated-network tests
  docs/                  notes about this particular game (not the engine)
packages/engine/         Unity-style runtime on PlayCanvas   (@synergy/engine)
                         src/math, src/grid, src/data are pure: @synergy/engine/math, /grid, /data
packages/ui/             React helpers: mountUI, useObservable, WorldAnchor   (@synergy/ui)
packages/net/            command sessions, transports, Convex lobby   (@synergy/net)
packages/netcode/        Netcode for GameObjects on those transports  (@synergy/netcode)
convex/                  backend functions; _generated/ is generated, never edit it
cloudflare/worker.ts     password gate in front of the static build
desktop/                 Electrobun shell
scripts/                 dev server, build, screenshot tool
tools/unity/             editor script that exports Unity tiles, tilemaps and ScriptableObjects
.env.schema              every environment variable: type, comment, secret or not (varlock)
docs/                    unity-to-synergy.md, porting-from-unity.md, content.md, tilemaps.md,
                         architecture.md, multiplayer.md, netcode.md, environment.md,
                         deploying.md, desktop.md
```

## Unity knowledge transfers, with these differences

Read `docs/unity-to-synergy.md` for the full map. The ones that cause bugs:

1. **camelCase** methods and messages: `update()`, `getComponent(Health)`, `Input.getKeyDown(KeyCode.Space)`.
   Unity's spelling (`Update()`, `OnEnable()`) is a type error and an error when the script
   is added. A near miss such as `onStart()` only logs a warning, so read the output.
2. **Vectors are immutable and have no operators**: `a.add(b)`, `v.mul(2)`, `q.rotate(v)`.
   `transform.position = transform.position.add(delta)`.
3. **Right-handed world, forward is -Z.** Always write `Vector3.forward` / `transform.forward`,
   never `new Vector3(0, 0, 1)`.
4. **Screen space is top-left origin, Y down, CSS pixels** (`Input.mousePosition`,
   `camera.worldToScreenPoint`). A larger `y` is lower on screen.
5. **No `out` params, no `== null` for destroyed objects**: `const hit = Physics.raycast(ray); if (hit) ...`
   and `if (isAlive(target))`.
6. **Never `new` a component.** `gameObject.addComponent(Type)`. Set up in `awake`/`start`, not a constructor.
7. **Coroutines are generators**: `*run(): IEnumerator { yield new WaitForSeconds(1); }`, started
   with `this.startCoroutine(this.run())` (call it).
8. **Lights aim along -Y.** Use `light.direction = ...`.
9. **C# habits that change meaning.** `a / b` never truncates (`Math.trunc(a / b)` for
   integer division); objects used as `Map`/`Set` keys match by identity, not value
   (`cellKey(cell)` for cells); `array.sort()` sorts in place and as text unless given a
   comparer. The table is in `docs/unity-to-synergy.md`, "C# to TypeScript".
10. **No rigidbody physics, animation, audio or particles yet.** Colliders are for
   raycasts only. Reach PlayCanvas directly via `gameObject.entity` / `engine.app` when needed.
   "Not implemented yet" in `docs/unity-to-synergy.md` lists what is missing.

## How to do common things

**Add a behaviour.** Create `game/src/behaviours/Thing.ts`:

```ts
import { MonoBehaviour, Time, Vector3 } from '@synergy/engine';

export class Thing extends MonoBehaviour {
  speed = 2; // public fields are the "inspector" values
  update() {
    this.transform.translate(Vector3.forward.mul(this.speed * Time.deltaTime));
  }
}
```

Attach it in a scene or prefab: `gameObject.addComponent(Thing).speed = 5;`

**Add a scene.** Write a `SceneBuilder` function in `game/src/scenes/`, register it in
`game/src/main.tsx` with `SceneManager.register('Name', build)`, open it with
`?scene=Name` or `SceneManager.loadScene('Name')`. Every scene needs a camera tagged
`MainCamera` and a light.

**Add a prefab.** `export const X = new Prefab('X', (go) => { ...addComponent... })`, then
`instantiate(X, position)`.

**Build a map.** Use the tile system (`docs/tilemaps.md`): a `Grid` (set `cellLayout`,
and `cellSwizzle = CellSwizzle.XZY` for a ground map), child GameObjects with `Tilemap` +
`TilemapRenderer` per layer, `tilemap.setTile({ x, y }, tile)`. Place things with
`grid.getCellCenterWorld(cell)`; turn the mouse into a cell with `grid.raycast(ray)`.
For movement ranges and routes use `findReachable` / `findPath` with `Hex.neighbors`.

**Put numbers and maps in data, not code** (`docs/content.md`). Definitions (unit types,
items; Unity's ScriptableObjects) go in a `Catalog` and are looked up by id:
`unitTypes.get('scout').moveRange`. A wrong id throws and names the right ones. Tiles
with their own data (climate, elevation) and painted maps load from JSON:
`TilePalette.load(tiles)`, `createTilemaps(map, palette)`, then
`tilemap.getTile<Tile<Terrain>>(cell)?.data`. Definitions are read-only; copy one to
change it. Rules read the same files through `@synergy/engine/data`. Content from a Unity
project is exported with `tools/unity`. `game/src/frontier/rules.ts` shows all of it.

**Animate something.** Short one-off motion: `Tween.move(transform, target, 0.3)`.
Multi-step sequences: a coroutine (which can `yield` a tween).

**Mix 3D, sprites and UI images.** Meshes and `Assets.loadModel` models, `SpriteRenderer`
(2D images in the world, facing +Z) and a `Canvas` with `Image` children (screen-space UI,
laid out with `RectTransform`) all live in one scene; see `game/src/scenes/ShowcaseScene.ts`.
Load images with `Assets.loadSprite(url)` (they load as sRGB colour textures).

**Show something in the HUD.** Add an `Observable` to `game/src/hud.ts`, set `.value` from
game code, read it in a component with `useObservable`. Replace objects/arrays rather than
mutating them. Elements that should block clicks to the game need `data-interactive`
(buttons, inputs and links already do).

**Decide how shared state works, once per game.** There are two models; pick the one the
game uses and stay with it (`docs/multiplayer.md` compares them):

- *Commands* (the sample game): state is plain data in `game/src/rules/`, changed only by
  `apply()`. Fits turn-based and replayable games where every machine runs the same rules.
- *Netcode* (`@synergy/netcode`, Unity's Netcode for GameObjects): state lives in
  `NetworkVariable`s on components and only the host changes it. Fits real-time play,
  hidden information, and Unity projects that already use `NetworkBehaviour`s.

**Add a player action (commands).** Add a variant to `Command` in `game/src/rules/`, handle
it in `check()` and `apply()`, add a rule test, then submit it from input or HUD code with
`controller.submit(...)`. Never change game state outside `apply()`; that is what keeps
this kind of multiplayer in sync.

**Add a player action or networked object (netcode).** For real-time play, use
`@synergy/netcode` (`docs/netcode.md`) instead of commands. One player hosts and is
the server and a client at once. A `NetworkPrefab` holds `NetworkBehaviour`s whose
`NetworkVariable` and RPC fields are declared as class fields; the host calls
`networkObject.spawn()`, and clients change things only by calling a `serverRpc`, whose
handler validates its arguments:

```ts
export class Soldier extends NetworkBehaviour {
  readonly health = new NetworkVariable(100);
  readonly moveRpc = this.serverRpc((x: number, y: number) => { /* check, then change state */ });
  onNetworkSpawn() { this.health.onValueChanged.add((_before, now) => showHealth(now)); }
}
export const SoldierPrefab = new NetworkPrefab('Soldier', (go) => { go.addComponent(Soldier); });
```

`game/src/frontier/` is a complete match built this way: copy its shape. To start a
match for everyone, load its scene with `networkManager.sceneManager.loadScene(name)`,
spawn into it when `onLoadComplete` fires for client 0, and enable play on
`onLoadEventCompleted` (`session.ts`). Test it with simulated machines:
`TestNetwork` from `@synergy/netcode/testing` (`game/test/frontier.test.ts`).

## Verifying your work

1. `bun run check` must pass.
2. Gameplay logic: add or extend a test. Pure rules go in `game/test/*.test.ts`;
   behaviours can be tested in a real scene with `Engine.createHeadless()`, `engine.step()`
   and `engine.input.pressKey(...)` / `moveMouse(...)` / `pressMouseButton(...)`
   (copy the pattern in `game/test/scene.test.ts`). Networked behaviour: a host and
   clients as simulated machines (copy `game/test/frontier.test.ts`).
3. Anything visual: `bun run screenshot`, then look at the PNG. It can drive the game:
   `bun run screenshot --click 640,360 --key Space --eval "synergy.Time.frameCount"`.
4. To see what is in the scene without an image, print `Debug.hierarchy()` in a test, or
   run `bun run screenshot --hierarchy`: every GameObject with its components, position
   and the values of its scripts' fields. Check it before guessing why something is missing.

A passing type-check does not mean a script runs. Unity-cased messages (`Update`) are
caught, but a method the engine has no reason to call (`onUpdate`, `tick`) only draws a
warning or nothing at all. Test or screenshot behaviour changes.

## Conventions

- TypeScript strict mode. No `any`; no non-null `!` where a check is cheap.
- Engine code in `packages/`, game code in `game/`. `packages/engine` may import only
  `playcanvas`; `packages/net` imports nothing from the engine; `packages/netcode` imports
  only the engine and `packages/net`; `packages/engine/src/math` imports nothing at all,
  and `src/grid` and `src/data` only `src/math`.
- One exported behaviour per file, named like the class.
- Comments explain why, or map a concept to Unity. Public engine APIs get a doc comment.
- Game rules are pure and deterministic: no `Math.random()`, `Date.now()` or scene access
  inside `apply()`. Use `new Random(state.seed)` for randomness and
  `@synergy/engine/grid` for grid maths.
- Tests sit next to what they test: `packages/*/test`, `game/test`, `cloudflare/*.test.ts`.
- Content files get a test too: one that runs `checkTilePaletteData` / `checkTilemapData`
  over every palette and map the game ships (`game/test/content.test.ts`).

## Boundaries

- Do not edit `convex/_generated/`; `bun run backend` regenerates it.
- Only `PUBLIC_*` environment variables reach the browser bundle. Never put a secret in
  one, and never commit `.env` or `.dev.vars`. Declare new variables in `.env.schema`
  (mark secrets `@sensitive`). Do not read or edit `.env`, `.env.local` or `.dev.vars`:
  they may hold secrets. `bun run env` shows what resolved, with secrets masked.
- `desktop/` is not covered by `bun run typecheck` (its SDK types are generated on first
  desktop build) and its build has not been verified; see `docs/desktop.md`.
- The PeerJS and Convex integrations (including `@synergy/netcode/lobby`) have no
  automated tests (they need live services). If you change them, say so and test by hand.
  The rest of netcode is tested with simulated machines (`packages/netcode/test`).
- `tools/unity/Editor/SynergyExporter.cs` runs inside Unity and has not been compiled or
  run here. If you change it, say so; the formats it writes are tested on the engine side.
- Do not add dependencies to `packages/engine` beyond `playcanvas`. Keep the core small.

## Skills

Task playbooks live in `.claude/skills/<name>/SKILL.md`: `gameplay-scripting`,
`tile-maps`, `port-from-unity`, `verify-changes`, `multiplayer`, `netcode`, `ship-it`,
`extend-engine`.
See `docs/agent-skills.md` for these and for the vendors' optional skills.
