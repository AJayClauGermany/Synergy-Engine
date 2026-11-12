---
name: hud-ui
description: >
  Builds the HUD and menus of a game on this engine with Preact over the canvas: reading
  game state through Observables, buttons that act on the game, labels and health bars
  pinned to units with WorldAnchor, panels that block or pass clicks, and pause and other
  menus. Use when adding or changing a HUD element, a menu, a tooltip, a health bar, a
  turn banner or a settings screen, or when the HUD does not update, a click goes through
  a panel, or a React habit does not work. Not for images drawn inside the 3D scene with
  Canvas and Image (use `gameplay-scripting`), or for pops and shakes in the world (use
  `game-feel`).
---

# HUD and menus

The HUD is HTML drawn over the game canvas by **Preact** (`@synergy/ui`), not React and
not Unity's uGUI. The game and the HUD meet in one small module of `Observable`s
(`game/src/hud.ts`): game code writes them, components read them. Components never read
the scene, and game code never touches the DOM.

```
rules / behaviours  --set .value-->  Observable  --useObservable-->  component
component  --onClick-->  a method on a behaviour  --submits a command / calls an RPC
```

`game/src/ui/Hud.tsx` (commands) and `game/src/frontier/FrontierHud.tsx` (netcode) are
complete examples; `game/src/ui/styles.css` holds the layout.

## Workflow

1. **Decide what the element shows**, and add that to an `Observable` in
   `game/src/hud.ts` as plain data: numbers, strings, small objects. Not GameObjects,
   except as the target of a `WorldAnchor`.
2. **Set it where the game changes it**: in a command game, in the one function that
   refreshes views after a command; with netcode, in `onValueChanged`.
3. **Read it with `useObservable`** in a function component, and render.
4. **Act through a behaviour's method**, which checks and submits
   (`GameController.instance?.endTurn()`). A component never changes game state itself.
5. **Mark what should take clicks.** The overlay lets clicks through to the game; buttons,
   inputs and links take them back by themselves, and any other element that should
   block the game needs `data-interactive`.
6. **Lay it out in CSS** with edges and flexible boxes, not fixed pixel positions.
7. **Verify** with `bun run screenshot` (below).

## Patterns

State in, as one object per topic. Replace it; do not change it in place:

```ts
export interface HudState {
  gold: number;
  message: string;
}
export const hud = new Observable<HudState>({ gold: 0, message: '' });

// in game code, when gold changes:
hud.update((state) => ({ ...state, gold: state.gold + 25 }));
```

A component, and a button that acts on the game:

```tsx
import { useObservable } from '@synergy/ui';

export function GoldCounter() {
  const { gold, message } = useObservable(hud);
  return (
    <div className="gold" data-interactive>
      <strong>{gold}</strong>
      <span>{message}</span>
      <button type="button" onClick={() => GameController.instance?.endTurn()}>
        End turn
      </button>
    </div>
  );
}
```

A label that follows something in the world:

```tsx
<WorldAnchor target={unit.gameObject} offset={new Vector3(0, 1.6, 0)}>
  <div className="health" style={{ width: `${(unit.hp / unit.maxHp) * 100}%` }} />
</WorldAnchor>
```

A text field. Preact uses the browser's own events, so the one that fires on every
keystroke is `onInput`:

```tsx
const [name, setName] = useState('');
const field = <input value={name} onInput={(event) => setName(event.currentTarget.value)} />;
```

Something that happens once (a hit, a message) is a `UnityEvent`, not state: subscribe
with `useUnityEvent(event, listener)` and show it for a moment.

**Menus are a stack.** Keep one `Observable<string[]>` of open screens; the last one is
on top and is the only one shown as active. "Back" removes the last. Three booleans
(`paused`, `inSettings`, `confirmOpen`) stop working at the third overlay.

**Pausing** is `Time.timeScale = 0`. The HUD keeps working: it is the browser's, not the
game's. Tweens and waits the menu itself uses must run on real time
(`tween.setUpdate(true)`, `WaitForSecondsRealtime`).

## Gotchas

- **The HUD does not update.** The object or array inside the `Observable` was changed in
  place (`hud.value.gold += 25`, `list.value.push(item)`). The value is the same object
  as before, so nothing is told. Assign a new one: `hud.update((s) => ({ ...s, gold }))`,
  `list.value = [...list.value, item]`.
- **`import ... from 'react'` fails to build.** React is not installed. Hooks come from
  `preact/hooks`, types such as `ComponentChildren` from `preact`; JSX needs no import.
- **A text field only updates when it loses focus.** `onChange` is the browser's change
  event in Preact. Use `onInput`.
- **A click on a panel also selects the unit behind it.** The panel is not interactive.
  Add `data-interactive` to it. (Buttons, inputs, links, labels already are.)
- **Nothing in the game can be clicked any more.** A full-screen element was marked
  `data-interactive` (a wrapper, a transparent overlay). Mark the panels, not the layer.
- **A component reads `GameController.instance.state` directly**, shows it once and never
  again. Nothing tells Preact that it changed. Go through an `Observable`.
- **Setting an `Observable` every frame** (from `update`) re-renders every frame. Set it
  when the value changes; for something that moves every frame, use `WorldAnchor` or
  `useFrame`, which write the element directly.
- **A label for every unit, re-rendered whenever any unit changes.** Give each item its
  `key`, and keep per-frame motion in `WorldAnchor`; then a change costs one small row.
- **`useEffect` with a listener and no cleanup** adds a listener on every mount. Return
  the function that removes it: `useEffect(() => event.addListener(listener), [event])`.
- **A HUD written for one window size.** Pin panels to edges and corners and let the
  middle flex; then check a narrow and a wide screenshot.
- **Colour as the only signal** (red for the enemy, green for ready). Add a shape, an
  icon or a word; about one player in twelve cannot tell some pairs apart.
- **`useSyncExternalStore`, `forwardRef`, `memo`, `createPortal`** are in `preact/compat`,
  not in Preact itself. Prefer `useObservable` and plain components.
- **Text baked into the 3D scene's `Canvas`** for something a button would do better.
  `Canvas` and `Image` draw pictures in the scene; anything with text, input or layout is
  the Preact HUD.

## Verify

The HUD needs a browser, so headless tests do not reach it. What a test *can* hold is
the other side: that game code set the `Observable` (`expect(hud.value.gold).toBe(25)`
after the command).

For the HUD itself:

```bash
bun run screenshot --width 1280 --height 720 --out .screenshots/hud.png
```

```bash
bun run screenshot --width 800 --height 900 --out .screenshots/hud-narrow.png
```

Open each image and look: nothing clipped, nothing overlapping, text readable. To check a
button, find it and click it, then look again; `--click x,y` takes the position in CSS
pixels, and the run fails if the page logged an error:

```bash
bun run screenshot --click 640,680 --wait 300 --out .screenshots/after-click.png
```

A pass is `bun run check` ending in `PASSED` and screenshots you have opened. Keyboard
and gamepad focus, and how it reads at a glance during play, are for the user: ask them
to play through each menu and report.
