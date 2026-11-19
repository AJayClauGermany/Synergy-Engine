import {
  Camera,
  type Engine,
  findObjectsByType,
  type GameObject,
  Grid,
  MeshRenderer,
  Physics,
  RectTransform,
  SpriteRenderer,
  Tilemap,
  TilemapRenderer,
  Canvas,
  type Bounds,
  Mathf,
  Transform,
  type Vector3,
} from '@synergy/engine';

/**
 * What is under a point of the game view, for the feedback tool. The page has three
 * kinds of thing a person can mean when they click, and none of them knows the others:
 *
 * - the HUD: HTML drawn over the canvas (`hudElementAt`, in `hud.ts`);
 * - what the engine draws: GameObjects, including `Canvas` images (`pickWorld`);
 * - the map: a cell of a `Grid`, which is not a GameObject of its own.
 *
 * Positions here are **view** positions: CSS pixels from the top-left of the game view,
 * as HTML measures. Unity's screen space has y up; `toScreen` converts.
 */
export interface ViewPoint {
  readonly x: number;
  readonly y: number;
}

/** A rectangle in the game view: CSS pixels, `x` and `y` from its top-left. */
export interface ViewRect extends ViewPoint {
  readonly width: number;
  readonly height: number;
}

/** A cell of a grid, and the grid it belongs to. */
export interface CellPick {
  readonly grid: Grid;
  readonly cell: { readonly x: number; readonly y: number };
}

export type WorldPick =
  | { readonly kind: 'gameObject'; readonly gameObject: GameObject; readonly cell: CellPick | null }
  | { readonly kind: 'tile'; readonly cell: CellPick }
  | { readonly kind: 'empty' };

const round = (value: number): number => Math.round(value * 10) / 10;

/** The rectangle around some view points, or `null` when there are none. */
function around(points: readonly ViewPoint[]): ViewRect | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: round(x), y: round(y), width: round(Math.max(...xs) - x), height: round(Math.max(...ys) - y) };
}

function camera(): Camera | null {
  return Camera.main ?? Camera.allCameras[0] ?? null;
}

/** A world position in the view, or `null` when it is behind the camera. */
function project(engine: Engine, eye: Camera, position: Vector3): ViewPoint | null {
  const screen = eye.worldToScreenPoint(position);
  return screen.z > 0 ? { x: screen.x, y: engine.canvasSize.height - screen.y } : null;
}

/** Where a `Canvas` image is in the view. PlayCanvas keeps its corners in canvas pixels, y up. */
function rectOfUi(engine: Engine, rect: RectTransform): ViewRect | null {
  const corners = rect.pcElement.screenCorners;
  const { width, height } = engine.canvasSize;
  // Canvas pixels are device pixels; the view is measured in CSS pixels.
  const scale = engine.isHeadless || engine.canvas.width === 0 ? 1 : width / engine.canvas.width;
  return around(corners.map((corner) => ({ x: corner.x * scale, y: height - corner.y * scale })));
}

function isUi(gameObject: GameObject): RectTransform | null {
  return gameObject.getComponent(RectTransform);
}

function ownBounds(gameObject: GameObject): Bounds | null {
  const renderer = gameObject.getComponent(MeshRenderer) ?? gameObject.getComponent(SpriteRenderer);
  if (!renderer) return null;
  const bounds = renderer.bounds;
  return bounds.size.sqrMagnitude > 0 ? bounds : null;
}

/** The box around everything a GameObject and its children draw, or `null` when they draw nothing. */
function boundsOf(gameObject: GameObject): Bounds | null {
  let all: Bounds | null = null;
  for (const transform of gameObject.getComponentsInChildren(Transform)) {
    const part = ownBounds(transform.gameObject);
    if (part) all = all ? all.encapsulate(part.min).encapsulate(part.max) : part;
  }
  return all;
}

/**
 * Where a GameObject shows in the view: a `Canvas` image's rectangle, the box around what
 * it and its children draw (cut to the view), or a small square on its position when it
 * draws nothing. `null` when it is behind the camera or there is no camera.
 */
