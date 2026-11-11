---
name: extend-engine
description: Use when adding or changing an API in packages/engine - a new built-in component, a Unity API that is missing, a wrapper for a PlayCanvas feature (audio, animation, particles, physics), or engine lifecycle behaviour.
---

# Extending the engine

`packages/engine` is the Unity-style layer over PlayCanvas. Read `docs/architecture.md`
first. Goals, in order: match Unity's names and behaviour, stay small, stay testable
headlessly.

## Where things go

- `src/math/`: pure TypeScript, immutable values, **no imports from outside the folder**.
- `src/grid/`: pure grid maths (layouts, hex, pathfinding). May import `../math` only.
  Both are public entry points (`@synergy/engine/math`, `/grid`) used by game rules and
  servers, so they must never import PlayCanvas or anything from `core/`.
- `src/tilemap/`: the `Grid`/`Tilemap`/`TilemapRenderer` components built on `grid/`.
- `src/core/`: GameObject, Component, lifecycle, Time, Input, scenes. No specific
  component types (they plug in through `core/hooks.ts`).
- `src/components/`, `src/physics/`, `src/assets/`: built-in components and services.
- Export new public API from `src/index.ts`.

## Writing a built-in component

Model it on `components/Light.ts` (a wrapper around a PlayCanvas component):

```ts
export class AudioSource extends Behaviour {
  static readonly disallowMultiple = true;
  private component!: pc.SoundComponent;

  override _attach() {            // once, right after construction, even if inactive
    const entity = this.gameObject.entity;
    this.component = entity.sound ?? entity.addComponent('sound', { ... });   // adopt or create
  }
  override _enabledChanged() { this.component.enabled = this._enabled; }
  override _destroy() { this.gameObject.entity.removeComponent('sound'); }
  override _copyFrom(source: this) {       // state PlayCanvas's entity.clone() does not carry
    super._copyFrom(source, (v) => v);
  }
  // Unity-named properties that read/write the PlayCanvas component...
}

adopters.push((gameObject, entity) => {    // wrap raw entities that already have one
  if (entity.sound && !gameObject.getComponent(AudioSource)) gameObject.addComponent(AudioSource);
});
```

Internal hooks (all optional): `_attach`, `_awake`, `_enable`, `_disable`,
`_gameObjectDeactivated`, `_destroy`, `_wantsLive`, `_copyFrom`. Game code never
overrides these; it uses the public MonoBehaviour messages.

If the feature needs a PlayCanvas component system that is not on by default (only
render, camera, light, screen and element are), add it in `Engine`'s constructor only if it is small and
universally needed. Otherwise document that games pass it via
`Engine.create({ componentSystems: [pc.SoundComponentSystem] })`.

## Rules

- **Unity names, camelCase.** Check Unity's scripting reference for the member names
  before inventing one. Note any deviation in the doc comment.
- **Values are immutable** (`Vector3`, `Quaternion`, `Color`): getters return new
  instances, setters take them. Convert at the PlayCanvas boundary.
- **Conventions:** right-handed, -Z forward, top-left screen space, degrees.
- **Expose the escape hatch** (`pcLight`, `pcCamera`, `pcMaterial`) so games are never
  blocked by a missing wrapper.
- **No new dependencies** in `packages/engine` beyond `playcanvas`.
- **Do not break headless mode.** No unguarded `window`/`document`; anything that needs
  the DOM belongs in `Engine.attachToPage` or behind `engine.isHeadless`.
- **Statics go through `currentEngine()`** (`core/runtime.ts`), never a module-level
  singleton, so tests can create and dispose engines freely.
- Watch for import cycles: `core/` must not import from `components/` except through
  `hooks.ts` (types are fine).

## Tests

Every engine change gets a test in `packages/engine/test/`. They run on a headless engine:

```ts
beforeEach(() => { engine = Engine.createHeadless(); });
afterEach(() => { engine.dispose(); });
```

- Math: compare against PlayCanvas's own math (see `math.test.ts`) so conventions cannot drift.
- Components: assert through the Unity API and, where useful, through
  `gameObject.entity` that PlayCanvas ended up in the right state.
- Cloning: add a case proving `instantiate` copies the new component correctly.
- Rendering output cannot be asserted headlessly. Add the feature to a scene and run
  `bun run screenshot`. Texture orientation, colour space (vertex colours need
  `vertexColorGamma`) and unlit materials (colour must go through emission) have all
  needed a screenshot to get right.
- Do not read PlayCanvas state that is only refreshed when a frame renders (camera view
  matrices, for example). Compute from transforms so headless mode and same-frame
  queries are correct.

## Then update the docs

Add the API to `docs/unity-to-synergy.md` (and remove it from "Not implemented yet").
If it changes a rule agents rely on, update `AGENTS.md` and the relevant skill.
