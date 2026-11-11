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
| 5 | Left-handed, forward is `+Z` | **Right-handed, forward is `-Z`** | Matches PlayCanvas and glTF. Use `Vector3.forward` / `transform.forward`, never literal axes, and code ports unchanged. |
| 6 | Screen origin bottom-left, Y up | **Screen origin top-left, Y down**, in CSS pixels | Same space as the DOM and the React HUD. Affects `Input.mousePosition`, `Camera.worldToScreenPoint`. |
| 7 | `Physics.Raycast(ray, out hit)` returns bool | `Physics.raycast(ray)` returns the hit or `null` | No `out` parameters. |
| 8 | `if (target != null)` is false for destroyed objects | `if (isAlive(target))` | `==` cannot be overloaded. |
| 9 | Scenes and prefabs are assets made in the editor | Scenes and prefabs are **functions** (`SceneManager.register`, `new Prefab`) | There is no editor. Code is easy to diff and generate. |
| 10 | Lights shine along `transform.forward` | Directional and spot lights shine along `-transform.up` | PlayCanvas convention. Set `light.direction` and forget about it. |
| 11 | Euler order Z, X, Y | Euler order X, Y, Z | PlayCanvas convention. Single-axis rotations are identical. |
| 12 | Mesh triangles are clockwise | Counter-clockwise | Follows from the right-handed world. |
| 13 | Rigidbody physics, collisions, triggers | **Not available yet.** Colliders exist for raycasts and overlap queries only | Kept out of the core to stay small. |
| 14 | UI: uGUI / UI Toolkit | In-scene `Canvas` + `Image` for UI images; React (`@synergy/ui`) for interactive HUDs | See below. |
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
| `transform.position += Vector3.up` | `transform.position = transform.position.add(Vector3.up)` |
| `new Vector3(p.x, 0, p.z)` | `p.withY(0)` |

## C# to TypeScript

The API above is Unity's; the language under it is not C#. These are the habits that
compile here and then do something else, which makes them the costly ones in a port.

| C# | TypeScript | What goes wrong otherwise |
|----|------------|---------------------------|
| `int / int` truncates: `7 / 2` is `3` | `Math.trunc(7 / 2)` | `/` always gives `3.5`. Damage, costs and grid indices drift |
| `(int)value`, `Mathf.FloorToInt` | `Math.trunc(value)`, `Mathf.floorToInt` | `(int)` drops the fraction toward zero; `floor` differs for negatives |
| `Mathf.RoundToInt(2.5f)` is `2` | `Mathf.roundToInt(2.5)` is `2` | Same as Unity (halfway goes to the even number). JavaScript's own `Math.round(2.5)` is `3` |
| `struct` values are copied on assignment | objects are shared: copy with `{ ...value }` | Two units end up editing one stats object. Engine vectors and colours are immutable, so they are safe to share |
| `Dictionary<Vector3Int, T>`, `HashSet<Vector2Int>` | `Map<string, T>` keyed by `cellKey(cell)` | `Map` and `Set` compare object keys by identity, so an equal cell is never found |
| `dict[key]` throws when missing | `map.get(key)` returns `undefined` | Handle the missing case; the type-checker asks you to |
| `a == b` on structs and strings | `===` for numbers and strings, `a.equals(b)` for vectors and cells | `===` on two equal vectors is `false` |
| `list.Sort()`, `OrderBy(x => x.cost)` | `list.toSorted((a, b) => a.cost - b.cost)` | `sort()` changes the array in place and, with no comparer, sorts numbers as text (`10` before `9`) |
| `List<T>`: `Add`, `Remove(x)`, `Count`, `Contains` | `T[]`: `push`, `splice(indexOf(x), 1)`, `length`, `includes` | |
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
| NUnit: `[Test]`, `[SetUp]`, `Assert.AreEqual(expected, actual)` | `test(...)`, `beforeEach(...)`, `expect(actual).toBe(expected)` | The arguments swap places. `Assert.AreEqual(a, b, 0.01f)` is `expect(b).toBeCloseTo(a, 2)` |

## API map

### Objects and components

