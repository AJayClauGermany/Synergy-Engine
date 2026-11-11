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
| **Tile maps** | Unity's `Grid`/`Tilemap`/`Tile` with square and hex cells, layers, mouse picking, hex maths and weighted pathfinding. |
| **Tweens** | DOTween-style `Tween.move(...)`, eases, loops; usable from coroutines. |
| **HUD** (`packages/ui`) | React over the canvas: `mountUI`, `useObservable`, `<WorldAnchor>` for health bars and labels. |
| **Multiplayer** (`packages/net`) | Ordered command sessions: local, peer-to-peer over WebRTC (PeerJS), or persistent through Convex. |
| **Backend** (`convex/`) | Room lobby and a server-ordered command log. |
| **Previews** (`cloudflare/`) | Deploy to Cloudflare Workers behind a password. |
| **Desktop** (`desktop/`) | Package with Electrobun; runs offline. |
| **Sample game** (`game/`) | A small turn-based hex skirmish that uses all of the above. |
| **Agent support** | `AGENTS.md`, task skills, a headless test mode and a screenshot tool, so AI agents can build and verify changes on their own. |

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

type-checks everything and runs the tests, with no browser needed.

## Making it yours

1. Rename things: `name` in `wrangler.jsonc`, the app in `desktop/electrobun.config.ts`,
   `PEER_PREFIX` in `game/src/online.ts`, the `<title>` in `game/index.html`.
2. Replace the sample: `game/src/rules/` (your rules), `game/src/behaviours/` (your
   scripts), `game/src/scenes/` (your scenes), `game/src/ui/` (your HUD).
3. Keep the shape: input submits commands, rules apply them, views show the result.
   [docs/architecture.md](docs/architecture.md) explains why.

## Commands

| Command | |
|---|---|
| `bun run dev` | Dev server with hot reload |
| `bun run check` | Type-check and test |
| `bun run build` | Production build into `dist/` |
| `bun run start` | Serve `dist/` locally |
| `bun run screenshot` | Capture the game in headless Chromium |
| `bun run backend` | Start a Convex dev deployment |
| `bun run preview:local` | Try the password gate locally |
| `bun run preview:deploy` | Deploy a preview link for the current branch |
| `bun run deploy` | Deploy the main build |
| `bun run desktop:dev` / `desktop:build` | Run or package the desktop app |

## Documentation

- [Unity to Synergy](docs/unity-to-synergy.md): the API map and the differences
- [Architecture](docs/architecture.md): how it sits on PlayCanvas, the frame loop, headless mode
- [Tile maps](docs/tilemaps.md): grids, hex maps, layers, picking, pathfinding
- [Multiplayer](docs/multiplayer.md): commands, sessions, PeerJS, Convex
- [Deploying](docs/deploying.md): password-protected Cloudflare previews
- [Desktop](docs/desktop.md): Electrobun packaging
- [Agent skills](docs/agent-skills.md): what agents get, and optional vendor skills
- [Porting notes](docs/porting-notes.md): what the original Unity game used, and what is still to build

## Status

This is an early foundation (v0.1). Working and tested: the engine core, tile maps and
pathfinding, tweens, React HUD, command sessions, the Cloudflare gate and the sample game. Type-checked but not tested
against live services: PeerJS transport, Convex backend. Written from official templates
but not yet build-verified: the Electrobun desktop shell.

Not built yet: sprite rendering, audio, rigidbody physics, animation and particles.
PlayCanvas provides all of them and is reachable directly (`gameObject.entity`,
`engine.app`) until they are wrapped. [Porting notes](docs/porting-notes.md) has the
priority order.

## License

[Boost Software License 1.0](LICENSE).
