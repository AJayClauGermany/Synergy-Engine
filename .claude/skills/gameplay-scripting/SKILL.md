---
name: gameplay-scripting
description: Use when writing or changing gameplay code in this repo - MonoBehaviour scripts, scenes, prefabs, input handling, coroutines, raycast picking, or HUD bindings under game/src.
---

# Gameplay scripting

Game code lives in `game/src` and imports from `@synergy/engine`. The API is Unity's,
in camelCase. Skim `docs/unity-to-synergy.md` if you have not this session.

## Checklist before writing

- Behaviours: one class per file in `game/src/behaviours/`, extending `MonoBehaviour`.
- State that must stay in sync across players does not belong in a behaviour. Put it in
  `game/src/rules/` and change it only through commands (see the `multiplayer` skill).
- Behaviours that only show state ("views") should not contain rules.

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

  awake() { /* get components, no cross-object assumptions */ }
  start() { /* other objects are awake now */ }

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

Mouse picking (top-left screen coordinates, hit or `null`):

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

## HUD

Game code writes an `Observable` (`game/src/hud.ts`); React reads it with
`useObservable`. HUD buttons call methods on a behaviour, usually through a singleton
(`GameController.instance?.endTurn()`). Use `<WorldAnchor target={gameObject}>` for
labels that follow objects.

## Gotchas

- A message with the wrong name or case (`Update`, `onStart`) is never called and nothing
  warns you. The valid names are: awake, onEnable, start, update, lateUpdate, fixedUpdate,
  onDisable, onDestroy, onMouseDown, onMouseUp, onMouseEnter, onMouseOver, onMouseExit.
- `this.startCoroutine(this.run())`: call the generator. Passing `this.run` throws.
- `Vector3.forward` is `(0, 0, -1)`. Do not hard-code axes.
- Lights aim along -Y; set `light.direction`.
- An object needs a Collider to be hit by `Physics.raycast` or to get `onMouse*`.
- `GameObject.find` and `findObjectOfType` walk the scene: call them in `start`, cache
  the result.
- `transform.translate(v)` moves in world units along the object's own axes;
  `translate(v, Space.World)` along world axes.
- `instantiate` copies a script's public fields (deep-copying arrays and object
  literals) but not functions, events or `_private` fields.

## Finish

Run `bun run check`. For behaviour changes add a headless test or take a screenshot (see
the `verify-changes` skill).
