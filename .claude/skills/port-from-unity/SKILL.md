---
name: port-from-unity
description: >
  Translates Unity C# into this TypeScript engine: MonoBehaviour scripts, a Unity
  tutorial, ScriptableObject data, tilemaps and NGO netcode, one script at a time with
  its test. Use when given C# or a Unity project to port, when asked how a Unity feature
  maps to Synergy, or when ported code compiles and then behaves differently from the
  original. Not for writing new gameplay from scratch (use `gameplay-scripting`), or for
  adding a Unity API the engine lacks (use `extend-engine`).
---

# Porting from Unity

The full mapping table is `docs/unity-to-synergy.md`. Read it first; this file is the
procedure and the traps for porting scripts. `docs/porting-from-unity.md` is the plan for
a whole project (what to export, what to port first).

## Procedure

1. **Check the feature exists.** Not available yet: Rigidbody and collision/trigger
   messages, Animator, AudioSource, ParticleSystem, NavMesh, uGUI Text/Button/sliced
   images. Say so up front and propose the substitute (kinematic movement with raycasts,
   PlayCanvas directly through `gameObject.entity`, the Preact HUD for interactive UI) instead of
   inventing an API.
   Available and easy to miss: `SpriteRenderer`, `Canvas`/`CanvasScaler`/`RectTransform`/`Image`,
   `Grid`/`Tilemap`/`Tile` (including Unity's hex layout),
   `Tween` for DOTween calls, seeded `Random`, grid pathfinding, `Catalog` for
   ScriptableObject data, `TilePalette` and `createTilemaps` for Tile assets and painted
   maps (`docs/content.md`; exported from Unity with `tools/unity`).
2. **Port one script at a time, with its test.** Take the scripts that others depend on
   first (data and rules before managers, managers before views). If the Unity project
   has an EditMode test for the script, port it in the same change and make it pass
   (`[Test]` → `test`, `Assert.AreEqual(expected, actual)` → `expect(actual).toBe(expected)`).
   Run `bun run fix` after each script, not after ten: one error is easy to place. It
   formats the file, applies the safe lint fixes, and runs every check; work through
   what it lists from the top until it says `PASSED`.
3. **Translate mechanically:**
   - `class X : MonoBehaviour` → `export class X extends MonoBehaviour`
   - `void Update()` → `update()`; all members camelCase
   - `public float speed = 5f;` → `speed = 5;`
   - `[SerializeField] private T x;` → `x: T | null = null;`
   - `GetComponent<T>()` → `this.getComponent(T)`
   - `IEnumerator Run() { yield return new WaitForSeconds(1); }` →
     `*run(): IEnumerator { yield new WaitForSeconds(1); }`
   - `StartCoroutine(Run())` → `this.startCoroutine(this.run())`
   - `Instantiate`/`Destroy`/`DontDestroyOnLoad` → imported functions `instantiate`/`destroy`/`dontDestroyOnLoad`
4. **Rewrite every vector expression.** No operators: `a + b * t` → `a.add(b.mul(t))`.
   `transform.position += v` → `transform.position = transform.position.add(v)`.
   `q * v` → `q.rotate(v)`; `q1 * q2` → `q1.mul(q2)`.
5. **Fix what C# did for you.** These compile and then behave differently; search the
   script for each (table: `docs/unity-to-synergy.md`, "C# to TypeScript"). The lint
   check reports the ones marked *(checked)* with what to write instead; the others no
   tool can see, so they are yours to find:
   - `/` between two ints → `Math.trunc(a / b)`. `(int)x` → `Math.trunc(x)`.
   - `Dictionary` or `HashSet` keyed by a cell or other struct → `Map`/`Set` keyed by
     `cellKey(cell)` (or another string you build). Object keys match by identity.
     *(checked where the key type is written: `Map<Vector3Int, T>`)*
   - A struct that was assigned or passed around → it is now a shared object. Copy it
     (`{ ...stats }`) wherever the C# relied on getting its own copy.
   - `list.Sort()`, `OrderBy` → `toSorted((a, b) => a.cost - b.cost)`, always with a comparer.
     *(checked)*
   - `==` between vectors or cells → `.equals`. *(checked against a constant such as
     `Vector3.zero`; `a.position == b.position` is not)*
   - A method passed as a value (`onClick.AddListener(OnClick)`, `list.Select(Score)`) →
     an arrow: `addListener(() => this.onClick())`. C# binds the method to its object;
     here `this` would be undefined. `this.invoke(this.tick, t)` is the exception: the
     engine binds it. *(checked)*
6. **Fix the conventions that differ:**
   - Literal axes: `new Vector3(0, 0, 1)` meaning "forward" → `Vector3.forward`. *(checked)*
   - Screen Y: `mousePosition.y > Screen.height - margin` meant "top edge" in Unity; here
     the top edge is `y < margin`.
   - `Physics.Raycast(ray, out var hit)` → `const hit = Physics.raycast(ray); if (hit)`.
   - `if (x != null)` on an engine object → `if (isAlive(x))`.
   - `Invoke("Name", t)` → `this.invoke(this.name, t)`.
   - `Random.Range(a, b)` → a `Random` instance you own: `random.rangeInt(a, b)`. In
     synced rules, seed it from the game state and store `random.state` back. Results
     will not match Unity's for the same seed.
   - Messages keep Unity's names in camelCase. `Update()` left as it was is a type error;
     `OnTriggerEnter`/`OnCollisionEnter` have no equivalent yet, and `onStart()` is not a
     message at all. *(all checked)*
   - Two classes that use each other (every Unity project has them) → two files that
     import each other, which is an import cycle here. Use `import type` on the side that
     needs only the type, or move what both need into a third file. *(checked)*
   - `tilemap.BoxFill(position, tile, x0, y0, x1, y1)` → `tilemap.boxFill(tile, min, max)`.
   - `transform.DOMove(p, t).SetEase(Ease.OutQuad)` → `Tween.move(transform, p, t).setEase(Ease.OutQuad)`.
   - `tilemap.SetTile(new Vector3Int(x, y, 0), tile)` → `tilemap.setTile({ x, y }, tile)`.
     Hex cell coordinates are the same as Unity's.
   - Mouse buttons keep Unity's numbering (1 is right).
   - Positions, directions, angles and screen coordinates port unchanged: the API uses
     Unity's left-handed axes (forward is +Z), Euler order (Z, X, Y), rotation signs,
     bottom-left screen origin and mesh winding. `new Vector3(h, 0, v)` from the input
     axes walks forward, as in Unity. Only code that reaches into PlayCanvas
     (`gameObject.entity`, `engine.app`) sees its mirrored space.
   - `transform.eulerAngles` reads back in [0, 360) as in Unity, so the same caveat holds:
     reading, adding and writing back can jump. Keep the angle in a field, or use
     `transform.rotate`.
   - `IEnumerator Start()` → `*start(): IEnumerator`: it runs as a coroutine here too.
   - `Mathf.SmoothDamp(a, b, ref v, t)` → `[a, v] = Mathf.smoothDamp(a, b, v, t, Infinity, Time.deltaTime)`.
   - `list.Remove(x)` → `const i = list.indexOf(x); if (i >= 0) list.splice(i, 1);`
     (`splice(-1, 1)` deletes the last item).
   - `x.Changed -= Handler` → call what `addListener` returned; a new arrow given to
     `removeListener` removes nothing. *(checked)*
7. **Replace editor work with code, and editor data with files.** Inspector references
   become assignments in the scene builder; prefabs become `new Prefab(...)`; scenes
   become `SceneBuilder`s; tags are plain strings; layers are named with
   `LayerMask.define`. ScriptableObject assets, Tile assets and painted Tilemaps are
   data: export them (`tools/unity`) and load them (`Catalog`, `TilePalette`,
   `createTilemaps`) rather than retyping them as code. A reference to a ScriptableObject
   becomes its id: `unitTypes.get(this.typeId)`.
8. **Netcode scripts** (`NetworkBehaviour`, `NetworkVariable`, `[ServerRpc]`) keep their
   shape: see the `netcode` skill and the map in `docs/netcode.md`. Attributes become
   fields (`readonly moveRpc = this.serverRpc(...)`), and setup moves from `Awake` to
   `onNetworkSpawn`.
9. **Verify** with `bun run check` (it must say `PASSED`), and a headless test or
   screenshot. A ported file that no test and no other file imports is reported as
   unused: that is the reminder to write its test. If an object is
   missing or a reference is `null`, print `Debug.hierarchy()` before changing code.

## Worked example

```csharp
public class Mover : MonoBehaviour {
    public float speed = 3f;
    public Transform target;
    void Update() {
        if (target == null) return;
        var dir = (target.position - transform.position).normalized;
        transform.position += dir * speed * Time.deltaTime;
        transform.rotation = Quaternion.LookRotation(dir);
    }
}
```

```ts
import { isAlive, MonoBehaviour, Quaternion, Time, type Transform } from '@synergy/engine';

export class Mover extends MonoBehaviour {
  speed = 3;
  target: Transform | null = null;

  update() {
    if (!isAlive(this.target)) return;
    const dir = this.target.position.sub(this.transform.position).normalized;
    this.transform.position = this.transform.position.add(dir.mul(this.speed * Time.deltaTime));
    if (dir.sqrMagnitude > 0) this.transform.rotation = Quaternion.lookRotation(dir);
  }
}
```

And its test, `game/test/mover.test.ts`. A script needs no scene to be tested: make the
objects, step the engine, look at the result.

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine, GameObject, Vector3 } from '@synergy/engine';
import { Mover } from '../src/behaviours/Mover';

