---
name: game-feel
description: >
  Adds feedback ("juice") to a mechanic that already works: eased tweens, squash and
  stretch, hit-stop, camera shake, pops and flashes, built on Tween, coroutines and
  Time.timeScale as a layer that only shows things. Use when a hit, move, pickup or button
  feels flat, weightless or hard to read, or when something should pop, shake, bounce or
  freeze for a moment. Not for where the camera looks (use `camera-controls`), HUD layout
  (use `hud-ui`), or anything that changes the state of the game (use `multiplayer` or
  `netcode`).
---

# Game feel

Feedback sells an action: a few small, short, exaggerated responses fired together on one
event. It is a layer on top of the game, and it only shows things. Rules and
`NetworkVariable`s never wait for a tween, read a scale or depend on a shake; if the
feedback were deleted the game would play the same and merely feel dead. That is what
keeps it safe to add late and safe in multiplayer.

## Workflow

1. **Find the event.** Feedback hangs on the moment a view learns that something
   happened: in a command game, where the controller compares the state before and after
   a command (`GameController.receive` in `game/src/behaviours/GameController.ts`); with
   netcode, a variable's `onValueChanged` (`game/src/frontier/Soldier.ts`). If no such
   moment exists yet, make one (a `UnityEvent` on the view) before adding effects. Never
   poll for "did the health drop" in `update`.
2. **Give the event a tier** and keep to it everywhere, so the game stays proportional:

   | Tier | Shake (trauma) | Hit-stop | Used for |
   |------|----------------|----------|----------|
   | small | 0 to 0.2 | none | select, move, hover, a step |
   | medium | 0.3 to 0.5 | 0.04 to 0.06 s | a normal hit, a capture, a pickup |
   | large | 0.7 to 1 | 0.1 to 0.15 s | a kill, a critical hit, winning |

3. **Fire two or three channels at once** (motion, colour, sound when there is sound),
   from one function per tier, and add more only until the event reads.
4. **Ease everything that moves.** `Ease.OutBack` overshoots and settles (pops),
   `Ease.OutCubic` settles (arrivals), `Ease.InQuad` winds up (anticipation). Linear
   motion looks mechanical.
5. **Decide what ignores `Time.timeScale`.** Hit-stop and pause scale time. Shake decay,
   menu and HUD tweens must keep running: `Time.unscaledDeltaTime`,
   `WaitForSecondsRealtime`, `tween.setUpdate(true)`.
6. **Give the player the dials**: a shake strength from 0 to 1 and a "reduce flashing"
   setting, read by the effect code.
7. **Verify** (below): a headless test for what must return to rest, then ask the user to
   play it.

## Patterns

A pop: start squashed, spring back. The scale ends exactly at rest because the tween's
last value is its target.

```ts
transform.localScale = new Vector3(1.3, 0.7, 1.3);
Tween.kill(gameObject);                       // an earlier pop still running would fight this one
Tween.scale(transform, Vector3.one, 0.18).setEase(Ease.OutBack);
```

Hit-stop: slow time for a moment of real time. Hits overlap, so only the newest call
restores the scale.

```ts
export class HitStop extends MonoBehaviour {
  private _stops = 0;

  stop(seconds = 0.08, slow = 0.05) {
    this.startCoroutine(this.run(seconds, slow));
  }

  private *run(seconds: number, slow: number): IEnumerator {
    const mine = ++this._stops;
    Time.timeScale = slow;
    yield new WaitForSecondsRealtime(seconds);   // WaitForSeconds would wait 20 times longer
    if (mine === this._stops) Time.timeScale = 1;
  }
}
```

Shake from decaying "trauma". Hits add to it, the offset is its square (light hits barely
move, heavy ones punch), and it decays in real time so the camera is not left off-centre
when time stops.

