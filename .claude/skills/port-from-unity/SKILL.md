---
name: port-from-unity
description: Use when translating Unity C# scripts, Unity tutorials, or Unity-style designs into this TypeScript engine, or when asked how a Unity feature maps to Synergy.
---

# Porting from Unity

The full mapping table is `docs/unity-to-synergy.md`. Read it first; this file is the
procedure and the traps.

## Procedure

1. **Check the feature exists.** Not available yet: Rigidbody and collision/trigger
   messages, Animator, AudioSource, ParticleSystem, NavMesh, uGUI. Say so up front and
   propose the substitute (kinematic movement with raycasts, PlayCanvas directly through
   `gameObject.entity`, React for UI) instead of inventing an API.
2. **Translate mechanically:**
   - `class X : MonoBehaviour` → `export class X extends MonoBehaviour`
   - `void Update()` → `update()`; all members camelCase
   - `public float speed = 5f;` → `speed = 5;`
   - `[SerializeField] private T x;` → `x: T | null = null;`
   - `GetComponent<T>()` → `this.getComponent(T)`
   - `IEnumerator Run() { yield return new WaitForSeconds(1); }` →
     `*run(): IEnumerator { yield new WaitForSeconds(1); }`
   - `StartCoroutine(Run())` → `this.startCoroutine(this.run())`
   - `Instantiate`/`Destroy`/`DontDestroyOnLoad` → imported functions `instantiate`/`destroy`/`dontDestroyOnLoad`
3. **Rewrite every vector expression.** No operators: `a + b * t` → `a.add(b.mul(t))`.
   `transform.position += v` → `transform.position = transform.position.add(v)`.
   `q * v` → `q.rotate(v)`; `q1 * q2` → `q1.mul(q2)`.
4. **Fix the conventions that differ:**
   - Literal axes: `new Vector3(0, 0, 1)` meaning "forward" → `Vector3.forward`.
   - Screen Y: `mousePosition.y > Screen.height - margin` meant "top edge" in Unity; here
     the top edge is `y < margin`.
   - `Physics.Raycast(ray, out var hit)` → `const hit = Physics.raycast(ray); if (hit)`.
   - `if (x != null)` on an engine object → `if (isAlive(x))`.
   - `Invoke("Name", t)` → `this.invoke(this.name, t)`.
   - Mouse buttons keep Unity's numbering (1 is right).
   - Rotation signs: positive rotation about Y turns counter-clockwise seen from above
     (right-handed), the opposite of Unity. Prefer `lookAt` / `Quaternion.lookRotation`
     over hand-written angles.
5. **Replace editor work with code.** Inspector references become assignments in the
   scene builder; prefabs become `new Prefab(...)`; scenes become `SceneBuilder`s; tags
   are plain strings; layers are named with `LayerMask.define`.
6. **Verify** with `bun run check`, and a headless test or screenshot.

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
