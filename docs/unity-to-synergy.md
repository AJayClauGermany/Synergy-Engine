# Unity to Synergy

Synergy keeps Unity's concepts and names. If you know `GameObject`, `MonoBehaviour`,
`Transform` and `Time.deltaTime`, you already know most of this API. This page lists what
maps one to one, and (more importantly) the places where it deliberately differs. For the
order in which to bring a whole project across, see [porting-from-unity.md](porting-from-unity.md).

Everything is imported from `@synergy/engine`.

## The same script in both

```csharp
// Unity
public class Spinner : MonoBehaviour {
    public float speed = 90f;
    void Update() {
        transform.Rotate(Vector3.up, speed * Time.deltaTime);
        if (Input.GetKeyDown(KeyCode.Space)) Destroy(gameObject);
    }
}
```

```ts
// Synergy
export class Spinner extends MonoBehaviour {
  speed = 90;
  update() {
    this.transform.rotate(Vector3.up, this.speed * Time.deltaTime);
    if (Input.getKeyDown(KeyCode.Space)) destroy(this.gameObject);
  }
}
```

## The differences that matter

| # | Unity | Synergy | Why |
|---|-------|---------|-----|
| 1 | `PascalCase` methods: `Update()`, `GetComponent<T>()` | `camelCase`: `update()`, `getComponent(T)` | TypeScript convention. Properties were already camelCase in Unity. A message left in Unity's spelling is a type error, and an error when the script is added. |
| 2 | Generics: `GetComponent<Health>()` | Pass the class: `getComponent(Health)` | Types do not exist at runtime in TypeScript. |
| 3 | Operators: `a + b`, `v * 2`, `q * v` | Methods: `a.add(b)`, `v.mul(2)`, `q.rotate(v)` | No operator overloading. See the table below. |
| 4 | `Vector3` is a mutable struct | `Vector3`, `Quaternion`, `Color` are **immutable**; every operation returns a new value | Gives struct-like value semantics. `transform.position.x = 5` is a compile error in both. |
| 5 | Screen units are device pixels | **CSS pixels** (origin bottom-left, y up, as in Unity) | `Input.mousePosition`, `Camera.worldToScreenPoint` and `Screen.width` share the unit, so fractions of the screen work as in Unity. HTML over the game measures y from the top: `top = Screen.height - y` (`WorldAnchor` does it). |
| 6 | The scripting API and the renderer share one space | **Unity's space outside, PlayCanvas's inside** | Everything in this API is Unity's: left-handed, `forward` = (0, 0, 1), Euler Z-X-Y, positive yaw turns right. PlayCanvas, underneath, is right-handed with -Z forward; the engine mirrors Z at the boundary. Only the escape hatches (`gameObject.entity`, `engine.app`, `pcCamera`, ...) show PlayCanvas's numbers: there Z is negated and rotations are `(-x, -y, z, w)`. |
| 7 | `Physics.Raycast(ray, out hit)` returns bool | `Physics.raycast(ray)` returns the hit or `null` | No `out` parameters. |
| 8 | `if (target != null)` is false for destroyed objects | `if (isAlive(target))` | `==` cannot be overloaded. |
| 9 | Scenes and prefabs are assets made in the editor | Scenes and prefabs are **functions** (`SceneManager.register`, `new Prefab`) | The editor ([devtools.md](devtools.md)) inspects a running game; it does not author scenes. Code is easy to diff and generate. |
| 10 | `Light` has no direction property | `light.direction = v` turns the light to shine along `v` | A convenience; lights shine along `transform.forward` as in Unity. |
| 11 | glTF importers flip the model into Unity's space | `Assets.loadModel` turns the model's nodes 180 degrees about Y | The model faces `forward` with its handedness intact, as with Unity's importers, but the local rotations of its inner nodes differ. Place and turn the root. |
| 12 | `meshFilter.mesh` on a model imported without Read/Write throws | Meshes of loaded models are never readable (`mesh.isReadable` is false) | Their data stays on the GPU. Build editable shapes with `new Mesh()`. |
| 13 | Rigidbody physics, collisions, triggers | **Not available yet.** Colliders exist for raycasts and overlap queries only | Kept out of the core to stay small. |
| 14 | UI: uGUI / UI Toolkit | In-scene `Canvas` + `Image` for UI images; Preact (`@synergy/ui`) for interactive HUDs | See below. |
| 15 | `Invoke("Method", 2f)` | `this.invoke(this.method, 2)` | Pass the function, not its name. |
| 16 | `[SerializeField] private` vs `private` | `instantiate` copies a script's fields except those starting with `_`, functions, and `UnityEvent`/`Observable`/`Map`/`Set` instances. Arrays and object literals are deep-copied | There is no serializer; this is the stand-in. |
| 17 | `Random` is one global generator | `new Random(seed)` is an object you own | Deterministic rules need an explicit, seedable generator. Its numbers do not match Unity's. |
| 18 | `TilemapRenderer.sortingOrder` sorts 2D layers | It lifts the layer off the grid by a small step | Avoids flicker between layers on the same plane in 3D. |

