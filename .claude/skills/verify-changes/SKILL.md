---
name: verify-changes
description: Use after changing game or engine code, and before reporting work as done, to verify it with the type-checker, headless tests, and browser screenshots.
---

# Verifying changes

Three levels, cheapest first. Do the ones that apply; say which you did.

## 1. `bun run check` (always)

Type-checks the app, Convex functions and the Cloudflare Worker, then runs every test
(about a second). It must pass.

Type-checking has blind spots here: a lifecycle message with the wrong name
(`Update`, `onStart`) compiles and is never called. So for behaviour changes also do 2 or 3.

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
- Pure rules (`game/src/rules`) need no engine at all; test them directly.

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

Options: `--click x,y` · `--key Space` · `--wait ms` · `--eval "<js>"` · `--scene Name` ·
`--width/--height` · `--scale 2` · `--out file` · `--url http://localhost:3000` (use a running dev
server) · `--no-build`.

`--eval` runs in the page and prints JSON. `synergy` is the engine API plus `engine`:

```bash
bun run screenshot --eval "JSON.stringify(synergy.Camera.main.worldToScreenPoint(new synergy.Vector3(0,0,0)))"
```

Use that to find where to click instead of guessing pixel positions.

## Reporting

State what you ran and what you saw. If something could not be verified here (PeerJS and
Convex need live services; the desktop build needs Electrobun's toolchain), say that
plainly rather than implying it was tested.