export function viewRectOf(engine: Engine, gameObject: GameObject): ViewRect | null {
  const ui = isUi(gameObject);
  if (ui) return rectOfUi(engine, ui);
  const eye = camera();
  if (!eye) return null;
  const bounds = engine.isHeadless ? null : boundsOf(gameObject);
  if (bounds) {
    const { min, max } = bounds;
    const { width, height } = engine.canvasSize;
    const corners: ViewPoint[] = [];
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const point = project(engine, eye, min.withX(x).withY(y).withZ(z));
          // A floor reaches far past the view; its outline is the part that shows.
          if (point) corners.push({ x: Mathf.clamp(point.x, 0, width), y: Mathf.clamp(point.y, 0, height) });
        }
    const box = around(corners);
    if (box && box.width > 0 && box.height > 0) return box;
  }
  const centre = project(engine, eye, gameObject.transform.position);
  return centre && { x: round(centre.x - 14), y: round(centre.y - 14), width: 28, height: 28 };
}

/** Where a cell shows in the view. */
export function viewRectOfCell(engine: Engine, pick: CellPick): ViewRect | null {
  const eye = camera();
  if (!eye) return null;
  const corners = pick.grid.getCellCornersWorld(pick.cell).flatMap((corner) => project(engine, eye, corner) ?? []);
  return around(corners);
}

const inside = (rect: ViewRect, point: ViewPoint): boolean =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

/**
 * What the engine draws under a view point. A `Canvas` image wins over the world, as it
 * is drawn over it; then the nearest GameObject the ray meets (its collider, or the box
 * around what it renders, so objects without colliders can be picked too); then the map
 * cell. A GameObject standing on a map comes back with its cell.
 */
export function pickWorld(engine: Engine, point: ViewPoint): WorldPick {
  return engine.run((): WorldPick => {
    // Later in the scene is drawn later, so the last image under the point is the one seen.
    const image = findObjectsByType(RectTransform)
      .filter((rect) => !rect.gameObject.getComponent(Canvas))
      .findLast((rect) => {
        const box = rectOfUi(engine, rect);
        return box !== null && box.width > 0 && box.height > 0 && inside(box, point);
      });
    if (image) return { kind: 'gameObject', gameObject: image.gameObject, cell: null };

    const eye = camera();
    if (!eye) return { kind: 'empty' };
    const ray = eye.screenPointToRay({ x: point.x, y: engine.canvasSize.height - point.y });

    let cell: CellPick | null = null;
    let cellDistance = Number.POSITIVE_INFINITY;
    for (const grid of findObjectsByType(Grid)) {
      const hit = grid.raycast(ray);
      if (!hit || hit.distance >= cellDistance) continue;
      const at = { x: hit.cell.x, y: hit.cell.y };
      if (!grid.gameObject.getComponentsInChildren(Tilemap).some((tilemap) => tilemap.hasTile(at))) continue;
      cell = { grid, cell: at };
      cellDistance = hit.distance;
    }

    const hits = Physics.raycastAll(ray, Number.POSITIVE_INFINITY, Physics.allLayers);
    const met: { gameObject: GameObject; distance: number }[] = hits.map((hit) => ({
      gameObject: hit.gameObject,
      distance: hit.distance,
    }));
    if (!engine.isHeadless) {
      for (const renderer of [...findObjectsByType(MeshRenderer), ...findObjectsByType(SpriteRenderer)]) {
        const { gameObject } = renderer;
        // A tilemap is one box around the whole map; its cells are picked as cells.
        if (gameObject.getComponent(TilemapRenderer) || gameObject.getComponent(Grid)) continue;
        const distance = ownBounds(gameObject)?.intersectRay(ray);
        if (distance !== null && distance !== undefined) met.push({ gameObject, distance });
      }
    }
    const first = met.toSorted((a, b) => a.distance - b.distance)[0]?.gameObject ?? null;
    // A unit is its collider; the mesh under it is a part. When the nearest thing drawn
    // belongs to something the ray also hit, the click meant the whole.
    const whole =
      first && hits.find((hit) => hit.gameObject !== first && first.transform.isChildOf(hit.gameObject.transform));
    const nearest = whole?.gameObject ?? first;
    if (nearest) return { kind: 'gameObject', gameObject: nearest, cell };
    return cell ? { kind: 'tile', cell } : { kind: 'empty' };
  });
}
