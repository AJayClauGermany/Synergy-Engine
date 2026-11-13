# Devtools: the editor, the log and reports

Unity has an editor around the game; Synergy has the game in a page. For development
builds, `@synergy/devtools` puts the parts of Unity's editor that matter while a game runs
back around it, and writes what happens to files a person or an agent can read:

- **The editor**: Unity's default layout (Hierarchy, Game, Inspector, Console) with Play,
  Pause and Step in the toolbar. Hidden until you press <kbd>`</kbd>.
- **The log**: every console message and uncaught error, with the time, frame and game
  time of each, in `.logs/game.log`.
- **Reports**: one key saves the game view, the log, the scene as text, the HUD's text and
  a note, in one folder an agent can be pointed at.

It is the counterpart of Unity's `UnityEditor` namespace: only development builds load
it, and a release build (`bun run build`, every deploy) leaves the whole package out.

## For a person: the three keys

Run `bun run dev` and open http://localhost:3000. The game looks as it ships. Then:

| Key | What it does |
|-----|--------------|
| <kbd>`</kbd> (backquote) | Open or close the editor. It remembers which, between reloads |
| <kbd>F8</kbd> | Save a **report** to `.reports/<time>/` and `.reports/latest/`. Its path goes on the clipboard |
| <kbd>F9</kbd> | Save a **screenshot** of the game view to `.screenshots/` |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Pause or resume (Unity's Play; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> too) |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> | Step one frame |

<kbd>Cmd</kbd> works for <kbd>Ctrl</kbd> on a Mac. With the editor open, type what went
wrong in the toolbar's note box and press Enter (or **Report**): the note goes into the
report. When an error is logged while the editor is closed, a red badge in the corner
counts it; click it to open the Console.

To hand a problem to an agent: press F8 (or type a note and press Enter), then say
"look at `.reports/latest`". That is the whole hand-over.

## For an agent: the files and commands

| You want | Run or read |
|----------|-------------|
| What the person's game logged | `bun run logs` (`--errors`, `--warnings`, `--tail 50`, `--previous`), or read `.logs/game.log` |
| What the person is looking at, now | `bun run report` (`--note "..."`): asks the open page for a report and prints its summary |
| The report the person saved | `.reports/latest/summary.md` first; it lists the other files |
| The game without a person | `bun run screenshot`: its own headless browser; saves the image and, beside it, the page's log (`.screenshots/game.log`) |
| The editor in a screenshot | `bun run screenshot --devtools` (a build with the editor, opened) |
| A report from a screenshot run | `bun run screenshot --devtools --eval "synergy.editor.report('what I tested')"` |

A report folder holds:

| File | What is in it |
|------|---------------|
| `summary.md` | The note, the scenes, frame and game time, view size and renderer, counts of errors and warnings, the latest of them |
| `screenshot.png` | The game view. The Preact HUD is HTML over the canvas and is not in it; its text is in `hud.txt` |
| `log.txt` | Every console message and uncaught error since the page loaded |
| `hierarchy.txt` | `Debug.hierarchy()`: every GameObject with its components, position and script fields |
| `hud.txt` | The text the HUD showed |

A line of the log reads:

```text
[   12.345s f742 t11.20] WARN  Camera.main is null: no camera is tagged MainCamera
```

That is the seconds since the page loaded, the frame (`Time.frameCount`) and game time
(`Time.time`) when there was an engine, the level, and the message. A stack, or the rest
of a message over several lines, follows indented. A message repeated in a row is one
line with `(×N)`. `.logs/game.log` starts again on each page load, and the one before is
kept as `.logs/game.previous.log`. These folders are git-ignored.

`bun run report` needs the game open in a browser under `bun run dev`; with none open it
says so. The page keeps a socket to the dev server for this, and comes back to it when the
server restarts.

## The editor's windows

**Hierarchy.** The loaded scenes and their GameObjects. Click to select, click the arrow
to open a parent. Inactive objects are grey. The search box lists every object whose name
contains what you type.

**Inspector.** The selected GameObject: active checkbox, name, tag, layer, scene; then
each component with its enabled checkbox. The Transform shows local Position, Rotation
and Scale. A script shows its public fields (names not starting with `_`, the same rule
`instantiate` uses), labelled as Unity labels them (`moveRange` is "Move Range"):
numbers, text, booleans, vectors and colours can be edited while the game runs, and a
field that holds a GameObject or component selects it when clicked. Built-in components
(Camera, Light, Grid, Tilemap) describe themselves. An edit that does not convert is
reported in the Console and leaves the field as it was.

**Console.** Unity's buttons: **Clear**, **Collapse** (one row per distinct message),
**Error Pause** (pause the game on the frame an error is logged, with the editor open),
**Copy** (the whole log, as the file has it), a search box, and the three counters, which
also filter. Click a row to see the whole message and its stack. A message logged with a
GameObject or component, Unity's `context` argument, selects it:

```ts
Debug.log('No path to target', this.gameObject);
```

**Game.** The game, laid out in the middle. Its header shows the view size, the
renderer, the frame rate and frame number, and the **Gizmos** toggle.

**Toolbar.** Play, Pause and Step; `Time.timeScale`; the note box with **Report**;
**Screenshot**; and ✕ to close.

## Unity's editor APIs

Game code reaches the editor through the same names as in Unity. The ones in
`@synergy/engine` are safe in every build: they do nothing when no editor is attached,
as Unity's do in a player.

| Unity | Synergy | Where |
|-------|---------|-------|
| `Debug.Log(message, context)` and friends | `Debug.log(...)`, `logWarning`, `logError`, `logException(error, context)`, `assert` | engine |
| `Debug.Break()` | `Debug.break()`: pause and open the editor; nothing without one | engine |
| `Debug.isDebugBuild` | same: false in a release build, where code behind it is removed | engine |
| `Application.logMessageReceived` | `Application.logMessageReceived.addListener((condition, stackTrace, type) => ...)` | engine |
| `LogType` | same: `Error`, `Assert`, `Warning`, `Log`, `Exception` | engine |
| `Application.isEditor` | same: true while the editor is attached | engine |
| `OnDrawGizmos()`, `OnDrawGizmosSelected()` | `onDrawGizmos()`, `onDrawGizmosSelected()`: sent while the editor is open with Gizmos on | engine |
| `Gizmos.color`, `DrawLine`, `DrawRay`, `DrawWireCube`, `DrawWireSphere` | same in camelCase; `drawCube` and `drawSphere` draw the outline | engine |
| `ScreenCapture.CaptureScreenshot(name)` | `await ScreenCapture.captureScreenshot('turn-3.png')`: to `.screenshots/` with the editor, a download without | engine |
| `ScreenCapture.CaptureScreenshotAsTexture()` | `await ScreenCapture.captureScreenshotAsDataUrl()`: a PNG `data:` URL | engine |
| `EditorApplication.isPaused`, `Step()`, `pauseStateChanged` | same in camelCase; `isPlaying` is always true | devtools |
| `Selection.activeGameObject`, `activeTransform`, `selectionChanged` | same | devtools |
| `EditorPrefs.GetBool` / `SetBool` and the rest | same in camelCase; kept in the browser's localStorage | devtools |

Gizmos show what a script is thinking, in the world, without code in `update()`:

```ts
import { Color, Gizmos, MonoBehaviour } from '@synergy/engine';

export class Tower extends MonoBehaviour {
  range = 4;

  protected onDrawGizmosSelected() {
    Gizmos.color = Color.yellow;
    Gizmos.drawWireSphere(this.transform.position, this.range);
  }
}
```

They are drawn over everything, so a range on the ground is not hidden by the tiles.

Not there: Scene view (the editor shows the Game view only), edit mode (the game always
runs; Pause is the closest thing), `[SerializeField]`/`[HideInInspector]` (a leading `_`
hides a field), `[ContextMenu]`, `Handles`, and saving changes made in the Inspector back
to the code: they last until the page reloads, as Inspector edits in Unity's play mode do.

From the browser console a development build also has `synergy.editor`
(`open()`, `close()`, `report(note)`, `screenshot(name)`, `logs.text()`).

## How it is wired, and how it is left out

`game/src/main.tsx` loads the package behind a check a release build removes:

```ts sketch
const devtools = process.env.NODE_ENV !== 'production' ? await import('@synergy/devtools') : null;
devtools?.startLogCapture();                // first, so a failure while starting is logged
const engine = await Engine.create({ canvas, deviceTypes });
const editor = devtools?.attachEditor(engine, { header: `build ${buildId}` });
```

`bun run build` sets `NODE_ENV` to `production`, so the condition becomes `false`, the
`import()` is dropped and the package is not in `dist/` at all. `bun run build --devtools`
keeps it, for the screenshot tool; never deploy that build.

The capture wraps `console.log`, `info`, `warn`, `error` and `debug` (they still print as
before) and listens for uncaught errors and rejected promises, so it records PlayCanvas's
messages and the engine's `Exception in ...` reports as well as `Debug.log`. The page
sends the log to the dev server in batches; the dev server's side is
`scripts/devserver.ts`, and `scripts/screenshot.ts` answers the same requests so a
`--devtools` build works there too. Any other server answers 404 and the page stops
sending, but the editor itself still works.

## Gotchas

- **The editor is not in a release build**, so game code must not import
  `@synergy/devtools`. Use the engine's side (`Debug.break()`, `Application.isEditor`,
  gizmos), which is harmless everywhere.
- **Inspector edits are not saved.** Copy a value you like into the code.
- **The screenshot leaves out the HUD.** `hud.txt` has its text; `bun run screenshot`
  (a real browser screenshot) has both.
- **A paused game draws nothing new.** Selecting an object redraws once so its gizmos
  show; anything else waits for Play or Step.
- **The log holds 5000 entries in the page** (the Console and reports); the file keeps
  everything since the page loaded.
