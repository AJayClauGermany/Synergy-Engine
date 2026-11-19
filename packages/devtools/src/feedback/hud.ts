import { options, type VNode } from 'preact';

/**
 * The HUD side of the feedback tool: which HTML element is under a point, where it was
 * written, and which components drew it.
 *
 * The file and line come from the `data-source` attribute a development build writes on
 * every JSX element (`scripts/jsxSource.ts`). The components come from Preact's tree,
 * which is followed through two of its internal fields; when a version of Preact names
 * them differently the component list is empty and everything else still works.
 */
export const SOURCE_ATTRIBUTE = 'data-source';

/** The editor's own root: nothing under it is the game. */
const EDITOR = '#synergy-editor';

/** One component above an element: its name and where it is used. */
export interface ComponentUse {
  readonly name: string;
  /** `file:line:column` of the `<Name ...>` that put it there, or `null`. */
  readonly source: string | null;
}

/** The fields of Preact's vnodes this reads: `__` is the parent, `__e` the element. */
interface InternalVNode extends VNode {
  __?: InternalVNode | null;
  __e?: unknown;
}

const vnodes = new WeakMap<Element, InternalVNode>();
let watching = false;

/**
 * Starts remembering which vnode drew each element, so `componentsOf` can answer.
 * Call it before the HUD first renders. Safe to call twice.
 */
export function watchPreactTree(): void {
  if (watching) return;
  watching = true;
  const previous = options.diffed;
  options.diffed = (vnode) => {
    const { __e: element } = vnode as InternalVNode;
    if (typeof vnode.type === 'string' && typeof Element !== 'undefined' && element instanceof Element) {
      vnodes.set(element, vnode);
    }
    previous?.(vnode);
  };
}

/** The components that drew `element`, outermost first. Empty when Preact did not draw it. */
export function componentsOf(element: Element): ComponentUse[] {
  const uses: ComponentUse[] = [];
  for (let vnode = vnodes.get(element)?.__; vnode; vnode = vnode.__) {
    const { type } = vnode;
    if (typeof type !== 'function') continue;
    const name = type.displayName || type.name;
    // Fragments, and wrappers a bundler shortened to a letter, say nothing useful.
    if (!name || name.length < 3 || name === 'Fragment') continue;
    const source = (vnode.props as Record<string, unknown>)[SOURCE_ATTRIBUTE];
    uses.unshift({ name, source: typeof source === 'string' ? source : null });
  }
  return uses;
}

/** `file:line:column` of the JSX that wrote this element, or `null` (a release build, or HTML made by hand). */
export function sourceOf(element: Element): string | null {
  return element.getAttribute(SOURCE_ATTRIBUTE);
}

const LEAVES = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'PROGRESS', 'METER']);

const transparent = (color: string): boolean => color === 'transparent' || /,\s*0\)$/.test(color) || color === '';

/**
 * Whether an element puts something on the screen itself: text, an image, a control, a
 * background or a border. A HUD is full of invisible boxes that only lay their children
 * out, often covering the whole view; clicking "through" one must reach the game.
 */
function paints(element: Element, style: CSSStyleDeclaration): boolean {
  if (LEAVES.has(element.tagName.toUpperCase())) return true;
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  if (!transparent(style.backgroundColor) || style.backgroundImage !== 'none') return true;
  if (style.boxShadow !== 'none') return true;
  return (['Top', 'Right', 'Bottom', 'Left'] as const).some(
    (side) =>
      Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
      style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
      !transparent(style.getPropertyValue(`border-${side.toLowerCase()}-color`)),
  );
}

/**
 * The HUD element drawn at a point of the page (`clientX`, `clientY`), or `null` when the
 * point shows the game. The browser's own `elementFromPoint` cannot answer this: the HUD
 * lets clicks through to the game (`pointer-events: none`), and the browser skips such
 * elements. `game` is the canvas: it and what holds it are never the answer.
 */
export function hudElementAt(clientX: number, clientY: number, game: Element | null): Element | null {
  let found: Element | null = null;
  // Document order is paint order near enough for a HUD: later and deeper is on top.
  for (const element of document.body.querySelectorAll('*')) {
    // The canvas and whatever holds it are behind the game, however they are painted.
    if ((game && element.contains(game)) || element.closest(EDITOR)) continue;
    const tag = element.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    // The inside of a drawing is one thing to a person: the drawing.
    if (tag !== 'SVG' && element.closest('svg')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (paints(element, style)) found = element;
  }
  return found;
}

/** `h1.title`, `button#start.primary.big`: enough to recognise the element in the code. */
export function tagOf(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = [...element.classList].slice(0, 3).map((name) => `.${name}`);
  return `${element.tagName.toLowerCase()}${id}${classes.join('')}`;
}

/** A CSS path from the HUD's root down to the element: `div.menu > h1.title`. */
export function selectorOf(element: Element): string {
  const parts: string[] = [];
  for (let at: Element | null = element; at && at !== document.body; at = at.parentElement) {
    let part = tagOf(at);
    const parent: Element | null = at.parentElement;
    const twins = parent ? [...parent.children].filter((child) => tagOf(child) === part) : [];
    if (twins.length > 1)
      part += `:nth-of-type(${[...(parent?.children ?? [])].filter((c) => c.tagName === at.tagName).indexOf(at) + 1})`;
    parts.unshift(part);
    if (at.classList.contains('synergy-ui')) break;
  }
  return parts.join(' > ');
}

/**
 * The CSS rules of the page's stylesheets that apply to the element, as written: the
 * selector is what to search the game's CSS for. Rules inside `@media` and the like are
 * included when they apply now.
 */
export function cssRulesOf(element: Element): string[] {
  const found: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        let applies = false;
        try {
          applies = element.matches(rule.selectorText);
        } catch {
          // A selector this browser cannot test (a pseudo-element) is not one to report.
        }
        if (applies) found.push(rule.cssText);
      } else if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) visit(rule.cssRules);
      } else if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A stylesheet from another origin cannot be read.
    }
  }
  return found;
}