let engine: Engine;
beforeEach(() => {
  engine = Engine.createHeadless();
});
afterEach(() => {
  engine.dispose();
});

test('the mover walks toward its target and faces it', () => {
  const mover = new GameObject('Mover').addComponent(Mover);
  const target = new GameObject('Target');
  target.transform.position = new Vector3(10, 0, 0);
  mover.target = target.transform;

  engine.stepSeconds(1); // one simulated second at speed 3
  expect(mover.transform.position.x).toBeCloseTo(3);
  expect(mover.transform.forward.equals(Vector3.right, 1e-4)).toBe(true);
});
```

## When the mapping is unclear

Look at the engine source rather than guessing: every public class in
`packages/engine/src` has a doc comment stating its Unity counterpart and any deviation.
If an API is missing and small, add it (see the `extend-engine` skill) rather than
working around it in game code.

## Gotchas

What a port gets wrong after it compiles. The first group is reported by `bun run check`
or by an error when the code runs; the second no tool can see.

Reported, with what to write instead:

- **A method that is never called**: `OnTriggerEnter`, `onStart`, `OnPointerClick`,
  `OnValidate`. There are no triggers, uGUI events or editor messages.
- **A unit on a cell that equals no cell**: `new Vector3Int(x / 2, y, 0)`. C# cut the
  division to a whole number; here it is 3.5, and the vector refuses it.
- **A tile lookup that finds nothing**: `tilemap.GetTile(transform.position)` was a
  compile error in C#; here a world position has `x` and `y`, so it compiles, and throws.
- **The same dice every game**: `new Random()` needs a seed, and a whole number.
- **An index that is not a whole number**: `list[random.range(0, list.length)]`.
  `Random.Range(int, int)` is `rangeInt`; or `random.pick(list)`.
- **A vector that did not move**: `transform.position.add(v);` with the result dropped.
- **A value the HUD never shows**: `inventory.value.items.push(x)`. Observables and
  NetworkVariables hold read-only values; assign a new one.
- **`[ServerRpc] void FireServerRpc()` as a method**: an RPC is a field,
  `readonly fireRpc = this.serverRpc(...)`.

Not reported: yours to find.

- **The camera looks at the sky**, or a unit turns left for right: pitch and yaw signs
  (step 6).
- **`if (target != null)`** on a destroyed object is still true. Search the port for
  `!= null` and `== null` on anything that can be destroyed: `isAlive(target)`.
- **`a == b` between two vectors or cells that are not constants.** Always false.
- **`mousePosition.y`** compared with the screen height: the origin is the top left.
- **A struct that was copied by assignment** is now one shared object.
- **Execution order.** Unity's Script Execution Order settings do not exist: wire things
  between objects in `start`, which runs after every `awake`.
- **A `static` field that survived "play mode"** in Unity is reset there on each run;
  here it lives as long as the page, across scene loads and across tests.

## Verify

Per script, as you go: `bun run fix` until it says `PASSED`, with the script's test in
the same change. A ported file that nothing imports and no test covers is reported as
unused, which is the reminder to write the test.

For the port as a whole: every Unity EditMode test has a counterpart that passes; then
`bun run screenshot` of each ported scene, compared by eye with a screenshot from Unity,
looking first at what the list above says no tool sees (which way things face, which way
the camera tilts, which side "up" is on the screen). Say which scenes you compared and
which you could not.
