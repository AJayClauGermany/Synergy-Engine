# Porting a Unity project

How to bring an existing Unity game across, in an order that keeps something running at
every step. [unity-to-synergy.md](unity-to-synergy.md) is the reference for individual
APIs; this page is the plan around it. It applies to any Unity project. Notes about one
particular game belong with that game (`game/docs/`).

## 1. Take stock

List what the project uses before translating anything: its packages, its custom
systems, where its data lives. For each, find the row in
[unity-to-synergy.md](unity-to-synergy.md) or in "Not implemented yet" at its end. Three
answers are possible:

- **It exists here** under the same name: port the code that uses it.
- **It is covered differently** (uGUI text and buttons → the React HUD; DOTween →
  `Tween`; ScriptableObjects → a `Catalog`): port to the equivalent.
- **It is missing** (rigidbody physics, Animator, audio, particles): decide now whether
  to wrap the PlayCanvas feature (`extend-engine` skill), reach it through
  `gameObject.entity`, or leave that part of the game out for the moment. Do not let a
  script quietly depend on something that is not there: a ported `OnTriggerEnter` is
  never called, and the engine warns about it.

## 2. Export the content

Content made in the editor does not need retyping. Copy
[`tools/unity/Editor/SynergyExporter.cs`](../tools/unity/README.md) into the Unity
project and export:

- the **Tile assets, sprite sheets and painted Tilemaps** → a palette file and map files;
- the **ScriptableObject assets** (unit types, items, rule sets) → one JSON list per type.

Load them with `TilePalette`, `createTilemaps` and `Catalog`
([content.md](content.md)), describe each type's fields with a TypeScript interface,
and add one test that checks every exported file. Art (PNG) and audio files carry over
as files; convert models to glTF/GLB.

Things that came from Unity's random numbers or noise (a procedurally generated map)
cannot be regenerated from the same seed here: export the result as data instead.

## 3. Decide how shared state works

If the game is multiplayer, choose one model before porting gameplay
([multiplayer.md](multiplayer.md) compares them), and say which in `AGENTS.md`:

- The Unity code uses **Netcode for GameObjects** (`NetworkBehaviour`, `NetworkVariable`,
  `[ServerRpc]`): keep that shape with `@synergy/netcode`. Scripts port one to one
  ([netcode.md](netcode.md)); `game/src/frontier` is a working example to copy.
- The game is **turn-based or wants replays and saves from one log**: pure rules and
  commands, as in the Skirmish sample (`game/src/rules`).

## 4. Port the logic, with its tests

Start with code that has no Unity in it: calculations, rules, pathfinding, data
classes. Port one script at a time, each with its test (a Unity EditMode test becomes a
`bun test`; where there is none, write one from the C#'s behaviour first), and run
`bun run fix` after each. It formats the file and then runs every check; fix what it
lists, first item first, until it says `PASSED`, and only then take the next script.
That loop needs no judgement about whether the code is acceptable: the tools decide
([checks.md](checks.md)).

The language differs in ways that compile and then give other answers: integer
division, struct copies, dictionary keys, sorting. The list is short and worth reading
once: "C# to TypeScript" in [unity-to-synergy.md](unity-to-synergy.md). The lint check
catches several of them (comparing vectors with `==`, a `Map` keyed by a cell, a sort
without a comparer, a method passed without its object), but not integer division or a
shared struct: only a test shows those.

## 5. Rebuild the scenes

A scene is a function here, and a prefab is a function (`SceneManager.register`,
`new Prefab`). Write each from the Unity hierarchy: the same GameObjects, the same
components, references assigned in code where the Inspector had them dragged in. Get
the map on screen from the exported data first, with placeholder art for everything
else, then add behaviours one at a time.

Check as you go without guessing: `bun run screenshot --hierarchy` prints what is
actually in the scene, and `--click`/`--key` drive it.

## 6. Then presentation

HUD (React over the canvas, `Canvas`/`Image` for in-scene images), tweens and
coroutines for animation, the camera, effects. This is where the engine has the most
gaps, so it comes last, when the game underneath already works.

## Keeping it honest

- Port behaviour, not just syntax: a script that type-checks may still never run. Give
  each ported script a test or a screenshot.
- When the original relies on something this engine lacks, say so in the code and to
  whoever asked for the port, rather than writing a stand-in that looks finished.
- Keep ids stable. Maps, saves and network messages refer to content by the names the
  Unity assets had.