```ts
export class CameraShake extends MonoBehaviour {
  decay = 1.5;        // trauma lost per second
  maxOffset = 0.4;    // world units at full trauma
  strength = 1;       // the player's setting, 0 to 1
  private _trauma = 0;
  private _clock = 0;

  addTrauma(amount: number) {
    this._trauma = Mathf.clamp01(this._trauma + amount);
  }

  lateUpdate() {
    if (this._trauma <= 0) return;
    const dt = Time.unscaledDeltaTime;
    this._trauma = Math.max(0, this._trauma - this.decay * dt);
    this._clock += dt * 30;
    const shake = this._trauma * this._trauma * this.strength * this.maxOffset;
    // Two sines at unrelated rates: smooth. A new random offset each frame buzzes.
    this.transform.localPosition = new Vector3(shake * Math.sin(this._clock * 1.7), shake * Math.sin(this._clock * 2.3), 0);
  }
}
```

Put `CameraShake` on the object that holds the `Camera`, and make that a **child** of the
object the camera rig positions (`rig.camera` then points at the parent, the "arm").
The rig writes the arm, the shake writes the camera's local offset, and neither undoes
the other.

Sequences are coroutines; a tween can be yielded:

```ts
*strike(target: Transform): IEnumerator {
  const home = this.transform.position;
  yield Tween.move(this.transform, target.position, 0.12).setEase(Ease.InQuad);    // lunge
  this.hit.invoke();                                                               // effects fire here
  yield Tween.move(this.transform, home, 0.2).setEase(Ease.OutCubic);              // recover
}
```

Numbers and labels that pop over a unit are HUD elements pinned with `WorldAnchor` and
animated in CSS: see the `hud-ui` skill.

## Gotchas

- **The game waits for an animation.** State changed in an `onComplete`, or a turn that
  ends "when the tween finishes", desyncs multiplayer and breaks when the tab is in the
  background. Change state first, through a command or on the host; animate what already
  happened.
- **Hit-stop never ends.** `WaitForSeconds` runs on scaled time: at a scale of 0.05 a
  0.08 s wait takes 1.6 s, and at 0 it never returns. Wait with `WaitForSecondsRealtime`.
- **Time stays slow after two quick hits.** The first hit-stop restored the scale in the
  middle of the second, or the second never restored it. Count the calls and let only the
  newest restore, as above.
- **The object that shakes is the one the rig positions**, so the shake is overwritten
  or the rig drifts. Shake a child's `localPosition`.
- **Shaking the unit instead of the camera** moves what raycasts and clicks hit. Shake
  the camera, or a child that holds only the mesh.
- **Scale creeps after repeated pops.** A new tween started from a half-finished one.
  `Tween.kill(gameObject)` first and tween to an absolute rest value, never "current
  times 1.2".
- **A tween on a destroyed object.** `Tween.move/scale/rotate` stop by themselves when
  their object is destroyed. `Tween.to(...)` has no object: add `.setTarget(gameObject)`
  or it keeps calling your function.
- **The pause menu's animations freeze** with `Time.timeScale = 0`. Give them
  `.setUpdate(true)`; CSS animations in the HUD are not affected by the time scale.
- **A coroutine stops when its GameObject is deactivated**, so an effect started on a
  unit that is hidden the next moment never finishes its last step. Run the effect on an
  object that outlives it.
- **Too much.** Shake and hit-stop on routine actions tire the eye and hide the hits that
  matter. Selection and movement get the small tier.
- **Flashing.** More than three bright full-screen flashes a second is a photosensitivity
  hazard. Tint instead, and honour the reduce-flashing setting.

## Verify

Effects must return to rest, and a headless test can say so. With an engine from
`Engine.createHeadless()` (`verify-changes` has the frame of the test):

```ts
test('two quick hits leave time running', () => {
  const fx = new GameObject('Effects').addComponent(HitStop);
  fx.stop(0.1);
  engine.stepFrames(2);
  fx.stop(0.1);
  engine.stepFrames(5);                    // the first stop is over, the second is not
  expect(Time.timeScale).toBe(0.05);
  engine.stepFrames(4);
  expect(Time.timeScale).toBe(1);
});
```

Use `engine.stepFrames(n)` while time is slowed or stopped: `engine.stepSeconds` counts
game time, which is not passing. Check the same way that trauma reaches zero and leaves
`localPosition` at `Vector3.zero`, and that a scale tween ends at exactly its rest value.

A screenshot cannot show motion. After `bun run check` passes, ask the user to play and
report: does the hit read, does anything feel sickening or laggy, does input still
register during a freeze. Say plainly that the feel itself was not judged by you.
