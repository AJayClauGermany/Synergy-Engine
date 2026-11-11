---
name: verify-changes
description: Use after changing game or engine code, and before reporting work as done, to verify it with the type-checker, headless tests, and browser screenshots.
---

# Verifying changes

Three levels, cheapest first. Do the ones that apply; say which you did.

## 1. `bun run check` (always)

Type-checks the app, Convex functions and the Cloudflare Worker, then runs every test
(about a second). It must pass.

Type-checking catches Unity-cased messages (`Update`), but not a method the engine never
calls for another reason (`onStart`, a script that was never added to an object). So for
behaviour changes also do 2 or 3.

## 2. Headless tests (gameplay and engine logic)

The engine runs without a browser. Real scripts, real raycasts, simulated time and input:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine, GameObject, KeyCode, Vector3 } from '@synergy/engine';

let engine: Engine;
beforeEach(() => { engine = Engine.createHeadless(); });
afterEach(() => { engine.dispose(); });

test('the mover walks forward', () => {
  const mover = new GameObject('M').addComponent(Mover);
  engine.stepSeconds(1);                       // or engine.step(dt), engine.stepFrames(n)
  expect(mover.transform.position.z).toBeCloseTo(-3);
});

test('space fires', () => {
  engine.input.pressKey(KeyCode.Space);        // also releaseKey, moveMouse(x, y),
  engine.step();                               // pressMouseButton(0), scroll(0, 1)
  // ...
});
```

- Exceptions thrown by scripts fail the test (headless engines rethrow them).
- To click a world position: `camera.worldToScreenPoint(p)` → `engine.input.moveMouse` →
  `pressMouseButton(0)` → `engine.step()`. See `game/test/scene.test.ts`.
- A whole scene: `SceneManager.register('S', build); await SceneManager.loadScene('S');`
- Input "down" edges last one frame: read them inside a behaviour's `update`, not after
  `engine.step()` returns.
- Pure rules (`game/src/rules`, `game/src/frontier/rules.ts`) need no engine at all; test
  them directly.
- Networked code: a host and clients as simulated machines, with `TestNetwork` from
  `@synergy/netcode/testing`. Copy `game/test/frontier.test.ts`. Do things as a machine
  inside `machine.run(() => ...)`, call `net.pump()` to pass time and messages, and
  `await net.settle()` after anything asynchronous (a scene load).
- Content files: `game/test/content.test.ts` checks every palette and map. Extend it
  when you add one.
- When an assertion fails and you cannot see why, `console.log(Debug.hierarchy())` prints
  every GameObject with its components, position and script fields. Pass
  `{ root: gameObject }` for one object, `{ fields: false }` for names only.
- Warnings printed during a test run are worth reading: the engine warns once about a
  method that looks like a message but is never called.

Run one file or folder: `bun test game/test/scene.test.ts`, `bun test packages/engine`.

## 3. Screenshots (anything visual)

```bash
bun run screenshot
```

Builds, serves `dist/`, opens headless Chromium with software WebGL, waits for the scene,
saves `.screenshots/game.png`, and exits 1 if the page logged an error. Then **look at the
image** with the Read tool.

Drive the game first, in order:

```bash
bun run screenshot --click 603,466 --click 606,365 --wait 700 --out .screenshots/moved.png
```

Options: `--click x,y` · `--key Space` · `--wait ms` · `--eval "<js>"` · `--hierarchy` ·
`--scene Name` · `--width/--height` · `--scale 2` · `--out file` ·
`--url http://localhost:3000` (use a running dev server) · `--no-build` · `--release`.

`--hierarchy` prints the live scene as text (`Debug.hierarchy()`): objects, components,
positions, script fields. It is an action like the others, so
`--hierarchy --click 603,466 --hierarchy` shows the scene before and after a click. Read
it first; open the PNG for what only a picture shows (colours, overlap, layout).

The tool builds with class names kept, so messages and the hierarchy are readable.
`--release` tests the fully minified build that is deployed (there your own classes
print as shortened names unless registered with `nameType`).

`--scene Frontier` opens the netcode sample.

`--eval` runs in the page and prints JSON. `synergy` is the engine API plus `engine`:

```bash
bun run screenshot --eval "JSON.stringify(synergy.Camera.main.worldToScreenPoint(new synergy.Vector3(0,0,0)))"
```

Use that to find where to click instead of guessing pixel positions.

## Reporting

State what you ran and what you saw. If something could not be verified here (PeerJS and
Convex need live services; the desktop build needs Electrobun's toolchain), say that
plainly rather than implying it was tested.
