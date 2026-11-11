---
name: port-from-unity
description: Use when translating Unity C# scripts, Unity tutorials, or Unity-style designs into this TypeScript engine, or when asked how a Unity feature maps to Synergy.
---

# Porting from Unity

The full mapping table is `docs/unity-to-synergy.md`. Read it first; this file is the
procedure and the traps.

## Procedure

1. **Check the feature exists.** Not available yet: Rigidbody and collision/trigger
   messages, Animator, AudioSource, ParticleSystem, NavMesh, uGUI Text/Button/sliced
   images. Say so up front and propose the substitute (kinematic movement with raycasts,
   PlayCanvas directly through `gameObject.entity`, React for interactive UI) instead of
   inventing an API.
   Available and easy to miss: `SpriteRenderer`, `Canvas`/`CanvasScaler`/`RectTransform`/`Image`,
   `Grid`/`Tilemap`/`Tile` (including Unity's hex layout),
   `Tween` for DOTween calls, seeded `Random`, grid pathfinding. `docs/porting-notes.md`
   maps the original Unity project's packages one by one.
2. **Port one script at a time, with its test.** Take the scripts that others depend on
   first (data and rules before managers, managers before views). If the Unity project
   has an EditMode test for the script, port it in the same change and make it pass
   (`[Test]` → `test`, `Assert.AreEqual(expected, actual)` → `expect(actual).toBe(expected)`).
   Run `bun run check` after each script, not after ten: one error is easy to place.
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
   script for each (table: `docs/unity-to-synergy.md`, "C# to TypeScript"):
   - `/` between two ints → `Math.trunc(a / b)`. `(int)x` → `Math.trunc(x)`.
   - `Dictionary` or `HashSet` keyed by a cell or other struct → `Map`/`Set` keyed by
     `cellKey(cell)` (or another string you build). Object keys match by identity.
   - A struct that was assigned or passed around → it is now a shared object. Copy it
     (`{ ...stats }`) wherever the C# relied on getting its own copy.
   - `list.Sort()`, `OrderBy` → `toSorted((a, b) => a.cost - b.cost)`, always with a comparer.
   - `==` between vectors or cells → `.equals`.
6. **Fix the conventions that differ:**
   - Literal axes: `new Vector3(0, 0, 1)` meaning "forward" → `Vector3.forward`.
   - Screen Y: `mousePosition.y > Screen.height - margin` meant "top edge" in Unity; here
     the top edge is `y < margin`.
   - `Physics.Raycast(ray, out var hit)` → `const hit = Physics.raycast(ray); if (hit)`.
   - `if (x != null)` on an engine object → `if (isAlive(x))`.
   - `Invoke("Name", t)` → `this.invoke(this.name, t)`.
   - `Random.Range(a, b)` → a `Random` instance you own: `random.rangeInt(a, b)`. In
     synced rules, seed it from the game state and store `random.state` back. Results
     will not match Unity's for the same seed.
   - Messages keep Unity's names in camelCase. `Update()` left as it was is a type error;
     `OnTriggerEnter`/`OnCollisionEnter` have no equivalent yet and are warned about.
   - `tilemap.BoxFill(position, tile, x0, y0, x1, y1)` → `tilemap.boxFill(tile, min, max)`.
   - `transform.DOMove(p, t).SetEase(Ease.OutQuad)` → `Tween.move(transform, p, t).setEase(Ease.OutQuad)`.
   - `tilemap.SetTile(new Vector3Int(x, y, 0), tile)` → `tilemap.setTile({ x, y }, tile)`.
     Hex cell coordinates are the same as Unity's.
   - Mouse buttons keep Unity's numbering (1 is right).
   - Rotation signs: positive rotation about Y turns counter-clockwise seen from above
     (right-handed), the opposite of Unity. Prefer `lookAt` / `Quaternion.lookRotation`
     over hand-written angles.
7. **Replace editor work with code.** Inspector references become assignments in the
   scene builder; prefabs become `new Prefab(...)`; scenes become `SceneBuilder`s; tags
   are plain strings; layers are named with `LayerMask.define`.
8. **Netcode scripts** (`NetworkBehaviour`, `NetworkVariable`, `[ServerRpc]`) keep their
   shape: see the `netcode` skill and the map in `docs/netcode.md`. Attributes become
   fields (`readonly moveRpc = this.serverRpc(...)`), and setup moves from `Awake` to
   `onNetworkSpawn`.
9. **Verify** with `bun run check`, and a headless test or screenshot. If an object is
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

## When the mapping is unclear

Look at the engine source rather than guessing: every public class in
`packages/engine/src` has a doc comment stating its Unity counterpart and any deviation.
If an API is missing and small, add it (see the `extend-engine` skill) rather than
working around it in game code.
