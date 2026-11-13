---
name: camera-controls
description: >
  Builds and tunes the camera of a strategy game on this engine: a rig that pans, zooms
  and rotates over a map, edge scrolling, dragging the ground, limits so the view never
  leaves the map, smoothing that is the same at any frame rate, and moving the view to a
  unit or an event. Use when the camera should follow, focus, scroll or zoom, or when it
  jitters, drifts, shows past the map, moves faster on a fast machine, or pans the wrong
  way. Not for shake and other feedback (use `game-feel`), or for turning a click into a
  cell or an object (use `tile-maps` or `gameplay-scripting`).
---

# Camera controls

The sample's `game/src/behaviours/CameraRig.ts` is a working strategy camera: start from
it. Its shape is the one to keep. An empty object, the **rig**, sits on the ground at the
point being looked at. The camera is its child, raised and pulled back. Panning moves the
rig, rotating turns the rig, zooming changes how far back the child sits. Each control
then touches one number, and none of them fights another.

```
Camera Rig   (CameraRig)        position = the point looked at, rotation = yaw
  Main Camera (Camera)          tag MainCamera; local position from pitch and distance
```

## Workflow

1. **Read the rig that exists** and what the scene sets on it
   (`game/src/scenes/SkirmishScene.ts`). Extend it; do not add a second script that also
   moves the camera.
2. **Move in `update`, place in `lateUpdate`.** Input changes the rig's numbers in
   `update`; the camera's transform is written once, in `lateUpdate`, after everything
   else has moved.
3. **Use unscaled time** (`Time.unscaledDeltaTime`): the camera keeps working while the
   game is paused or in slow motion.
4. **Smooth with `1 - Math.exp(-rate * dt)`**, never a fixed fraction per frame.
5. **Clamp the point looked at** to the map, and the distance to a range.
6. **Turn screen input into world movement through the rig's rotation**, so "up" on the
   screen is still "away" after the player has rotated the view.
7. **Verify** with a headless test that moves the mouse and steps frames (below).

## Patterns

These are members of the rig script. `moveBy` is the one place that changes the rig's
position, so the limits cannot be forgotten:

```ts
bounds = 6;

moveBy(delta: Vector3) {
  const moved = this.transform.position.add(delta);
  this.transform.position = new Vector3(
    Mathf.clamp(moved.x, -this.bounds, this.bounds),
    0,
    Mathf.clamp(moved.z, -this.bounds, this.bounds),
  );
}
```

Smoothing toward a target, the same at 30 and at 144 frames a second. `rate` is in
"per second": 12 is snappy, 4 is floaty.

```ts
this.distance = Mathf.lerp(this.distance, this.targetDistance, 1 - Math.exp(-12 * Time.unscaledDeltaTime));
```

Edge scrolling. Screen space is Unity's: origin at the **bottom left**, `y` grows upward,
so the top edge is a large `y`. The screen's "up" is the rig's forward (+Z):

```ts
edge = 24;        // pixels
panSpeed = 8;

private edgeScroll(dt: number) {
  if (!Input.mousePresent) return;       // the pointer has not been over the game yet
  const mouse = Input.mousePosition;
  const pan = new Vector3(
    (mouse.x > Screen.width - this.edge ? 1 : 0) - (mouse.x < this.edge ? 1 : 0),
    0,
    (mouse.y > Screen.height - this.edge ? 1 : 0) - (mouse.y < this.edge ? 1 : 0),
  );
  if (pan.sqrMagnitude > 0) this.moveBy(this.transform.rotation.rotate(pan).mul(this.panSpeed * dt));
}
```

Dragging the ground with the right button: remember the ground point under the cursor
when the button goes down, then move the rig so that point stays under the cursor.

```ts
private _grab: Vector3 | null = null;

private drag() {
  const camera = Camera.main;
  if (!camera) return;
  const ray = camera.screenPointToRay(Input.mousePosition);
  const distance = new Plane(Vector3.up, Vector3.zero).raycast(ray);
  const ground = distance === null ? null : ray.getPoint(distance);
  if (Input.getMouseButtonDown(1)) this._grab = ground;
  if (!Input.getMouseButton(1)) this._grab = null;
  if (this._grab && ground) this.moveBy(this._grab.sub(ground));
}
```

