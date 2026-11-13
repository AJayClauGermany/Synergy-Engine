---
name: gameplay-scripting
description: >
  Writes and changes gameplay code on this engine: MonoBehaviour scripts, scenes, prefabs,
  input handling, coroutines, tweens and raycast picking under game/src. Use when adding
  or changing a behaviour, a scene or a prefab, reading the keyboard or mouse, or starting
  a new mechanic. Not for maps and grids (use `tile-maps`), the HUD (use `hud-ui`), state
  shared between players (use `multiplayer` or `netcode`), Unity code to translate (use
  `port-from-unity`), or a script that will not run and you cannot see why (use
  `debug-a-problem`).
---

# Gameplay scripting

Game code lives in `game/src` and imports from `@synergy/engine`. The API is Unity's,
in camelCase. Skim `docs/unity-to-synergy.md` if you have not this session.

## Checklist before writing

- Behaviours: one class per file in `game/src/behaviours/`, extending `MonoBehaviour`.
- State that must stay in sync across players: check which model the game uses (AGENTS.md,
  "Decide how shared state works"). With commands it does not belong in a behaviour: put
  it in `game/src/rules/` and change it only through commands (`multiplayer` skill). With
  netcode it lives in `NetworkVariable`s on a `NetworkBehaviour` and only the host
  changes it (`netcode` skill).
- Behaviours that only show state ("views") should not contain rules.
- Numbers that describe content (a unit's health, a tile's movement cost) go in data, not
  in a behaviour's fields: a `Catalog` or a tile's `data` (`docs/content.md`).

## Patterns

```ts
import {
  Camera, Input, KeyCode, MonoBehaviour, Physics, Time, Vector3,
  WaitForSeconds, destroy, instantiate, isAlive, type IEnumerator,
} from '@synergy/engine';

export class Turret extends MonoBehaviour {
  range = 6;                      // public field = tweakable value
  target: Enemy | null = null;    // references to other objects are fine
  private _cooldown = 0;          // leading underscore: not copied by instantiate()

  awake() { /* get components here, not in a field: `x = this.getComponent(Y)` throws */ }
  start() { /* other objects are awake now. `*start(): IEnumerator` runs as a coroutine */ }

  update() {
    if (!isAlive(this.target)) return;            // never `!= null` for destroyed checks
    this.transform.lookAt(this.target.transform);
    this._cooldown -= Time.deltaTime;
    if (this._cooldown <= 0) this.startCoroutine(this.fire());
  }

  *fire(): IEnumerator {
    this._cooldown = 1;
    yield new WaitForSeconds(0.2);
    // ...
  }
}
```

Mouse picking (Unity's bottom-left screen coordinates, hit or `null`):

```ts
const camera = Camera.main;
if (camera && Input.getMouseButtonDown(0)) {  // 0 left, 1 right, 2 middle
  const hit = Physics.raycast(camera.screenPointToRay(Input.mousePosition));
  if (hit) select(hit.gameObject);
}
```

Mouse to ground point without a collider:
`new Plane(Vector3.up, Vector3.zero).raycast(ray)` returns the distance or `null`.

Moving things: `transform.position = Vector3.moveTowards(a, b, speed * Time.deltaTime)`.
Vectors are immutable; assign the result back.

One-off animation without writing an update loop:

```ts
Tween.move(this.transform, target, 0.3).setEase(Ease.OutCubic).onComplete(() => this.arrived());
yield Tween.scale(this.transform, Vector3.one.mul(1.2), 0.1).setLoops(2, LoopType.Yoyo);  // in a coroutine
```

Maps, grids, hex tiles, cell picking and pathfinding have their own skill: `tile-maps`.

## Scenes and prefabs

A scene is a `SceneBuilder` function registered in `game/src/main.tsx`. Inside it (and
inside a `Prefab` build function) `awake` is deferred until the function returns, so you
can create objects and wire references in any order:

```ts
const controller = new GameObject('Game Controller').addComponent(GameController);
controller.board = board;   // visible in controller.awake()
```

Outside those functions `addComponent` runs `awake` immediately, as in Unity.

## Starting a new mechanic

Build the smallest thing that can be played, in a scene of its own, before anything
around it:

1. Write down the one question it must answer ("is dragging units along a path fun?").
2. A new scene (`SceneManager.register('Sketch', build)`, opened with `?scene=Sketch` or
   `bun run screenshot --scene Sketch`) with a camera tagged `MainCamera`, a light, and
   primitives: `GameObject.createPrimitive(PrimitiveType.Cube)`. No art, no menus, no saves.
3. The numbers being judged are public fields at the top of the script, so a retune is
   one line; show them in the HUD while you tune.
4. A headless test for the rule at its centre, then ask the user to play it and say
   whether to keep it. Only then build what surrounds it.

## HUD

The HUD is **Preact, not React**, and has its own skill: `hud-ui`. Game code writes an
`Observable` (`game/src/hud.ts`); components read it with `useObservable`; buttons call
methods on a behaviour (`GameController.instance?.endTurn()`).

## Gotchas

Most of these are caught for you: by the type checker, by `bun run check`, or by an error
whose message says what to write. They are here so the message makes sense when it comes.

- **A method the engine never calls.** The messages are: awake, onEnable, start, update,
  lateUpdate, fixedUpdate, onDisable, onDestroy, onMouseDown, onMouseUp, onMouseEnter,
  onMouseOver, onMouseExit. Unity's spelling (`Update`) is a type error. A near miss
  (`onStart`) or a Unity message that is not sent (`onTriggerEnter`, `onPointerClick`)
  fails lint. Any other name (`tick`, `init`) is just a method: nothing calls it.
- **`*update()` or `async update()`** is a type error: a message returns nothing. Only
  `*start()` and the mouse messages may be coroutines, as in Unity. From anywhere else:
  `this.startCoroutine(this.run())`, calling the generator (passing `this.run` throws).
- **A line that does nothing.** `this.transform.position.add(step);` computes a new
  vector and drops it. Assign it: `transform.position = transform.position.add(step)`.
- **A turn that jumps.** Axes and angles are Unity's (`Quaternion.euler(45, 0, 0)` looks
  down, a positive yaw turns right), and so is `eulerAngles` reading back in [0, 360):
  keep a turning angle in a field of your own rather than reading `eulerAngles` back and
  adding to it. Aim with `transform.lookAt` or `Quaternion.lookRotation` where you can.
