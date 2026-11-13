---
name: verify-changes
description: >
  Verifies a change to game or engine code at three levels: the automatic checks (format,
  lint, types, tests, the guides against the code, the project graph), headless tests that
  run real scenes with simulated input and simulated networks, and screenshots of the
  running game. Use when a change is finished and before reporting it as done, when
  asked to test, check or prove something works, or when writing a test for a behaviour.
  Not for finding out why something is broken (use `debug-a-problem`), or for deploying
  (use `ship-it`).
---

# Verifying changes

Three levels, cheapest first. Do the ones that apply; say which you did.

## 1. `bun run check` (always)

Seven checks in a few seconds: the lockfile, formatting, lint, types, every test, the
guides against the code (a sample in `docs/` or a skill that no longer compiles), and the
project graph (unused files, undeclared packages, import cycles, layering). It prints
each failure with a "What to do", one line per check, and `PASSED` or `FAILED`.

```bash
bun run fix     # apply what a tool can fix (lint fixes, formatting), then run the checks
bun run check   # the checks only; `bun run check lint types` runs the ones you name
```

Only a run of all of them ends with `PASSED`. A run of some ends with `OK so far` and
the names of the checks it left out: that is not a finished change.

The loop: change one thing, `bun run fix`, read the **first** failure, fix that, repeat.
Do not fix a failure by skipping a test, switching a rule off, or adding a disable
comment without a real reason; `docs/checks.md` explains every rule and what to write
instead.

The checks know the usual Unity mistakes (`==` on vectors, `Map<Vector3Int, T>`,
`onStart()`, `this.method` passed without its `this`, `Update()`), but they cannot know
what the game should do, or that a script was never added to an object. So for behaviour
changes also do 2 or 3.

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
One test: add `-t "part of its name"`. `bun run coverage` lists, per file, the lines no
test reached: use it to see what the test of a new script misses.

## 3. Screenshots (anything visual)

```bash
bun run screenshot
```

Builds, serves `dist/`, opens headless Chromium with software WebGL, waits for the scene,
saves `.screenshots/game.png` with the page's log beside it (`.screenshots/game.log`),
and exits 1 if the page logged an error. Then **look at the image** with the Read tool,
and read the log when something did not happen: a `Debug.log` you expected is missing,
or a warning says why. `--devtools` takes the picture with the editor open (Hierarchy,
Inspector, Console), which shows the scene and the log in one image.

Drive the game first, in order:

```bash
bun run screenshot --click 603,466 --click 606,365 --wait 700 --out .screenshots/moved.png
```

Options: `--click x,y` · `--key Space` · `--wait ms` · `--eval "<js>"` · `--hierarchy` · `--renderer webgl2` ·
`--scene Name` · `--width/--height` · `--scale 2` · `--out file` ·
`--url http://localhost:3000` (use a running dev server) · `--no-build` · `--release`.

`--hierarchy` prints the live scene as text (`Debug.hierarchy()`): objects, components,
positions, script fields. It is an action like the others, so
`--hierarchy --click 603,466 --hierarchy` shows the scene before and after a click. Read
it first; open the PNG for what only a picture shows (colours, overlap, layout).

The tool builds with class names kept, so messages and the hierarchy are readable. Two
cases where a game class prints under another name (engine classes never do): with
`--url` against `bun run dev`, the dev bundler may add a number (`CameraRig3` is
`CameraRig`); with `--release`, the fully minified build that is deployed, names are
shortened. `nameType(CameraRig, 'CameraRig')` after a class fixes its name everywhere.

`--scene Frontier` opens the netcode sample.

The game renders with WebGPU where it can and WebGL2 otherwise, and the tool runs
Chromium with software WebGPU, so a screenshot uses WebGPU; the `Saved` line names the
device. For a rendering change, also check `--renderer webgl2`, the path players get
on Linux and older macOS.

`--eval` runs in the page and prints JSON. `synergy` is the engine API plus `engine`:

```bash
bun run screenshot --eval "JSON.stringify(synergy.Camera.main.worldToScreenPoint(new synergy.Vector3(0,0,0)))"
```

Use that to find where to click instead of guessing pixel positions.

## Gotchas

- **`OK so far` is not `PASSED`.** `bun run check lint types` skips the tests and the
  rest. Run `bun run check` with no names before calling anything done.
- **`NOT RUN` on the test line.** A test that was skipped or left as a todo checked
  nothing. `test.skip`, `test.only`, `test.failing` and a `test.todo` with a body fail
  lint; find the test and make it run.
- **A test that passes whatever the code does.** `expect(x);` with no matcher compares
  nothing (it is what `Assert.IsTrue(x)` becomes when ported word for word). Lint reports
  it; write `expect(x).toBe(true)`.
- **`engine.stepSeconds(1)` throws while the game is paused.** It counts game time, and
  at `Time.timeScale = 0` none passes. Use `engine.stepFrames(n)`.
- **A key press that presses nothing.** `engine.input.pressKey` takes a `KeyCode`
  (`KeyCode.W`), not a letter; `'w'` is a type error.
- **An input "down" read after the step.** `getKeyDown` and `getMouseButtonDown` are true
  for one frame: read them inside a behaviour's `update`, or assert on what the
  behaviour did.
- **The test only looked at the host.** With `TestNetwork`, assert on a client's copy
  too; the host has the original objects and would pass with values that never arrived.
  (Values JSON cannot carry are refused when sent, so a test does see those.)
- **A warning in the test output.** The engine warns once about a camera with no
  `MainCamera` tag, a prefab that builds nothing, an Observable given back the object it
  already held. Tests still pass; read the output.
- **A screenshot of the wrong scene.** `--scene Name` with a name nobody registered now
  fails with the list of scenes, where it used to show the default one.
- **Software rendering is slow, not broken.** A screenshot run takes tens of seconds;
  wait for it rather than starting another.
- **Guards are not obstacles.** When the engine throws with a sentence about what to
  write instead, do that. Catching the error, casting the type away or disabling the
  rule puts the original bug back.

## Reporting

State what you ran and what you saw. If something could not be verified here (PeerJS and
Convex need live services; the desktop build needs Electrobun's toolchain), say that
plainly rather than implying it was tested.