### Operators

| C# | TypeScript |
|----|------------|
| `a + b` | `a.add(b)` |
| `a - b` | `a.sub(b)` |
| `v * 2f` / `v / 2f` | `v.mul(2)` / `v.div(2)` |
| `-v` | `v.neg()` |
| `Vector3.Scale(a, b)` | `a.scale(b)` |
| `a == b` (approximate) | `a.equals(b)` |
| `q1 * q2` | `q1.mul(q2)` |
| `q * v` | `q.rotate(v)` |
| `color * 0.5f` / `colorA * colorB` | `color.mul(0.5)` / `colorA.mul(colorB)`: alpha is scaled too, as in Unity (`color.mul(0.5).withAlpha(color.a)` keeps it) |
| `transform.position += Vector3.up` | `transform.position = transform.position.add(Vector3.up)` |
| `new Vector3(p.x, 0, p.z)` | `p.withY(0)` |

## C# to TypeScript

The API above is Unity's; the language under it is not C#. These are the habits that
compile here and then do something else, which makes them the costly ones in a port.
`bun run check` reports some of them (keys, `==` on vectors, sorting, events given a
bare method; see [checks.md](checks.md)). The rest, such as integer division and shared
structs, only a test can show.

| C# | TypeScript | What goes wrong otherwise |
|----|------------|---------------------------|
| `int / int` truncates: `7 / 2` is `3` | `Math.trunc(7 / 2)` | `/` always gives `3.5`. Damage, costs and grid indices drift |
| `(int)value`, `Mathf.FloorToInt` | `Math.trunc(value)`, `Mathf.floorToInt` | `(int)` drops the fraction toward zero; `floor` differs for negatives |
| `Mathf.RoundToInt(2.5f)` is `2` | `Mathf.roundToInt(2.5)` is `2` | Same as Unity (halfway goes to the even number). JavaScript's own `Math.round(2.5)` is `3` |
| `struct` values are copied on assignment | objects are shared: copy with `{ ...value }`, or `structuredClone(value)` when it holds arrays or objects | Two units end up editing one stats object. `{ ...value }` copies one level only. Engine vectors and colours are immutable, so they are safe to share |
| `Dictionary<Vector3Int, T>`, `HashSet<Vector2Int>` | `Map<string, T>` keyed by `cellKey(cell)` | `Map` and `Set` compare object keys by identity, so an equal cell is never found |
| `dict[key]` throws when missing | `map.get(key)` returns `undefined` | Handle the missing case; the type-checker asks you to |
| `a == b` on structs and strings | `===` for numbers and strings, `a.equals(b)` for vectors and cells | `===` on two equal vectors is `false` |
| `list.Sort()`, `OrderBy(x => x.cost)` | `list.toSorted((a, b) => a.cost - b.cost)` | `sort()` changes the array in place and, with no comparer, sorts numbers as text (`10` before `9`) |
| `List<T>`: `Add`, `Remove(x)`, `Count`, `Contains` | `T[]`: `push`, `const i = list.indexOf(x); if (i >= 0) list.splice(i, 1)`, `length`, `includes` | `splice(-1, 1)` deletes the *last* item, so test the index: C#'s `Remove` of something absent does nothing. `indexOf` and `includes` find objects by identity; for cells and vectors use `findIndex((c) => c.equals(x))` and `some((c) => c.equals(x))` |
| LINQ: `Where`, `Select`, `Any`, `All`, `First`, `FirstOrDefault`, `Sum` | `filter`, `map`, `some`, `every`, `find`, `find`, `reduce` | `find` returns `undefined` rather than throwing as `First` does |
| `foreach (var pair in dict)` | `for (const [key, value] of map)` | |
| `public int Hp { get; private set; }` | `private _hp = 0; get hp() { return this._hp; }` | |
| `event Action<int> Damaged;` `Damaged?.Invoke(5);` `x.Damaged += F;` | `readonly damaged = new UnityEvent<[number]>();` `this.damaged.invoke(5);` `x.damaged.addListener(f)` | Pass arrow functions or bound methods, or `this` is lost in the handler |
| `public static Game Instance;` set in `Awake` | `static instance: Game \| null = null;` set in `awake`, cleared in `onDestroy` | |
| `bool TryGet(out T value)`, `ref` parameters | return the value or `null` (or a tuple) | |
| `async Task<T>`, `await` | `async` returning `Promise<T>`, `await` | In a script, a coroutine can `yield` a promise |
| `[Serializable] class UnitData`, ScriptableObject | an `interface` and plain objects in a `.ts` module | Keep the asset's name as an `id` field so saved data still refers to it |
| `enum Team { Red, Blue }` | `enum Team { Red, Blue }` | Same numbering, so serialized numbers keep their meaning |
| `uint`, overflow, `long` | every number is a 64-bit float; bit operators work on 32 bits | Hashes and bit masks ported literally can differ |
| `namespace`, `using` | one class per file, `import { X } from './X'` | |
| NUnit: `[Test]`, `[SetUp]`, `Assert.AreEqual(expected, actual)` | `test(...)`, `beforeEach(...)`, `expect(actual).toBe(expected)` | The arguments swap places. `Assert.AreEqual(a, b, 0.01f)` is `expect(Math.abs(b - a)).toBeLessThanOrEqual(0.01)`; `toBeCloseTo(a, 2)` allows only half of that. `Assert.IsTrue(x)` is `expect(x).toBe(true)`: `expect(x)` alone compares nothing |