- **Numbers read from `gameObject.entity`** (PlayCanvas) are in its right-handed space:
  Z is negated. Use `transform` instead.
- **A field that looks up a component** (`private body = this.getComponent(MeshRenderer)`)
  throws: fields are set before the other components exist. Do it in `awake`.
- **Clicks do nothing.** The object needs a Collider to be hit by `Physics.raycast` or to
  get `onMouse*`, and the scene needs a camera tagged exactly `MainCamera` (a warning
  says so when one is enabled without the tag). Colliders are not registered until
  `awake` has run, so a raycast inside the scene builder itself finds nothing.
- **A prefab whose instances are empty.** The build function is given the instance and
  adds to it: `new Prefab('Enemy', (go) => { go.addComponent(...) })`. One that makes and
  returns its own `new GameObject` is refused.
- **A listener that will not go away.** `event.removeListener(() => this.onHit())`
  removes nothing: a new arrow is a new function. Keep what `addListener` returned and
  call it, or declare the handler as a field (`onHit = () => { ... }`).
- **A private field that stops the script.** Name private fields with a leading
  underscore (they are then not copied by `instantiate`), but not with a name the engine
  uses itself (`_started`, `_enabled`, `_destroy`, ...): lint lists them.
- **A coroutine or `invoke` that stops by itself.** Both end when the GameObject is
  deactivated, and are not resumed when it comes back. Restart them in `onEnable`.
- **`Tween.to(...)` after its object is gone.** `Tween.move/scale/rotate` end with their
  object; a bare `Tween.to` does not: add `.setTarget(this.gameObject)`.
- Lights shine along `transform.forward`, as in Unity; `light.direction = ...` aims one directly.
- `GameObject.find` and `findObjectOfType` walk the scene: call them in `start`, cache
  the result.
- `transform.translate(v)` moves along the object's own axes; `translate(v, Space.World)`
  along world axes.
- `instantiate` copies a script's public fields (deep-copying arrays and object
  literals) but not functions, events, Maps, Sets or `_private` fields; class instances
  other than vectors are shared between the original and the copy.
- `Input.mousePosition` is `(0, 0)` until the pointer has been over the game:
  `Input.mousePresent` says whether it has.

## When something does not show up or does not move

Print the scene before changing code: `console.log(Debug.hierarchy())` in a test, or
`bun run screenshot --hierarchy`. It answers the usual questions at a glance: was the
object created, is it inactive, where is it, is the script on it, is the reference field
still `null`, what value does the field really have.

## Finish

Run `bun run fix` (formats, applies safe lint fixes, then runs every check) until it says
`PASSED`. For behaviour changes add a headless test or take a screenshot (see the
`verify-changes` skill).
