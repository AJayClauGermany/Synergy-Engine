---
id: GAME-001
title: Scenes are registered by name and have a main camera and a light
domain: game
rules: true
files: ["game/src/**/*.ts", "game/src/**/*.tsx"]
---

## Context

A scene is a builder function registered under a name, like Unity's "Scenes in Build"
list (`SceneManager.register('Skirmish', buildSkirmishScene)` in `game/src/main.tsx`).
Everything that refers to a scene does so by that name, as a string: `?scene=Name`,
`SceneManager.loadScene('Name')`, `networkManager.sceneManager.loadScene(name)`. The
type-checker sees only strings, so a misspelt or unregistered name compiles and fails
when the game runs.

A scene also needs a camera tagged `MainCamera` and a light (AGENTS.md, "Add a scene").
Without the tag `Camera.main` is null, and mouse picking, `onMouseDown()` and `WorldAnchor`
stop working; the engine only warns, once, at run time. Without a light the scene renders
with the ambient light alone.

## Decision

- Every scene name the game loads is registered in `game/src`, under exactly that name.
  Give a name used in more than one file a constant (`FRONTIER_SCENE` in
  `game/src/frontier/scene.ts`) and use the constant everywhere.
- The file that builds a registered scene, or a file it imports, tags a camera
  `MainCamera` and adds a `Light`.

## Do's and Don'ts

### Do

- Register new scenes at boot in `game/src/main.tsx`, or next to the code that loads them
  when only that code does (Frontier's network manager in `game/src/frontier/session.ts`).
- Load by literal or by a `const` naming the scene, so the check can follow the name.
- Build the camera in the scene file or in a helper the scene file imports.

### Don't

- Don't rely on Unity's tag spelling being forgiven: the tag is `MainCamera`, exactly.
- Don't register scenes only in tests and load them from game code.

## Consequences

### Positive

- A wrong scene name fails `bun run adrs` with the list of registered names, instead of
  failing when someone opens that screen.

### Negative

- A scene name computed at run time (`loadScene(screen)`) is not followed; the engine's
  own error still covers it.

### Risks

- A camera created somewhere the scene file does not import directly is not seen.
  Import the helper from the scene file, or suppress the finding with a reason.

## Compliance and Enforcement

### Automated Enforcement

- `GAME-001/loaded-scenes-are-registered`: each `loadScene(...)` whose argument is a literal
  or a known constant names a scene that `SceneManager.register` registers in `game/src`.
- `GAME-001/scenes-have-a-main-camera-and-a-light`: the builder's file, or a file it imports,
  contains `camera.tag = 'MainCamera'` and `addComponent(Light)`.

### Manual Enforcement

Reviewers check that a new screen is reachable from the menu and has a test that loads it.

## References

- [AGENTS.md](../../AGENTS.md), "Add a scene"
- [docs/unity-to-synergy.md](../../docs/unity-to-synergy.md)