## API map

### Objects and components

| Unity | Synergy |
|-------|---------|
| `new GameObject("Name")` | `new GameObject('Name')` |
| `new GameObject("Name", typeof(A), typeof(B))` | `new GameObject('Name', A, B)` |
| `go.AddComponent<T>()` | `go.addComponent(T)` |
| `GetComponent<T>()`, `GetComponents`, `GetComponentInChildren`, `GetComponentInParent`, `GetComponentsInParent` | same names in camelCase, class as argument, and `includeInactive` where Unity has it. As in Unity, the `...InParent` ones skip inactive parents unless `includeInactive` is true, and always search the object itself |
| `go.SetActive(false)`, `activeSelf`, `activeInHierarchy` | `go.setActive(false)`, same properties |
| `go.tag`, `CompareTag`, `go.layer` | same |
| `GameObject.Find`, `FindWithTag`, `FindGameObjectsWithTag` | `GameObject.find`, `findWithTag`, `findGameObjectsWithTag` |
| `FindAnyObjectByType<T>()`, `FindFirstObjectByType<T>()`, `FindObjectsByType<T>(FindObjectsInactive.Include)` | `findAnyObjectByType(T)`, `findFirstObjectByType(T)`, `findObjectsByType(T, FindObjectsInactive.Include)`. Results come in scene order; a `FindObjectsSortMode` is accepted and ignored (Unity 6 deprecates it). The old `findObjectOfType` / `findObjectsOfType` still work and are marked deprecated, as in Unity 6 |
| `GameObject.CreatePrimitive(PrimitiveType.Cube)` | `GameObject.createPrimitive(PrimitiveType.Cube)` (Unity's sizes) |
| `Instantiate(obj, pos, rot, parent)` | `instantiate(obj, pos, rot, parent)` |
| `Destroy(obj, delay)`, `DestroyImmediate` | `destroy(obj, delay)`, `destroyImmediate` |
| `DontDestroyOnLoad(obj)` | `dontDestroyOnLoad(obj)` |
| `[RequireComponent(typeof(X))]` | `static readonly requireComponents = [X]` |
| `[DisallowMultipleComponent]` | `static readonly disallowMultiple = true` |
| Prefab asset | `new Prefab('Name', (go) => { ... })` |
| ScriptableObject | A record in a `Catalog`, looked up by id: `unitTypes.get('footman')`. In a `.ts` module or exported from Unity as JSON. See [content.md](content.md) |

### MonoBehaviour messages

`awake`, `onEnable`, `start`, `update`, `lateUpdate`, `fixedUpdate`, `onDisable`,
`onDestroy`, `onMouseDown`, `onMouseUp`, `onMouseEnter`, `onMouseOver`, `onMouseExit`.

The order within a frame is Unity's: `awake` → `onEnable` → `start` → `fixedUpdate` (zero
or more times) → `update` → coroutines → `lateUpdate` → destroy queue.

