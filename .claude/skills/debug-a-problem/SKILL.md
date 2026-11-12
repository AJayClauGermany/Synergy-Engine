---
name: debug-a-problem
description: >
  Finds why something in a game on this engine does not work: nothing is drawn, an object
  is missing or in the wrong place, a script does not run, a click or key does nothing,
  the HUD does not update, a test hangs or fails for no visible reason, or two players
  see different things. Use when the cause is not known yet, before changing code to try
  things, and when an error message from the engine needs reading. Not for confirming
  that a finished change works (use `verify-changes`), or for making a working thing feel
  better (use `game-feel`).
---

# Debugging a problem

Look before changing anything. This engine can print what is really in the scene, run
the real game without a browser, and stop on its own with a sentence when it is misused.
Nearly every "it does not work" is answered by one of those three in less time than a
guess takes to type.

## Workflow

1. **Read what was already said.** Run `bun run check` and read the first failure, and
   the warnings in the test output. An error thrown by the engine says what to write
   instead; a warning is the engine saying "this is probably the bug". Do that first.
2. **Print the scene.** `bun run screenshot --hierarchy` (the running game), or
   `console.log(Debug.hierarchy())` in a test. It lists every GameObject with its
   components, position, active state and the values of its scripts' fields. Most
   questions end here: the object is not there, is inactive, is at the origin, has no
   script on it, or a reference field is `null`.
3. **Say what you expected to see in that printout** and compare. The first line that
   differs is where to look. Do not look anywhere else yet.
4. **Make it small.** Reproduce it in a headless test with the fewest objects that still
   show it (`verify-changes` has the frame of the test). A bug that will not reproduce
   headless is in rendering, the HUD or the browser: that narrows it too.
5. **Ask the running game** rather than reasoning about it:
   `bun run screenshot --eval "synergy.Camera.main?.transform.position"`, or any
   expression on `synergy` (the engine API and the `engine`).
6. **Change one thing**, run the smallest check that shows the symptom, and keep the
   test you made in step 4 when it passes.

## Symptoms

Find the row; do the check before the fix.

**Nothing is drawn, or the object is not there**

| Check | Likely cause |
|-------|--------------|
| Is it in the hierarchy at all? | The scene never created it; the scene was not registered, or `?scene=` names another |
| Is it marked inactive? | It or a parent was `setActive(false)`; a prefab built it under an inactive parent |
| Position `(0, 0, 0)` or far away? | Positioned before parenting, or with `cellToWorld` (a corner) instead of `getCellCenterWorld` |
| Does it have a `MeshRenderer` *and* a `MeshFilter` with a mesh? | One without the other draws nothing; a model that has not loaded yet |
| Is there an enabled camera tagged `MainCamera`, and a light? | Every scene needs both; without a light, lit materials are close to black |
| Is the camera looking at it? | `Quaternion.euler(45, 0, 0)` looks *up* here; use `lookAt` |
| A whole tile layer missing? | Two renderers on one plane with the same `sortingOrder`, or the palette has no tile of that id (`checkTilemapData`) |
| Black where a texture should be, or an unlit colour is dark? | Colour space and unlit materials: see `extend-engine`, and compare `--renderer webgl2` |

**A script does not run**

| Check | Likely cause |
|-------|--------------|
| Is the script listed on the object in the hierarchy? | `addComponent` was never called, or on another object |
| Do its fields have the values you set? | Set after `instantiate` on the template, not the instance; a `_private` field is not copied |
| Is the method a message? | Only the names in `gameplay-scripting` are called. `tick()`, `init()`, `onStart()` are not |
| Did it throw? | An exception in a message is reported in the browser console and fails `bun run screenshot`; in a headless test it fails the test |
| A coroutine or `invoke` that stopped | Its GameObject was deactivated; they do not resume |
| Is `Time.timeScale` 0? | `update` still runs, but `Time.deltaTime` is 0, so nothing moves |

**A click or key does nothing**

| Check | Likely cause |
|-------|--------------|
| `Camera.main` in `--eval` | `null`: no camera tagged `MainCamera` (a warning says so) |
| Does the object have a Collider? | `Physics.raycast` and `onMouse*` need one; the mesh is not a collider |
| Is a HUD element over that spot? | Elements marked `data-interactive`, and all buttons and inputs, keep the click |
| Where does the click land? | Screen `y` grows downward. Find the pixel with `worldToScreenPoint` in `--eval`, then `--click x,y` |
| Is the key read in `update`? | `getKeyDown` is true for one frame only |
| Typing in an input? | Keys typed into a HUD text field are not sent to the game |

**The HUD shows an old value**

The `Observable` was changed in place, or the component read game state directly
instead of through `useObservable`. See `hud-ui`.

**Two players see different things**

| Check | Likely cause |
|-------|--------------|
| Does it happen with one player? | Then it is not a network bug |
| Commands: do both logs match? | If yes, `apply()` is not deterministic or reads something outside the state; if no, look at `check()` and who submitted what |
| Netcode: does the host's copy have the value? | A variable that is not a direct field, an RPC written as a method, an object that was never spawned |
| Only the late joiner is wrong? | State derived from something that is not replayed or replicated |

See `multiplayer` and `netcode`, "Gotchas".

**A test hangs, or the check times out**

A `while (true)` with no `yield` in a coroutine; a test awaiting a promise that never
settles (a scene builder that awaits `SceneManager.loadScene` waits for itself); or
`net.settle()` on a network where a machine keeps sending. Run the changed test files one
at a time: the one that never finishes has it.

**It works in `bun run dev` and not in the build, or the other way round**

A variable from `process.env` that is not `PUBLIC_`; an asset referenced by an absolute
URL; a class name used as data (names are shortened in the release build:
`nameType(Class, 'Name')` fixes one).

## Gotchas

- **Fixing by guessing.** Three changes later it works and nobody knows which one did
  it, or what else they broke. Print the hierarchy first.
- **Working around a guard.** The engine threw "is not a cell", "is a Vector3, which
  arrives as a plain object", "was called in a field initialiser". Catching it, casting
  to `any`-like types or adding a disable comment hides the message and keeps the bug.
  The sentence after the colon is the fix.
- **A green check taken as "it works".** The checks cannot see a picture, and a script
  that was never added to an object passes every one of them.
- **Reading a warning as noise.** The engine warns once and then stays quiet. If the
  output has a warning, it is about your change until shown otherwise.
- **Debugging in the browser what a test can show.** A headless test runs in
  milliseconds and can be stepped a frame at a time; reach for the browser for what only
  it has (rendering, the HUD, real input).
- **A `static` or module-level value from an earlier test.** It outlives the engine that
  made it. If a test passes alone and fails in the suite, look for one.
- **Blaming the engine first.** It may be wrong, and then the fix belongs in
  `packages/engine` with a test (`extend-engine`), not in a workaround in game code. But
  check the hierarchy before deciding that.

## Verify

The problem is solved when a test that failed because of it passes, not when the
symptom is gone on one run. Keep the small reproduction from step 4 as that test, run
`bun run check` to `PASSED`, and for anything visible take the screenshot again and look
at it. In the report, say what the cause was in one sentence: if you cannot, it may not
be fixed.
