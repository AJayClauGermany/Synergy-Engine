# Synergy Engine

A game engine template with **Unity's API and concepts, in TypeScript, on top of
[PlayCanvas](https://playcanvas.com)**. Clone it, build your game in `game/`.

If you know Unity, you already know how to use it:

```ts
import { Input, KeyCode, MonoBehaviour, Time, Vector3, destroy } from '@synergy/engine';

export class Spinner extends MonoBehaviour {
  speed = 90;

  update() {
    this.transform.rotate(Vector3.up, this.speed * Time.deltaTime);
    if (Input.getKeyDown(KeyCode.Space)) destroy(this.gameObject);
  }
}
```

`GameObject`, `Transform`, `MonoBehaviour` with the real lifecycle order, coroutines,
`Time`, `Input`, `Physics.raycast`, `SceneManager`, `instantiate`/`destroy`, prefabs,
`Grid`/`Tilemap`: same names, same behaviour, camelCase. [docs/unity-to-synergy.md](docs/unity-to-synergy.md)
has the full map and the handful of deliberate differences.

## What is in the box

| | |
|---|---|
| **Engine** (`packages/engine`) | Unity-style runtime. Its only dependency is PlayCanvas. |
| **Tile maps** | Unity's `Grid`/`Tilemap`/`Tile` with square and hex cells, layers, mouse picking, hex maths and weighted pathfinding. Drawn in blocks, so maps of tens of thousands of tiles stay cheap to change. |
| **Content from data** | Tile palettes, maps and definitions (Unity's Tile assets, painted Tilemaps and ScriptableObjects) load from JSON, with a Unity editor script to export them (`tools/unity`). |
| **Tweens** | DOTween-style `Tween.move(...)`, eases, loops; usable from coroutines. |
| **HUD** (`packages/ui`) | [Preact](https://preactjs.com) over the canvas (not React; hooks come from `preact/hooks`): `mountUI`, `useObservable`, `<WorldAnchor>` for health bars and labels. |
| **Netcode** (`packages/netcode`) | Unity's Netcode for GameObjects: `NetworkManager`, `NetworkObject`, `NetworkVariable`, RPCs, ownership, visibility, synchronized scene loading. One player hosts, the rest connect to them. |
| **Multiplayer** (`packages/net`) | Transports (WebRTC via PeerJS, in-memory), plus ordered command sessions for turn-based and asynchronous games. |
| **Backend** (`convex/`) | The lobby (rooms, join codes, open-games list) and a server-ordered command log. |
| **Configuration** (`.env.schema`) | Every environment variable in one committed, secret-free file, managed by [varlock](https://varlock.dev). |
| **Previews** (`cloudflare/`) | A private preview per pull request on Cloudflare: sign-in by email, assets in R2. |
| **Desktop** (`desktop/`) | Package with Electrobun; runs offline. |
| **Sample games** (`game/`) | *Skirmish*: a turn-based hex game on command sessions. *Frontier* (`?scene=Frontier`): a real-time, host-authoritative match on netcode, with a map from data and fog of war. Start from the one that matches your game. |
| **Agent support** | `AGENTS.md`, task skills, a headless test mode, a screenshot tool, and one `bun run check` whose lint rules know the mistakes a Unity port makes, so AI agents can build and verify changes on their own. |

It is aimed at strategy games (turn-based and real-time), but the engine is generic.

## Quick start

Requires [Bun](https://bun.sh) (developed and tested with 1.4).

```bash
bun install
```

```bash
bun run dev
```

Open http://localhost:3000. Click a blue unit, then a highlighted hex; `Space` ends the
turn. Forests cost extra movement and water blocks it. Edit anything under `game/src` and the page reloads.

```bash
bun run check
```

formats, lints, type-checks and tests everything in a few seconds, with no browser needed,
and ends with `PASSED` or `FAILED`. `bun run fix` applies what can be fixed automatically
first. [docs/checks.md](docs/checks.md) describes each check.

## Making it yours

1. Rename things: `name` in `wrangler.jsonc`, the app in `desktop/electrobun.config.ts`,
   `PEER_PREFIX` in `game/src/online.ts`, the `<title>` in `game/index.html`.
2. Replace the sample: `game/src/rules/` (your rules), `game/src/behaviours/` (your
   scripts), `game/src/scenes/` (your scenes), `game/src/ui/` (your HUD).
3. Keep the shape of the sample you started from. Skirmish: input submits commands,
   rules apply them, views show the result. Frontier (`game/src/frontier/`): state in
   `NetworkVariable`s, players ask through RPCs, the host decides.
   [docs/architecture.md](docs/architecture.md) explains both.

Coming from an existing Unity project? Start at
[docs/porting-from-unity.md](docs/porting-from-unity.md).

## Commands

| Command | |
|---|---|
| `bun run dev` | Dev server with hot reload |
| `bun run check` | Every check: format, lint, types, tests, project graph |
| `bun run fix` | Fix what a tool can, then check |
| `bun test` | Tests only |
| `bun run build` | Production build into `dist/` |
| `bun run start` | Serve `dist/` locally |
| `bun run screenshot` | Capture the game in headless Chromium |
| `bun run backend` | Start a Convex dev deployment (writes its URL to `.env.local`) |
| `bun run env` | Check the environment variables against `.env.schema` |
| `bun run preview:local` | Try the password gate locally |
| `bun run preview:deploy` | Deploy a preview link for the current branch |
| `bun run deploy` | Deploy the main build |
| `bun run desktop:dev` / `desktop:build` | Run or package the desktop app |

## Documentation

- [Unity to Synergy](docs/unity-to-synergy.md): the API map and the differences
- [Architecture](docs/architecture.md): how it sits on PlayCanvas, the frame loop, headless mode
- [Porting from Unity](docs/porting-from-unity.md): the order to bring an existing project across
- [Checks](docs/checks.md): what `bun run check` runs, the lint rules for Unity habits, the layering
- [Tile maps](docs/tilemaps.md): grids, hex maps, layers, picking, pathfinding
- [Content as data](docs/content.md): tile palettes, maps and definitions from JSON; exporting from Unity
- [Netcode](docs/netcode.md): Netcode for GameObjects in TypeScript: spawning, variables, RPCs, scenes, lobby
- [Multiplayer](docs/multiplayer.md): command sessions, PeerJS, Convex
- [Environment](docs/environment.md): variables, secrets, setting up Convex
- [Deploying](docs/deploying.md): private Cloudflare previews per pull request, assets in R2
- [Desktop](docs/desktop.md): Electrobun packaging
- [Agent skills](docs/agent-skills.md): what agents get, and optional vendor skills

## Status

This is an early foundation (v0.1). Working and tested: the engine core, tile maps and
pathfinding, sprites, content loading, tweens, Preact HUD, command sessions, netcode
(tested with simulated machines), the Cloudflare gate and both sample games.
Type-checked but not tested against live services: PeerJS transport, Convex backend.
Written from documentation but not yet run: the Unity exporter (`tools/unity`, which
needs Unity) and the Electrobun desktop shell.

Not built yet: audio, rigidbody physics, animation and particles. PlayCanvas provides
all of them and is reachable directly (`gameObject.entity`, `engine.app`) until they are
wrapped. "Not implemented yet" in [docs/unity-to-synergy.md](docs/unity-to-synergy.md)
has the list.

## License

[Boost Software License 1.0](LICENSE).
