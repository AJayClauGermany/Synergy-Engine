import {
  Component,
  Debug,
  type Engine,
  type GameObject,
  MonoBehaviour,
  RectTransform,
  Tilemap,
  Transform,
  typeNameOf,
} from '@synergy/engine';
import type { Block, Fact, TargetDescription } from './format';
import { componentsOf, cssRulesOf, selectorOf, sourceOf, tagOf } from './hud';
import { type CellPick, type ViewRect, viewRectOf, viewRectOfCell, type WorldPick } from './pick';

/**
 * Turns what was clicked into words an agent can act on without the game open: where the
 * code is, what it looks like now, and what is around it. Each line is marked with the
 * least detail at which it is shown (`FeedbackDetail`); everything is captured.
 */

const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const n = (value: number): string => String(Math.round(value * 10) / 10);
const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``;

/** An element's rectangle in the game view, whose top-left is at `origin` in the page. */
function rectIn(element: Element, origin: { left: number; top: number }): ViewRect {
  const rect = element.getBoundingClientRect();
  return {
    x: n1(rect.left - origin.left),
    y: n1(rect.top - origin.top),
    width: n1(rect.width),
    height: n1(rect.height),
  };
}
const n1 = (value: number): number => Math.round(value * 10) / 10;

const box = (rect: ViewRect): string => `left ${n(rect.x)}, top ${n(rect.y)}, ${n(rect.width)}×${n(rect.height)}`;

/** The styles that decide how an element looks, as the browser resolved them. */
const LOOK = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align'];
/** The styles that decide where an element is. */
const PLACE = ['display', 'position', 'margin', 'padding', 'width', 'height', 'inset', 'transform', 'align-self'];
/** The styles with which a parent places its children. */
const LAYOUT = [
  'display',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'padding',
  'grid-template-columns',
];

function styles(element: Element, names: readonly string[]): string {
  const style = getComputedStyle(element);
  return names
    .map((name) => [name, style.getPropertyValue(name)] as const)
    .filter(
      ([name, value]) =>
        value && !(name === 'transform' && value === 'none') && !(name === 'gap' && value === 'normal'),
    )
    .map(([name, value]) => `${name}: ${clip(value, 60)}`)
    .join('; ');
}

function oneLine(element: Element, origin: { left: number; top: number }): string {
  const source = sourceOf(element);
  const text = clip((element.textContent ?? '').trim().replace(/\s+/g, ' '), 40);
  return `<${tagOf(element)}>${text ? ` "${text}"` : ''} at ${box(rectIn(element, origin))}${source ? ` (${source})` : ''}`;
}

/** A HUD element: the JSX that wrote it, its text, its box, its styles, and what holds it. */
export function describeHud(element: Element, origin: { left: number; top: number }): TargetDescription {
  const rect = rectIn(element, origin);
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ');
  const source = sourceOf(element);
  const components = componentsOf(element);
  const parent = element.parentElement;
  const facts: Fact[] = [
    {
      label: 'Source',
      value: source
        ? code(source)
        : 'unknown (no `data-source` on it: not a development build, or the HTML was not written as JSX)',
      level: 'brief',
    },
    { label: 'Element', value: code(selectorOf(element)), level: 'brief' },
  ];
  if (text) facts.push({ label: 'Text', value: `"${clip(text, 160)}"`, level: 'brief' });
  if (components.length > 0) {
    facts.push({
      label: 'Drawn by',
      value: components.map((use) => (use.source ? `${use.name} (used at ${code(use.source)})` : use.name)).join(' > '),
      level: 'standard',
    });
  }
  facts.push(
    { label: 'Looks', value: styles(element, LOOK), level: 'standard' },
    { label: 'Placed with', value: styles(element, PLACE), level: 'standard' },
  );
  if (parent && parent !== document.body) {
    const outer = rectIn(parent, origin);
    facts.push(
      { label: 'Parent', value: `${oneLine(parent, origin)}; ${styles(parent, LAYOUT)}`, level: 'standard' },
      {
        label: "Space to the parent's edges",
        value:
          `left ${n(rect.x - outer.x)}, right ${n(outer.x + outer.width - rect.x - rect.width)}, ` +
          `top ${n(rect.y - outer.y)}, bottom ${n(outer.y + outer.height - rect.y - rect.height)}`,
        level: 'standard',
      },
    );
  }
  const rules = cssRulesOf(element);
  const blocks: Block[] = [];
  if (rules.length > 0) {
    blocks.push({
      title: 'CSS rules that apply to it (search the stylesheets for the selector)',
      text: clip(rules.map((rule) => clip(rule, 400)).join('\n'), 3000),
      lang: 'css',
      level: 'standard',
    });
  }
  blocks.push({ title: 'Its HTML', text: clip(element.outerHTML, 2000), lang: 'html', level: 'full' });
  if (parent && parent.children.length > 1) {
    blocks.push({
      title: 'It and its siblings, in order',
      text: [...parent.children]
        .slice(0, 30)
        .map((child) => `${child === element ? '→ ' : '  '}${oneLine(child, origin)}`)
        .join('\n'),
      lang: 'text',
      level: 'full',
    });
  }
  const ancestors: string[] = [];
  for (let at = parent; at && at !== document.body; at = at.parentElement) {
    ancestors.push(`${oneLine(at, origin)}; ${styles(at, LAYOUT)}`);
  }
  if (ancestors.length > 0) {
    blocks.push({ title: 'What holds it, innermost first', text: ancestors.join('\n'), lang: 'text', level: 'full' });
  }
  return {
    kind: 'HUD element',
    label: `<${tagOf(element)}>${text ? ` "${clip(text, 40)}"` : ''}`,
    rect,
    facts,
    blocks,
  };
}

