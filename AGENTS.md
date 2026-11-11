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
| `bun run screenshot` | Build, open in headless Chromium, save `.screenshots/game.png`; fails on page errors |
| `bun run backend` | Convex dev deployment (interactive login the first time); writes its URL to `.env.local` |
| `bun run env` | Check environment variables against `.env.schema` (secrets masked) |
| `bun run preview:local` / `preview:deploy` / `deploy` | Cloudflare: local gate, branch preview, main deployment |
| `bun run desktop:dev` / `desktop:build` | Electrobun desktop app |

Use Bun, not Node/npm/Vite/Jest: `bun <file>`, `bun test`, `bun install`, `bunx <tool>`.
Environment variables are declared in `.env.schema` and loaded by varlock (the scripts run
through `varlock run --`); see `docs/environment.md`.

## Layout

```
game/                    THE GAME. Most work happens here.
  index.html             page shell: a canvas, plus the script tag
  src/main.tsx           boot: create engine, register scenes, mount HUD, load scene
  src/scenes/            scenes as functions (Unity: .unity files)
  src/behaviours/        MonoBehaviour scripts and prefabs
  src/rules/             pure game rules: state, commands, check(), apply()
  src/ui/                React HUD and CSS
  src/hud.ts             Observables the HUD reads
  src/online.ts          host/join helpers (PeerJS, Convex)
  test/                  rule tests and headless scene tests
packages/engine/         Unity-style runtime on PlayCanvas   (@synergy/engine)
                         src/grid + src/math are pure: import as @synergy/engine/grid, /math
packages/ui/             React helpers: mountUI, useObservable, WorldAnchor   (@synergy/ui)
packages/net/            command sessions, transports, Convex lobby   (@synergy/net)
packages/netcode/        Netcode for GameObjects on those transports  (@synergy/netcode)
convex/                  backend functions; _generated/ is generated, never edit it
cloudflare/worker.ts     password gate in front of the static build
desktop/                 Electrobun shell
scripts/                 dev server, build, screenshot tool
.env.schema              every environment variable: type, comment, secret or not (varlock)
docs/                    unity-to-synergy.md, architecture.md, tilemaps.md, multiplayer.md,
                         netcode.md, environment.md, deploying.md, desktop.md,
                         porting-notes.md (roadmap from the Unity original)
```

## Unity knowledge transfers, with these differences

Read `docs/unity-to-synergy.md` for the full map. The ones that cause bugs:

1. **camelCase** methods and messages: `update()`, `getComponent(Health)`, `Input.getKeyDown(KeyCode.Space)`.
   A message spelled `Update()` is silently never called.
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
9. **No rigidbody physics, animation, audio or particles yet.** Colliders are for
   raycasts only. Reach PlayCanvas directly via `gameObject.entity` / `engine.app` when needed.
   `docs/porting-notes.md` lists what is missing and in what order to build it.

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

**Add a player action.** Add a variant to `Command` in `game/src/rules/`, handle it in
`check()` and `apply()`, add a rule test, then submit it from input or HUD code with
`controller.submit(...)`. Never change game state outside `apply()`; that is what keeps
multiplayer in sync.

**Make something networked (the Netcode for GameObjects way).** For real-time play, use
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

## Verifying your work

1. `bun run check` must pass.
2. Gameplay logic: add or extend a test. Pure rules go in `game/test/*.test.ts`;
   behaviours can be tested in a real scene with `Engine.createHeadless()`, `engine.step()`
   and `engine.input.pressKey(...)` / `moveMouse(...)` / `pressMouseButton(...)`
   (copy the pattern in `game/test/scene.test.ts`).
3. Anything visual: `bun run screenshot`, then look at the PNG. It can drive the game:
   `bun run screenshot --click 640,360 --key Space --eval "synergy.Time.frameCount"`.

A passing type-check does not mean a script runs: a misspelled message name
(`Update`, `onUpdate`) type-checks and never fires. Test or screenshot behaviour changes.

## Conventions

- TypeScript strict mode. No `any`; no non-null `!` where a check is cheap.
- Engine code in `packages/`, game code in `game/`. `packages/engine` may import only
  `playcanvas`; `packages/net` imports nothing from the engine; `packages/netcode` imports
  only the engine and `packages/net`; `packages/engine/src/math` imports nothing at all.
- One exported behaviour per file, named like the class.
- Comments explain why, or map a concept to Unity. Public engine APIs get a doc comment.
- Game rules are pure and deterministic: no `Math.random()`, `Date.now()` or scene access
  inside `apply()`. Use `new Random(state.seed)` for randomness and
  `@synergy/engine/grid` for grid maths.
- Tests sit next to what they test: `packages/*/test`, `game/test`, `cloudflare/*.test.ts`.

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
- Do not add dependencies to `packages/engine` beyond `playcanvas`. Keep the core small.

## Skills

Task playbooks live in `.claude/skills/<name>/SKILL.md`: `gameplay-scripting`,
`tile-maps`, `port-from-unity`, `verify-changes`, `multiplayer`, `netcode`, `ship-it`,
`extend-engine`.
See `docs/agent-skills.md` for these and for the vendors' optional skills.
