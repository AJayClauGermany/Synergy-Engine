---
name: extend-engine
description: >
  Adds or changes an API in packages/engine, the Unity-style layer over PlayCanvas: a new
  built-in component, a Unity API that is missing, a wrapper for a PlayCanvas feature
  (audio, animation, particles, physics), lifecycle behaviour, or a guard for a mistake
  the engine could catch. Use when game code needs something the engine does not have, or
  when an engine API lets a mistake through silently. Not for game code under game/ (use
  `gameplay-scripting`), or for the netcode package's own rules (use `netcode`).
---

# Extending the engine

`packages/engine` is the Unity-style layer over PlayCanvas. Read `docs/architecture.md`
first. Goals, in order: match Unity's names and behaviour, stay small, stay testable
headlessly.

## Where things go

- `src/math/`: pure TypeScript, immutable values, **no imports from outside the folder**.
- `src/grid/`: pure grid maths (layouts, hex, pathfinding). May import `../math` only.
- `src/data/`: content as plain data (`Catalog`, tile and map file shapes and their
  checkers). May import `../math` only.
  All three are public entry points (`@synergy/engine/math`, `/grid`, `/data`) used by
  game rules and servers, so they must never import PlayCanvas or anything from `core/`.
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
    this.component = entity.sound ?? (entity.addComponent('sound', {}) as pc.SoundComponent);   // adopt or create
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
`_enabledChanged`, `_gameObjectDeactivated`, `_destroy`, `_wantsLive`, `_copyFrom`. Game code never
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
- **Conventions:** Unity's: left-handed, +Z forward, Euler Z-X-Y, bottom-left screen space,
  clockwise mesh winding, v = 0 at the bottom of a texture, degrees. PlayCanvas is
  right-handed with -Z forward: convert every value that crosses into or out of it with
  `core/handedness.ts` (mirror Z; rotations `(-x, -y, z, w)`). Never pass a Unity-space
  value straight to a PlayCanvas call, or read one back without converting.
- **Say where it differs, on the member.** When a member's behaviour differs from Unity's
  page for it, or an agent could reasonably assume Unity's behaviour, its doc comment says
  so ("Unity: ... Here: ..."). Agents read the hover text, not the guides.
- **Expose the escape hatch** (`pcLight`, `pcCamera`, `pcMaterial`) so games are never
  blocked by a missing wrapper.
- **No new dependencies** in `packages/engine` beyond `playcanvas`.
- **Do not break headless mode.** No unguarded `window`/`document`; anything that needs
  the DOM belongs in `attachToPage()` (private, in `core/Engine.ts`) or behind `engine.isHeadless`.
- **Statics go through `currentEngine()`** (`core/runtime.ts`), never a module-level
  singleton, so tests can create and dispose engines freely.
- Watch for import cycles: `core/` must not import from `components/` except through
  `hooks.ts` (types are fine). `bun run check` reports a cycle, and an import that
  breaks the layering above (the zones in `.fallowrc.jsonc`). A new top-level folder
  under `src/` is in the `engine` zone unless you give it its own.

## Then update the docs

Add the API to `docs/unity-to-synergy.md` (and remove it from "Not implemented yet").
If it changes a rule agents rely on, update `AGENTS.md` and the relevant skill.

If you add a message the engine sends (or start sending one from `NOT_SENT` in
`core/messageNames.ts`), update the same two lists in `tools/lint/synergy.ts`: the lint
rule `no-unsent-message` keeps its own copy, and a test fails until they agree. If the
new API has a way to be misused that a port would hit, consider a lint rule for it
(`docs/checks.md`, "Adding a rule").

## Make the wrong thing hard

An API is finished when its likely misuse is caught, not when its correct use works. For
each new API ask what a Unity developer, or an agent that has read Unity's docs, would
write first, and try it. If it compiles and then does nothing or something else, close
the gap with the cheapest of these that is certain:

1. **A type.** A branded class so a look-alike is not accepted, a required parameter in
   place of a default that hides a mistake, a read-only return type for a value that must
   be replaced, a union return type so "anything fits `void`" does not apply.
2. **An error when it runs**, at the place the mistake is made, whose message says what
   to write instead. Unity's own exceptions are the model.
3. **A warning, once**, when the code might be right.
4. **A lint rule** when the text alone is proof (`docs/checks.md`, "Adding a rule").

`packages/engine/test/pitfalls.test.ts` holds one test per closed gap; add yours there.

## Gotchas

- **A guard that fires on correct code** costs more than the mistake it catches: people
  learn to work around guards. If it can be wrong, make it a warning or leave it out.
- **An error that says what is wrong but not what to do.** Every message here ends with
  the fix. `X is not a cell` is half a message; `...use grid.worldToCell(position)` is
  the other half.
- **A module-level cache or singleton** survives `engine.dispose()` and is shared by
  every engine in a test run. Go through `currentEngine()`, or key by engine in a
  `WeakMap`.
- **Reading PlayCanvas state that only updates when a frame renders** (view matrices,
  world transforms of a just-moved entity). Headless tests then see stale values.
  Compute from the transforms.
- **A new `_member` on Component or MonoBehaviour** is a name game scripts can no longer
  use. Add it to `ENGINE_MEMBERS` in `tools/lint/synergy.ts`; a test fails until you do.
- **A new message, or a new entry in `NOT_SENT`**, has a second copy in the lint plugin;
  the same test holds them together.
- **A doc sample that no longer compiles** after an API change fails the `docs` check.
  Fix the guide in the same change: that is the check doing its job.
- **Unlit, vertex colours, texture orientation, colour space** cannot be asserted
  headlessly and have each been wrong once. Take the screenshot, on both renderers.

## Verify

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

A pass is `bun run check` ending in `PASSED` (it type-checks every sample in the guides
against your change), plus a screenshot for anything that draws.