Do setup in `awake`/`start`, never in a constructor. Components cannot be created with
`new`; always use `addComponent`.

### Coroutines

```ts
*fadeOut(): IEnumerator {
  yield new WaitForSeconds(1);
  yield null;                         // wait one frame
  yield new WaitUntil(() => this.ready);
  yield this.startCoroutine(this.other());
  yield fetch('/data.json');          // TypeScript extra: wait for a promise
}

start() {
  this.startCoroutine(this.fadeOut());  // note the call: pass the generator object
}
```

`yield return x` becomes `yield x`. Also available: `WaitForSecondsRealtime`,
`WaitForEndOfFrame`, `WaitForFixedUpdate`, `WaitWhile`, `CustomYieldInstruction`,
`stopCoroutine` (the `Coroutine`, or the generator you started), `stopAllCoroutines`,
`invoke`, `invokeRepeating`, `cancelInvoke`, `isInvoking`.

As in Unity, an `invoke` is not a coroutine: `stopAllCoroutines` does not cancel it
(`cancelInvoke` does), and it keeps going while the behaviour is disabled or its
GameObject inactive. Coroutines end when the GameObject is deactivated.

A coroutine may stop itself (deactivate or destroy its own object, call
`stopAllCoroutines`); it ends at its next `yield`, and its `finally` blocks run.

### Transform

`position`, `localPosition`, `rotation`, `localRotation`, `eulerAngles`,
`localEulerAngles`, `localScale`, `lossyScale`, `forward`, `right`, `up`, `parent`,
`setParent(parent, worldPositionStays)`, `root`, `childCount`, `getChild(i)`, `find(path)`,
`isChildOf`, `translate`, `rotate`, `rotateAround`, `lookAt`, `transformPoint`,
`inverseTransformPoint`, `transformDirection`, `transformVector`, `getSiblingIndex`.

Iterate children with `for (const child of transform)`.

### Statics