/**
 * Where to look for a script. A bundler numbers a class whose name is used twice in the
 * build (`UnitView2`), so the name in the page can be one digit away from the file's.
 */
function scriptHint(name: string): string {
  const written = name.replace(/(\D)\d+$/, '$1');
  return written === name
    ? `${code(`class ${name}`)} (a file named ${name}.ts)`
    : `${code(`class ${written}`)} (a file named ${written}.ts; shown as ${name} in this build)`;
}

function pathOf(gameObject: GameObject): string {
  const names: string[] = [];
  for (let at: Transform | null = gameObject.transform; at; at = at.parent) names.unshift(at.gameObject.name);
  return `${gameObject.scene.name}: ${names.join(' / ')}`;
}

function describeCell(pick: CellPick): Fact[] {
  const { grid, cell } = pick;
  const tiles = grid.gameObject.getComponentsInChildren(Tilemap).flatMap((tilemap) => {
    const tile = tilemap.getTile(cell);
    if (!tile) return [];
    const data = (tile as { data?: unknown }).data;
    let shown = '';
    try {
      shown = data === undefined ? '' : ` ${clip(JSON.stringify(data) ?? '', 120)}`;
    } catch {
      shown = '';
    }
    return [`${tilemap.gameObject.name}: ${tile.name}${shown}`];
  });
  return [
    { label: 'Map cell', value: `(${cell.x}, ${cell.y}) of grid "${grid.gameObject.name}"`, level: 'brief' },
    { label: 'Tiles on that cell', value: tiles.join('; ') || 'none', level: 'brief' },
  ];
}

/** What the engine drew: a GameObject (with the map cell it is on), a map cell, or nothing. */
export function describeWorld(engine: Engine, pick: WorldPick): TargetDescription {
  return engine.run((): TargetDescription => {
    if (pick.kind === 'empty') {
      return {
        kind: 'Empty space',
        label: '(nothing is drawn there)',
        rect: null,
        facts: [{ label: 'Under the click', value: 'no HUD element, GameObject or map cell', level: 'brief' }],
        blocks: [],
      };
    }
    if (pick.kind === 'tile') {
      const { cell } = pick.cell;
      return {
        kind: 'Map cell',
        label: `(${cell.x}, ${cell.y})`,
        rect: viewRectOfCell(engine, pick.cell),
        facts: [
          ...describeCell(pick.cell),
          { label: 'Grid', value: code(pathOf(pick.cell.grid.gameObject)), level: 'standard' },
        ],
        blocks: [],
      };
    }
    const { gameObject } = pick;
    const components = gameObject.getComponents(Component);
    const scripts = components.filter((component) => component instanceof MonoBehaviour).map(typeNameOf);
    const position = gameObject.transform.position;
    const ui = gameObject.getComponent(RectTransform);
    const facts: Fact[] = [
      { label: 'GameObject', value: code(pathOf(gameObject)), level: 'brief' },
      {
        label: 'Components',
        value:
          components
            .filter((component) => !(component instanceof Transform))
            .map(typeNameOf)
            .join(', ') || 'none',
        level: 'brief',
      },
    ];
    if (scripts.length > 0) {
      facts.push({
        label: 'Scripts',
        value: scripts.map(scriptHint).join(', '),
        level: 'brief',
      });
    }
    if (ui) {
      const { anchoredPosition, sizeDelta, anchorMin, anchorMax, pivot } = ui;
      facts.push({
        label: 'RectTransform',
        value:
          `anchoredPosition (${n(anchoredPosition.x)}, ${n(anchoredPosition.y)}), sizeDelta (${n(sizeDelta.x)}, ${n(sizeDelta.y)}), ` +
          `anchors (${n(anchorMin.x)}, ${n(anchorMin.y)}) to (${n(anchorMax.x)}, ${n(anchorMax.y)}), pivot (${n(pivot.x)}, ${n(pivot.y)})`,
        level: 'brief',
      });
    } else {
      facts.push({
        label: 'World position',
        value: `(${n(position.x)}, ${n(position.y)}, ${n(position.z)})`,
        level: 'brief',
      });
    }
    if (pick.cell) facts.push(...describeCell(pick.cell));
    const parent = gameObject.transform.parent?.gameObject ?? null;
    const blocks: Block[] = [
      {
        title: 'As the Inspector shows it (script fields included)',
        text: Debug.hierarchy({ root: gameObject, depth: 1 }).trimEnd(),
        lang: 'text',
        level: 'standard',
      },
      {
        title: 'Everything under it',
        text: clip(Debug.hierarchy({ root: gameObject }).trimEnd(), 6000),
        lang: 'text',
        level: 'full',
      },
    ];
    if (parent) {
      blocks.push({
        title: 'Its parent and siblings',
        text: clip(Debug.hierarchy({ root: parent, depth: 1, fields: false }).trimEnd(), 3000),
        lang: 'text',
        level: 'full',
      });
    }
    return {
      kind: ui ? 'UI image' : 'GameObject',
      label: `"${gameObject.name}"`,
      rect: viewRectOf(engine, gameObject),
      facts,
      blocks,
    };
  });
}