Moving the view to something (a unit that was attacked, the start of a turn). One tween,
on real time, replacing any that is still running:

```ts
focusOn(point: Vector3) {
  Tween.kill(this.gameObject);
  Tween.move(this.transform, new Vector3(point.x, 0, point.z), 0.35).setEase(Ease.OutCubic).setUpdate(true);
}
```

**Zoom toward the cursor** rather than the centre: before changing the distance, find
the ground point under the cursor (as in `drag`); after, find it again and `moveBy` the
difference.

**A flat 2D view**: `camera.orthographic = true` and zoom with `orthographicSize` (half
the view's height in world units) in place of the distance. Everything else is the same.

## Gotchas

- **The camera glides to a corner when the game starts.** Edge scrolling read
  `Input.mousePosition` before the mouse had ever been over the canvas, when it is
  `(0, 0)`: the bottom-left corner. Check `Input.mousePresent` first.
- **HTML placed with screen coordinates sits upside down.** Screen `y` grows upward (as
  in Unity) but CSS `top` grows downward: `top = Screen.height - y`.
- **Faster on a fast machine, floatier on a slow one.** `Mathf.lerp(a, b, 0.1)` once per
  frame depends on the frame rate. Use `1 - Math.exp(-rate * dt)`.
- **Panning goes sideways after rotating.** The input was added to the world position
  directly. Rotate it by the rig's rotation first.
- **The camera stops when the game is paused**, so the player cannot look around.
  `Time.deltaTime` is zero at `Time.timeScale = 0`; use `Time.unscaledDeltaTime`.
- **Rotating the wrong way.** A positive angle about Y turns clockwise seen from above
  (to the right), as in Unity. "Q turns left" therefore needs a negative yaw step.
- **The view shows past the map** at one zoom level but not another. The limit is on the
  point looked at, and how much is visible grows with the distance. Shrink the bounds as
  the distance grows, or accept an edge of background at full zoom-out.
- **Jitter when following a moving unit.** The camera was placed in `update`, before the
  unit moved this frame. Place it in `lateUpdate`.
- **A second script also moves the camera** (a shake, a cutscene), and they overwrite
  each other. One script owns the rig. Shake belongs on a child: see `game-feel`.
- **The camera is a child of a unit** to make it follow. It inherits every turn and bump
  of the unit, and dies with it. Keep the rig at the top level and follow by position.
- **The wheel zooms while the pointer is over a HUD panel**, or does not zoom at all over
  one. Elements marked `data-interactive` keep the wheel and clicks for themselves; that
  is usually wanted for a scrolling list and unwanted for a wide bar.
- **`Camera.main` is `null`**: no enabled camera is tagged `MainCamera`. Every scene
  needs one, and picking, `WorldAnchor` and `onMouse*` messages all depend on it.

## Verify

A headless engine has a screen (1280 by 720 unless told otherwise) and a mouse:

```ts
test('the top edge of the screen pans away from the viewer, and stops at the limit', () => {
  const rig = buildCamera();                       // the rig with its camera, as the scene builds it
  engine.input.moveMouse(Screen.width / 2, 2);     // top edge: a small y
  engine.stepSeconds(0.5);
  expect(rig.transform.position.z).toBeLessThan(-1);
  engine.stepSeconds(5);
  expect(rig.transform.position.z).toBe(-rig.bounds);
});
```

Test the same way that a drag keeps the grabbed point under the cursor
(`pressMouseButton(1)`, move, step), and that `focusOn` arrives while `Time.timeScale` is
0 (use `engine.stepFrames`, since game time is not passing). Then `bun run screenshot`
for the framing: is the board centred, is anything behind the HUD. `--key` and `--click`
drive it; `--eval "synergy.Camera.main?.transform.position"` reads where it ended up.

How it *feels* (speed, smoothing, zoom steps) is for the user to judge: ask them to pan
to each edge, zoom fully in and out, and rotate, and to report anything that drifts,
snaps or feels slow.