| Unity | Synergy |
|-------|---------|
| `Time.deltaTime`, `time`, `timeScale`, `fixedDeltaTime`, `unscaledDeltaTime`, `frameCount` | same |
| `Input.GetKey(KeyCode.W)`, `GetKeyDown`, `GetKeyUp` | `Input.getKey(KeyCode.W)`, ... |
| `Input.GetMouseButtonDown(0)` (0 left, 1 right, 2 middle) | `Input.getMouseButtonDown(0)`, same numbering |
| `Input.mousePosition`, `mouseScrollDelta` | same: origin bottom-left, y up; units are CSS pixels. Scroll is in notches (fractions from trackpads) |
| `Input.GetAxis("Mouse X")`, `"Mouse Y"`, `"Mouse ScrollWheel"` | same, with the default Input Manager's 0.1 sensitivity |
| `Input.GetAxis("Horizontal")`, `GetButtonDown("Jump")` | `Input.getAxis('Horizontal')`, `Input.getButtonDown('Jump')` |
| Input Manager settings | `Input.defineAxis(...)`, `Input.defineButton(...)` |
| `Screen.width`, `Screen.height` | same (CSS pixels) |
| `Debug.Log`, `LogWarning`, `LogError`, `LogException`, `Assert`, `DrawLine`, `DrawRay` | `Debug.log`, `logWarning`, `logError`, `logException`, `assert`, `drawLine`, `drawRay`. Unity's `context` argument goes last: `Debug.log('stuck', this.gameObject)`. `drawLine(start, end, color, duration, depthTest)` as in Unity, drawn in development builds only |
| `Debug.Break()`, `Debug.isDebugBuild` | same in camelCase; `break()` pauses the editor and does nothing without one |
| `Application.logMessageReceived`, `LogType`, `Application.isEditor` | same |
| `OnDrawGizmos`, `OnDrawGizmosSelected`, `Gizmos.DrawWireSphere` and the rest | same in camelCase, drawn while the editor is open ([devtools.md](devtools.md)) |
| `ScreenCapture.CaptureScreenshot("a.png")` | `await ScreenCapture.captureScreenshot('a.png')` |
| The Hierarchy, Inspector and Console windows | The editor in a development build: press <kbd>`</kbd> ([devtools.md](devtools.md)). As text: `Debug.hierarchy()`, `bun run logs` |
| `EditorApplication.isPaused`, `Selection.activeGameObject`, `EditorPrefs` | the same names in `@synergy/devtools`, development builds only |
| `Mathf.*` | `Mathf.*` in camelCase, for what Unity adds to the language: `clamp`, `clamp01`, `lerp`, `inverseLerp`, `moveTowards`, `smoothStep`, `repeat`, `pingPong`, `deltaAngle`, `lerpAngle`, `approximately`, `floorToInt`, `roundToInt` and the like. `Mathf.smoothDamp(current, target, velocity, smoothTime, maxSpeed, deltaTime)` returns `[value, velocity]` in place of `ref`, and needs its last two arguments (`Infinity`, `Time.deltaTime`). `round` and `roundToInt` send halfway values to the even number, as Unity does. `Mathf.epsilon` is Unity's 1.401298e-45 and `approximately` is Unity's formula (relative, about one part in a million), so near zero use a tolerance of your own. Not there: `acos`, `asin`, `atan`, `exp`, `log`, `log10` (use `Math.acos` and so on, in radians) and `perlinNoise` |
| `SceneManager.LoadScene("Main")` | `await SceneManager.loadScene('Main')` after `SceneManager.register('Main', build)`. For scenes that need assets, register `{ preload, build }` |
| `Random.Range`, `Random.value` | `new Random(seed)` (the seed is required and a whole number): `Random.Range(int, int)` is `rangeInt(min, maxExclusive)`, `Random.Range(float, float)` is `range(min, max)` (and `value`), which never returns `max` where Unity's can; also `value`, `pick`, `shuffle`, `state`. `list[random.range(0, list.length)]` is `undefined`: an index needs `rangeInt`, or `random.pick(list)` |
| `RenderSettings.ambientLight` | same |
| `Camera.main`, `ScreenPointToRay`, `WorldToScreenPoint`, `ScreenToWorldPoint`, the `Viewport` conversions | same in camelCase, same bottom-left origin |
| `LayerMask.GetMask("Units")`, `NameToLayer` | `LayerMask.getMask('Units')`, `nameToLayer`; name layers with `LayerMask.define(8, 'Units')` |
| `UnityEvent`, `event Action` | `UnityEvent<[args]>` with `addListener`, `removeListener` (removes every registration of that function, as in Unity), `invoke` |

### Rendering

| Unity | Synergy |
|-------|---------|
| `MeshFilter.mesh` / `sharedMesh`, `MeshRenderer.material` / `sharedMaterial` | same. `.mesh` and `.material` copy on first access, as in Unity |
| `new Material(shader)`, `material.color`, `mainTexture` | `new Material()`, `color`, `mainTexture`, `metallic`, `smoothness`, `emissionColor` |
| `new Mesh { vertices, triangles, uv }`, `RecalculateNormals()` | `new Mesh()`, `vertices`, `triangles`, `uv`, `recalculateNormals()`: Unity's clockwise winding and bottom-up `v`. The arrays are copies, as in Unity: assign them back |
| `Light` (type, color, intensity, range, spotAngle, shadows) | same, plus `direction` |
| `Resources.Load` / Addressables | `await Assets.loadModel(url)`, `Assets.loadTexture(url)`, `Assets.loadSprite(url)` |

### Sprites (2D in a 3D scene)

| Unity | Synergy |
|-------|---------|
| `Sprite`, `Sprite.Create(texture, rect, pivot, pixelsPerUnit)` | `new Sprite(texture, rect?, { pivot, pixelsPerUnit })`, `Sprite.create(...)`, `Sprite.slice(texture, columns, rows)`. `rect` is measured from the image's **top**-left. As in Unity, the `pivot` you pass is a fraction of the rect, and `sprite.pivot` reads it back in pixels |
| `SpriteRenderer` (`sprite`, `color`, `flipX`, `flipY`, `sortingOrder`, `bounds`) | same; `flipX`/`flipY` mirror about the pivot, as in Unity. Faces +Z (toward an unrotated camera); unlit, alpha-blended, depth-tested against 3D meshes |
| Sorting layers | Not available; use `sortingOrder` (higher draws on top, before distance is considered) |

Sprites, meshes and loaded models share one scene and one depth buffer, so a cube in
front of a sprite hides it. `?scene=Showcase` in the sample game shows all three together
with canvas UI.

### Tile maps

| Unity | Synergy |
|-------|---------|
| `Grid` (`cellSize`, `cellGap`, `cellLayout`, `cellSwizzle`) | same. Layouts: `Rectangle`, `Hexagon` (Unity's offset coordinates) |
| `CellToWorld`, `WorldToCell`, `GetCellCenterWorld` | same in camelCase |
| `Tilemap.SetTile`, `HasTile`, `SetTiles`, `FloodFill`, `SwapTile`, `ClearAllTiles`, `cellBounds` | same in camelCase |
| `tilemap.GetTile<DoorTile>(cell)` | `tilemap.getTile(cell, DoorTile)`: `null` unless it is one, like Unity. `getTile<DoorTile>(cell)` compiles too, but only casts |
| `SetColor`, `GetColor`, `SetTileFlags`, `AddTileFlags`, `RemoveTileFlags`, `TileFlags` | same in camelCase, with Unity's rules: `setColor` replaces the tile's colour, `setTile` resets it, and a `Tile` has `TileFlags.LockColor` by default, so `setColor` does nothing (here it warns once) until `removeTileFlags(cell, TileFlags.LockColor)` |
| `Tilemap.BoxFill(position, tile, startX, startY, endX, endY)` | `tilemap.boxFill(tile, min, max)`: two corner cells, both inclusive |
| `Tile`, `TileBase.GetTileData`, `Tile.gameObject`, `Tile.flags` | `Tile`, `TileBase.getTileData`, `tile.gameObject` (a `Prefab` or GameObject), `tile.flags` |
| Fields on a custom `Tile` class (climate, elevation) | `tile.data`, typed: `Tile<Terrain>` |
| Tile assets and a painted Tilemap, made in the editor | `TilePalette.load(tiles)` and `createTilemaps(map, palette)` from JSON files; `tools/unity` exports them. See [content.md](content.md) |
| `TilemapRenderer` Chunk mode | always on: one mesh per 16 x 16 block of cells |
| `TilemapRenderer` (`sortingOrder`) | same |
| `Vector3Int`, `Vector2Int`, `BoundsInt` | same; any `{ x, y }` is accepted as a cell |
| `Sprite` | `new Sprite(texture, rect)`, `Sprite.slice(texture, columns, rows)` |
| Mouse to cell (usually `ScreenToWorldPoint` + `WorldToCell`) | `grid.raycast(ray)` |
| (custom code) hex neighbours, distance, pathfinding | `Hex`, `Square`, `findPath`, `findReachable` |

Details and examples: [tilemaps.md](tilemaps.md).

### Tweening

Unity has none built in; this covers the common DOTween calls.

| DOTween | Synergy |
|---------|---------|
| `transform.DOMove(target, 0.4f)` | `Tween.move(transform, target, 0.4)` |
| `DOLocalMove`, `DORotateQuaternion`, `DOScale` | `Tween.moveLocal`, `Tween.rotate`, `Tween.scale` |
| `DOTween.To(getter, setter, end, duration)` | `Tween.to(from, to, duration, (value) => ...)` for numbers, vectors, colours, quaternions |
| `.SetEase(Ease.OutCubic)`, `.SetDelay`, `.SetLoops(2, LoopType.Yoyo)`, `.OnComplete`, `.SetUpdate(true)` | `.setEase(Ease.OutCubic)`, `.setDelay`, `.setLoops(2, LoopType.Yoyo)`, `.onComplete`, `.setUpdate(true)` |
| `yield return tween.WaitForCompletion()` | `yield tween` |
| `tween.Kill()`, `DOTween.Kill(target)` | `tween.kill()`, `Tween.kill(target)` |

### UI

Two complementary ways, usable together:

- **In-scene UI images**, the uGUI way: a `Canvas` GameObject with `Image` children laid
  out by `RectTransform`. Drawn by PlayCanvas over the 3D world and sprites. Good for
  icons, frames, bars and badges. Not clickable yet, and there is no `Text`.
- **The Preact HUD** (`@synergy/ui`), drawn over the canvas as DOM: text, buttons, forms.
  It is [Preact](https://preactjs.com), not React: hooks come from `preact/hooks`, and a
  text field updates with `onInput` (Preact's `onChange` fires only when the field loses focus).

| Unity | Synergy |
|-------|---------|
| `Canvas` (Screen Space - Overlay), `sortingOrder` | `Canvas` (overlay only), `sortingOrder` 0-127 |
| `CanvasScaler` (Constant Pixel Size, Scale With Screen Size, `matchWidthOrHeight`) | same. One unit is one **CSS** pixel at `scaleFactor` 1 |
| `RectTransform` (`anchorMin`, `anchorMax`, `pivot`, `anchoredPosition`, `sizeDelta`, `offsetMin`, `offsetMax`, `rect`) | same, but it is a component beside `transform`: `getComponent(RectTransform)`. `Image` adds it |
| `Image` (`sprite`, `color`, `SetNativeSize()`) | same, Simple type only. No sprite = a flat coloured rectangle |
| `transform.SetParent(canvas, false)`, `SetAsLastSibling()` | same; later siblings draw on top |
| Canvas + interactive UI components | `mountUI(<Hud />, { engine })` |
| Binding UI to game data | Game code writes an `Observable`; components read it with `useObservable(obs)` |
| World Space canvas / `WorldToScreenPoint` for health bars | `<WorldAnchor target={gameObject}>` |
| `EventSystem.IsPointerOverGameObject()` | Not needed: clicks on HUD controls never reach `Input` |
| Button `onClick` → method | `onClick={() => GameController.instance?.endTurn()}` |

### Multiplayer

Netcode for GameObjects has an equivalent: `NetworkManager`, `NetworkObject`,
`NetworkBehaviour`, `NetworkVariable`, RPCs and ownership, with a host that is server and
client at once. See [netcode.md](netcode.md) for the map. For turn-based and asynchronous
games there is also a simpler model where players exchange **commands** and every machine
applies them in the same order: [multiplayer.md](multiplayer.md).

## Not implemented yet

Rigidbodies and collision/trigger messages, animation (Animator), audio (AudioSource),
particles, sorting layers, sliced/filled/clickable UI images, UI text, NavMesh (grid pathfinding exists), skyboxes, post-processing
wrappers, gamepad and touch gestures.

PlayCanvas has all of these. Until they are wrapped you can reach them directly through
the escape hatches: `gameObject.entity` (the `pc.Entity`), `engine.app` (the
`pc.AppBase`), `camera.pcCamera`, `light.pcLight`, `material.pcMaterial`. Extra PlayCanvas
component systems are switched on in `Engine.create({ componentSystems: [...] })`.
