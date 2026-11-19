import type { FeedbackNote } from './format';
import type { ViewRect } from './pick';

/**
 * The pictures that go with feedback: the game view with the HUD drawn over it, each
 * note's target outlined and numbered, and a close-up per note. The engine's own
 * screenshot is the canvas alone; a note about a HUD title needs the title in the picture.
 *
 * The HUD is HTML, which a page cannot photograph. It is redrawn here from a copy with
 * its styles written in, through an SVG image. That is close, not exact: web fonts fall
 * back to the system's, and images the HUD loads by URL are left out. When the browser
 * refuses even that, the picture has the game and the outlines, and says so.
 */
export interface FeedbackImages {
  /** PNG data URLs by file name: `feedback.png`, `note-1.png`, ... */
  readonly images: Readonly<Record<string, string>>;
  /** False when the HUD could not be drawn into the picture. */
  readonly hud: boolean;
}

const MARK = '#ff7a1a';
const EXPECTED = '#2ee6a6';

function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** A copy of `root` that looks the same with no stylesheet: every computed style written on the element. */
function frozen(root: Element): Element {
  const copy = root.cloneNode(true) as Element;
  const originals = [root, ...root.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const target = copies[index];
    if (!(target instanceof HTMLElement || target instanceof SVGElement)) return;
    const style = getComputedStyle(original);
    let text = '';
    for (const name of style) text += `${name}:${style.getPropertyValue(name)};`;
    target.setAttribute('style', text);
    // An image by URL would make the browser refuse to read the picture back.
    if (target instanceof HTMLImageElement && !target.src.startsWith('data:')) target.removeAttribute('src');
  });
  return copy;
}

/** One HUD root as an image the size of its box, or `null` when the browser cannot make one. */
function hudImage(root: Element): Promise<HTMLImageElement | null> {
  const { width, height } = root.getBoundingClientRect();
  if (width <= 0 || height <= 0) return Promise.resolve(null);
  const copy = frozen(root);
  copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  const html = new XMLSerializer().serializeToString(copy);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${html}</foreignObject></svg>`;
  return load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function outline(context: CanvasRenderingContext2D, rect: ViewRect, label: string): void {
  context.save();
  context.strokeStyle = MARK;
  context.lineWidth = 2;
  context.strokeRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
  context.restore();
  badge(context, rect.x - 2, rect.y - 2, label, MARK);
}

function badge(context: CanvasRenderingContext2D, x: number, y: number, label: string, color: string): void {
  context.save();
  context.font = 'bold 12px system-ui, sans-serif';
  const width = context.measureText(label).width + 10;
  // Above the corner; inside the view when the target is at its top edge.
  const top = y - 18 < 0 ? y : y - 18;
  context.fillStyle = color;
  context.fillRect(x, top, width, 18);
  context.fillStyle = '#111';
  context.textBaseline = 'middle';
  context.fillText(label, x + 5, top + 9);
  context.restore();
}

function arrow(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  context.save();
  context.strokeStyle = EXPECTED;
  context.fillStyle = EXPECTED;
  context.lineWidth = 2;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - 10 * Math.cos(angle - 0.4), to.y - 10 * Math.sin(angle - 0.4));
  context.lineTo(to.x - 10 * Math.cos(angle + 0.4), to.y - 10 * Math.sin(angle + 0.4));
  context.fill();
  // A cross on the spot itself.
  context.beginPath();
  context.moveTo(to.x - 7, to.y);
  context.lineTo(to.x + 7, to.y);
  context.moveTo(to.x, to.y - 7);
  context.lineTo(to.x, to.y + 7);
  context.stroke();
  context.restore();
}

function draw(context: CanvasRenderingContext2D, note: FeedbackNote): void {
  const { rect } = note.target;
  const centre = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : note.at;
  if (rect) outline(context, rect, String(note.id));
  else {
    context.save();
    context.strokeStyle = MARK;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(note.at.x, note.at.y, 9, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    badge(context, note.at.x + 10, note.at.y - 2, String(note.id), MARK);
  }
  if (note.expected) {
    arrow(context, centre, note.expected);
    badge(context, note.expected.x + 9, note.expected.y + 24, `${note.id} expected`, EXPECTED);
  }
}

/**
 * Draws the pictures. `game` is the engine's screenshot of the canvas (or `null`), `view`
 * the canvas's place in the page, `roots` the HUD roots to draw over it.
 */
export async function drawFeedbackImages(
  game: string | null,
  view: DOMRect,
  roots: readonly Element[],
  notes: readonly FeedbackNote[],
): Promise<FeedbackImages> {
  const scale = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(view.width * scale);
  canvas.height = Math.round(view.height * scale);
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0 || canvas.height === 0) return { images: {}, hud: false };
  context.scale(scale, scale);
  context.fillStyle = '#000';
  context.fillRect(0, 0, view.width, view.height);
  const background = game ? await load(game) : null;
  if (background) context.drawImage(background, 0, 0, view.width, view.height);

  let hud = true;
  for (const root of roots) {
    const image = await hudImage(root).catch(() => null);
    if (!image) {
      hud = false;
      continue;
    }
    const box = root.getBoundingClientRect();
    context.drawImage(image, box.left - view.left, box.top - view.top, box.width, box.height);
  }
  // A picture the browser will not give back is no picture: start again without the HUD.
  try {
    canvas.toDataURL('image/png');
  } catch {
    hud = false;
    context.fillRect(0, 0, view.width, view.height);
    if (background) context.drawImage(background, 0, 0, view.width, view.height);
  }

  // Close-ups come from the picture before the marks of other notes are on it.
  const clean = document.createElement('canvas');
  clean.width = canvas.width;
  clean.height = canvas.height;
  clean.getContext('2d')?.drawImage(canvas, 0, 0);

  const images: Record<string, string> = {};
  for (const note of notes) {
    const rect = note.target.rect ?? { x: note.at.x, y: note.at.y, width: 0, height: 0 };
    const points = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      ...(note.expected ? [note.expected] : []),
    ];
    const margin = 90;
    const left = Math.max(0, Math.min(...points.map((point) => point.x)) - margin);
    const top = Math.max(0, Math.min(...points.map((point) => point.y)) - margin);
    const right = Math.min(view.width, Math.max(...points.map((point) => point.x)) + margin);
    const bottom = Math.min(view.height, Math.max(...points.map((point) => point.y)) + margin);
    if (right - left < 4 || bottom - top < 4) continue;
    const crop = document.createElement('canvas');
    crop.width = Math.round((right - left) * scale);
    crop.height = Math.round((bottom - top) * scale);
    const cropContext = crop.getContext('2d');
    if (!cropContext) continue;
    cropContext.drawImage(clean, -left * scale, -top * scale);
    cropContext.scale(scale, scale);
    cropContext.translate(-left, -top);
    draw(cropContext, note);
    images[`note-${note.id}.png`] = crop.toDataURL('image/png');
  }
  for (const note of notes) draw(context, note);
  images['feedback.png'] = canvas.toDataURL('image/png');
  return { images, hud };
}