| Unity | Synergy |
|-------|---------|
| `new GameObject("Name")` | `new GameObject('Name')` |
| `new GameObject("Name", typeof(A), typeof(B))` | `new GameObject('Name', A, B)` |
| `go.AddComponent<T>()` | `go.addComponent(T)` |
| `GetComponent<T>()`, `GetComponents`, `GetComponentInChildren`, `GetComponentInParent` | same names in camelCase, class as argument |
| `go.SetActive(false)`, `activeSelf`, `activeInHierarchy` | `go.setActive(false)`, same properties |
| `go.tag`, `CompareTag`, `go.layer` | same |
| `GameObject.Find`, `FindWithTag`, `FindGameObjectsWithTag` | `GameObject.find`, `findWithTag`, `findGameObjectsWithTag` |
| `FindFirstObjectByType<T>()`, `FindObjectsByType<T>()` | `findObjectOfType(T)`, `findObjectsOfType(T)` |
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
this.startCoroutine(this.fadeOut());  // note the call: pass the generator object
```

`yield return x` becomes `yield x`. Also available: `WaitForSecondsRealtime`,
`WaitForEndOfFrame`, `WaitForFixedUpdate`, `WaitWhile`, `CustomYieldInstruction`,
`stopCoroutine`, `stopAllCoroutines`, `invoke`, `invokeRepeating`, `cancelInvoke`.

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
| `Input.mousePosition`, `mouseScrollDelta` | same (top-left origin) |
| `Input.GetAxis("Horizontal")`, `GetButtonDown("Jump")` | `Input.getAxis('Horizontal')`, `Input.getButtonDown('Jump')` |
| Input Manager settings | `Input.defineAxis(...)`, `Input.defineButton(...)` |
| `Screen.width`, `Screen.height` | same (CSS pixels) |
| `Debug.Log`, `LogWarning`, `LogError`, `DrawLine`, `DrawRay` | `Debug.log`, `logWarning`, `logError`, `drawLine`, `drawRay` |
| The Hierarchy and Inspector windows | `Debug.hierarchy()`: the loaded scenes as text, with each script's field values |
| `Mathf.*` | `Mathf.*` in camelCase; `Mathf.SmoothDamp(..., ref v, ...)` returns `[value, velocity]`. `round` and `roundToInt` send halfway values to the even number, as Unity does |
| `SceneManager.LoadScene("Main")` | `await SceneManager.loadScene('Main')` after `SceneManager.register('Main', build)`. For scenes that need assets, register `{ preload, build }` |
| `Random.Range`, `Random.value` | `new Random(seed)`: `range`, `rangeInt`, `value`, `pick`, `shuffle`, `state` |
| `RenderSettings.ambientLight` | same |
| `Camera.main`, `ScreenPointToRay`, `WorldToScreenPoint`, `ScreenToWorldPoint` | same in camelCase |
| `LayerMask.GetMask("Units")`, `NameToLayer` | `LayerMask.getMask('Units')`, `nameToLayer`; name layers with `LayerMask.define(8, 'Units')` |
| `UnityEvent`, `event Action` | `UnityEvent<[args]>` with `addListener`, `invoke` |

### Rendering

| Unity | Synergy |
|-------|---------|
| `MeshFilter.mesh`, `MeshRenderer.material` / `sharedMaterial` | same. `.material` copies on first access, as in Unity |
| `new Material(shader)`, `material.color`, `mainTexture` | `new Material()`, `color`, `mainTexture`, `metallic`, `smoothness`, `emissionColor` |
| `new Mesh { vertices, triangles }`, `RecalculateNormals()` | `new Mesh()`, `vertices`, `triangles`, `recalculateNormals()` |
| `Light` (type, color, intensity, range, spotAngle, shadows) | same, plus `direction` |
| `Resources.Load` / Addressables | `await Assets.loadModel(url)`, `Assets.loadTexture(url)`, `Assets.loadSprite(url)` |

### Sprites (2D in a 3D scene)

| Unity | Synergy |
|-------|---------|
| `Sprite`, `Sprite.Create(texture, rect, pivot, pixelsPerUnit)` | `new Sprite(texture, rect?, { pivot, pixelsPerUnit })`, `Sprite.create(...)`, `Sprite.slice(texture, columns, rows)`. `rect` is measured from the image's **top**-left |
| `SpriteRenderer` (`sprite`, `color`, `flipX`, `flipY`, `sortingOrder`, `bounds`) | same. Faces +Z (toward an unrotated camera); unlit, alpha-blended, depth-tested against 3D meshes |
| Sorting layers | Not available; use `sortingOrder` (higher draws on top, before distance is considered) |

Sprites, meshes and loaded models share one scene and one depth buffer, so a cube in
front of a sprite hides it. `?scene=Showcase` in the sample game shows all three together
with canvas UI.

### Tile maps

| Unity | Synergy |
|-------|---------|
| `Grid` (`cellSize`, `cellGap`, `cellLayout`, `cellSwizzle`) | same. Layouts: `Rectangle`, `Hexagon` (Unity's offset coordinates) |
| `CellToWorld`, `WorldToCell`, `GetCellCenterWorld` | same in camelCase |
| `Tilemap.SetTile`, `GetTile<T>`, `HasTile`, `SetTiles`, `FloodFill`, `SwapTile`, `ClearAllTiles`, `cellBounds`, `SetColor` | same in camelCase |
| `Tilemap.BoxFill(position, tile, startX, startY, endX, endY)` | `tilemap.boxFill(tile, min, max)`: two corner cells, both inclusive |
| `Tile`, `TileBase.GetTileData`, `Tile.gameObject` | `Tile`, `TileBase.getTileData`, `tile.gameObject` (a `Prefab` or GameObject) |
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
- **The React HUD** (`@synergy/ui`), drawn over the canvas as DOM: text, buttons, forms.

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
