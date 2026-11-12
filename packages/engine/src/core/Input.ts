import { Mathf } from '../math/Mathf';
import { Vector2 } from '../math/Vector2';
import { Vector3 } from '../math/Vector3';
import { currentEngine } from './runtime';

// prettier-ignore
/**
 * Keyboard keys, named as in Unity. The values are DOM `KeyboardEvent.code` strings, so
 * they refer to physical key positions and WASD works on any keyboard layout.
 */
export const KeyCode = {
  A: 'KeyA', B: 'KeyB', C: 'KeyC', D: 'KeyD', E: 'KeyE', F: 'KeyF', G: 'KeyG', H: 'KeyH',
  I: 'KeyI', J: 'KeyJ', K: 'KeyK', L: 'KeyL', M: 'KeyM', N: 'KeyN', O: 'KeyO', P: 'KeyP',
  Q: 'KeyQ', R: 'KeyR', S: 'KeyS', T: 'KeyT', U: 'KeyU', V: 'KeyV', W: 'KeyW', X: 'KeyX',
  Y: 'KeyY', Z: 'KeyZ',
  Alpha0: 'Digit0', Alpha1: 'Digit1', Alpha2: 'Digit2', Alpha3: 'Digit3', Alpha4: 'Digit4',
  Alpha5: 'Digit5', Alpha6: 'Digit6', Alpha7: 'Digit7', Alpha8: 'Digit8', Alpha9: 'Digit9',
  Keypad0: 'Numpad0', Keypad1: 'Numpad1', Keypad2: 'Numpad2', Keypad3: 'Numpad3',
  Keypad4: 'Numpad4', Keypad5: 'Numpad5', Keypad6: 'Numpad6', Keypad7: 'Numpad7',
  Keypad8: 'Numpad8', Keypad9: 'Numpad9', KeypadEnter: 'NumpadEnter',
  KeypadPlus: 'NumpadAdd', KeypadMinus: 'NumpadSubtract',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  UpArrow: 'ArrowUp', DownArrow: 'ArrowDown', LeftArrow: 'ArrowLeft', RightArrow: 'ArrowRight',
  Space: 'Space', Return: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  LeftShift: 'ShiftLeft', RightShift: 'ShiftRight',
  LeftControl: 'ControlLeft', RightControl: 'ControlRight',
  LeftAlt: 'AltLeft', RightAlt: 'AltRight',
  LeftCommand: 'MetaLeft', RightCommand: 'MetaRight',
  Minus: 'Minus', Equals: 'Equal', LeftBracket: 'BracketLeft', RightBracket: 'BracketRight',
  Semicolon: 'Semicolon', Quote: 'Quote', BackQuote: 'Backquote', Comma: 'Comma',
  Period: 'Period', Slash: 'Slash', Backslash: 'Backslash',
} as const;

export type KeyCode = (typeof KeyCode)[keyof typeof KeyCode];

interface AxisBinding {
  positive: string[];
  negative: string[];
}

interface ButtonBinding {
  keys: string[];
  mouseButtons: number[];
}

/** How fast `getAxis` moves toward its target, in units per second (Unity's default sensitivity/gravity). */
const AXIS_SPEED = 3;

/**
 * @internal Per-engine input state behind the static `Input` API. Tests and tools can
 * drive it directly with the `press*` / `release*` / `moveMouse` methods.
 */
export class InputState {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly mouseHeld = new Set<number>();
  private readonly mousePressed = new Set<number>();
  private readonly mouseReleased = new Set<number>();
  private pendingMouseDelta = Vector2.zero;
  private pendingScroll = Vector2.zero;
  private readonly smoothedAxes = new Map<string, number>();

  mousePosition = Vector3.zero;
  mouseDelta = Vector2.zero;
  mouseScrollDelta = Vector2.zero;
  /** False until the pointer has been over the canvas at least once. */
  mousePresent = false;

  readonly axes = new Map<string, AxisBinding>([
    ['Horizontal', { positive: [KeyCode.D, KeyCode.RightArrow], negative: [KeyCode.A, KeyCode.LeftArrow] }],
    ['Vertical', { positive: [KeyCode.W, KeyCode.UpArrow], negative: [KeyCode.S, KeyCode.DownArrow] }],
  ]);

  readonly buttons = new Map<string, ButtonBinding>([
    ['Fire1', { keys: [KeyCode.LeftControl], mouseButtons: [0] }],
    ['Fire2', { keys: [KeyCode.LeftAlt], mouseButtons: [1] }],
    ['Fire3', { keys: [KeyCode.LeftShift], mouseButtons: [2] }],
    ['Jump', { keys: [KeyCode.Space], mouseButtons: [] }],
    ['Submit', { keys: [KeyCode.Return, KeyCode.KeypadEnter], mouseButtons: [] }],
    ['Cancel', { keys: [KeyCode.Escape], mouseButtons: [] }],
  ]);

  private detach: (() => void) | null = null;

  // ---- Feeding input (DOM listeners, tests, replays) ---------------------------------

  /** Holds a key down, as the keyboard would: `engine.input.pressKey(KeyCode.Space)`. */
  pressKey(code: KeyCode): void {
    if (this.held.has(code)) return; // key repeat
    this.held.add(code);
    this.pressed.add(code);
  }

  releaseKey(code: KeyCode): void {
    if (!this.held.delete(code)) return;
    this.released.add(code);
  }

  pressMouseButton(button: number): void {
    if (this.mouseHeld.has(button)) return;
    this.mouseHeld.add(button);
    this.mousePressed.add(button);
  }

  releaseMouseButton(button: number): void {
    if (!this.mouseHeld.delete(button)) return;
    this.mouseReleased.add(button);
  }

  /** Moves the pointer to canvas coordinates (CSS pixels, origin top-left). */
  moveMouse(x: number, y: number): void {
    if (this.mousePresent) {
      this.pendingMouseDelta = this.pendingMouseDelta.add(
        new Vector2(x - this.mousePosition.x, y - this.mousePosition.y),
      );
    }
    this.mousePresent = true;
    this.mousePosition = new Vector3(x, y, 0);
  }

  scroll(deltaX: number, deltaY: number): void {
    this.pendingScroll = this.pendingScroll.add(new Vector2(deltaX, deltaY));
  }

  releaseAll(): void {
    for (const code of [...this.held]) this.releaseKey(code as KeyCode);
    for (const button of [...this.mouseHeld]) this.releaseMouseButton(button);
  }

  // ---- Frame boundaries --------------------------------------------------------------

  /** Called by the engine at the start of a frame. */
  beginFrame(unscaledDeltaTime: number): void {
    this.mouseDelta = this.pendingMouseDelta;
    this.mouseScrollDelta = this.pendingScroll;
    this.pendingMouseDelta = Vector2.zero;
    this.pendingScroll = Vector2.zero;
    for (const name of this.axes.keys()) {
      const current = this.smoothedAxes.get(name) ?? 0;
      const target = this.getAxisRaw(name);
      this.smoothedAxes.set(name, Mathf.moveTowards(current, target, AXIS_SPEED * unscaledDeltaTime));
    }
  }

  /** Called by the engine at the end of a frame: "down"/"up" edges last exactly one frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
  }

  // ---- Queries -----------------------------------------------------------------------

  getKey(code: string): boolean {
    return this.held.has(code);
  }

  getKeyDown(code: string): boolean {
    return this.pressed.has(code);
  }

  getKeyUp(code: string): boolean {
    return this.released.has(code);
  }

  get anyKey(): boolean {
    return this.held.size > 0 || this.mouseHeld.size > 0;
  }

  get anyKeyDown(): boolean {
    return this.pressed.size > 0 || this.mousePressed.size > 0;
  }

  getMouseButton(button: number): boolean {
    return this.mouseHeld.has(button);
  }

  getMouseButtonDown(button: number): boolean {
    return this.mousePressed.has(button);
  }

  getMouseButtonUp(button: number): boolean {
    return this.mouseReleased.has(button);
  }

  getAxisRaw(name: string): number {
    if (name === 'Mouse X') return this.mouseDelta.x;
    if (name === 'Mouse Y') return this.mouseDelta.y;
    if (name === 'Mouse ScrollWheel') return this.mouseScrollDelta.y;
    const axis = this.axes.get(name);
    if (!axis) throw new Error(`Input axis "${name}" is not set up. Use Input.defineAxis("${name}", ...).`);
    const positive = axis.positive.some((code) => this.held.has(code)) ? 1 : 0;
    const negative = axis.negative.some((code) => this.held.has(code)) ? 1 : 0;
    return positive - negative;
  }

  getAxis(name: string): number {
    if (name.startsWith('Mouse ')) return this.getAxisRaw(name);
    this.getAxisRaw(name); // validates the name
    return this.smoothedAxes.get(name) ?? 0;
  }

  private button(name: string): ButtonBinding {
    const binding = this.buttons.get(name);
    if (!binding) {
      throw new Error(`Input button "${name}" is not set up. Use Input.defineButton("${name}", ...).`);
    }
    return binding;
  }

  getButton(name: string): boolean {
    const binding = this.button(name);
    return (
      binding.keys.some((code) => this.held.has(code)) ||
      binding.mouseButtons.some((button) => this.mouseHeld.has(button))
    );
  }

  getButtonDown(name: string): boolean {
    const binding = this.button(name);
    return (
      binding.keys.some((code) => this.pressed.has(code)) ||
      binding.mouseButtons.some((button) => this.mousePressed.has(button))
    );
  }

  getButtonUp(name: string): boolean {
    const binding = this.button(name);
    return (
      binding.keys.some((code) => this.released.has(code)) ||
      binding.mouseButtons.some((button) => this.mouseReleased.has(button))
    );
  }

  // ---- DOM wiring --------------------------------------------------------------------

  /**
   * Listens for real input. Mouse presses and wheel only count when they hit the canvas,
   * so clicks on HTML UI drawn over the game never reach game code.
   */
  attach(canvas: HTMLCanvasElement, target: Window = window): void {
    this.detachListeners();
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const position = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.moveMouse(event.clientX - rect.left, event.clientY - rect.top);
    };
    const isTyping = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      return (
        !!element &&
        (element.isContentEditable ||
          element.tagName === 'INPUT' ||
          element.tagName === 'TEXTAREA' ||
          element.tagName === 'SELECT')
      );
    };

    target.addEventListener(
      'keydown',
      (event) => {
        if (!isTyping(event)) this.pressKey(event.code as KeyCode);
      },
      options,
    );
    target.addEventListener('keyup', (event) => this.releaseKey(event.code as KeyCode), options);
    target.addEventListener('blur', () => this.releaseAll(), options);

    canvas.addEventListener(
      'pointerdown',
      (event) => {
        position(event);
        this.pressMouseButton(unityMouseButton(event.button));
        // Keep receiving this pointer's events even if it leaves the canvas mid-drag.
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic events have no active pointer to capture.
        }
      },
      options,
    );
    target.addEventListener(
      'pointermove',
      (event) => {
        // Hovering HTML UI drawn over the game should not move the in-game pointer.
        if (event.target === canvas || this.mouseHeld.size > 0) position(event);
      },
      options,
    );
    target.addEventListener('pointerup', (event) => this.releaseMouseButton(unityMouseButton(event.button)), options);
    target.addEventListener('pointercancel', () => this.releaseAll(), options);
    canvas.addEventListener(
      'wheel',
      (event) => {
        position(event);
        // One wheel notch is +/-1, positive when scrolling up/away, as in Unity.
        this.scroll(-Math.sign(event.deltaX), -Math.sign(event.deltaY));
        event.preventDefault();
      },
      { signal: controller.signal, passive: false },
    );
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);

    this.detach = () => controller.abort();
  }

  detachListeners(): void {
    this.detach?.();
    this.detach = null;
  }
}

/** DOM buttons are 0 left, 1 middle, 2 right; Unity's are 0 left, 1 right, 2 middle. */
function unityMouseButton(domButton: number): number {
  return domButton === 1 ? 2 : domButton === 2 ? 1 : domButton;
}

/**
 * Unity's `Input` (the classic Input Manager API).
 *
 * Screen positions are CSS pixels with the origin at the TOP-left of the canvas and Y
 * pointing down, matching the DOM and the Preact HUD. (Unity's origin is bottom-left.)
 */
export class Input {
  /** True while `key` is held. */
  static getKey(key: KeyCode): boolean {
    return currentEngine().input.getKey(key);
  }

  /** True only during the frame `key` went down. */
  static getKeyDown(key: KeyCode): boolean {
    return currentEngine().input.getKeyDown(key);
  }

  /** True only during the frame `key` was released. */
  static getKeyUp(key: KeyCode): boolean {
    return currentEngine().input.getKeyUp(key);
  }

  static get anyKey(): boolean {
    return currentEngine().input.anyKey;
  }

  static get anyKeyDown(): boolean {
    return currentEngine().input.anyKeyDown;
  }

  /** True while a mouse button is held. 0 = left, 1 = right, 2 = middle, as in Unity. */
  static getMouseButton(button: number): boolean {
    return currentEngine().input.getMouseButton(button);
  }

  static getMouseButtonDown(button: number): boolean {
    return currentEngine().input.getMouseButtonDown(button);
  }

  static getMouseButtonUp(button: number): boolean {
    return currentEngine().input.getMouseButtonUp(button);
  }

  /** Pointer position on the canvas in CSS pixels, origin top-left. `z` is always 0. */
  /**
   * True once the pointer has been over the game. Until then `mousePosition` is (0, 0),
   * the top-left corner: check this before treating the position as "at the edge".
   */
  static get mousePresent(): boolean {
    return currentEngine().input.mousePresent;
  }

  static get mousePosition(): Vector3 {
    return currentEngine().input.mousePosition;
  }

  /** Pointer movement since the previous frame, in CSS pixels. */
  static get mousePositionDelta(): Vector2 {
    return currentEngine().input.mouseDelta;
  }

  /** Wheel movement this frame. `y` is +1 per notch scrolling up/away. */
  static get mouseScrollDelta(): Vector2 {
    return currentEngine().input.mouseScrollDelta;
  }

  /**
   * A smoothed value in [-1, 1]. Built in: "Horizontal" (A/D, arrows), "Vertical" (W/S,
   * arrows), "Mouse X", "Mouse Y", "Mouse ScrollWheel".
   */
  static getAxis(name: string): number {
    return currentEngine().input.getAxis(name);
  }

  /** Like `getAxis` but with no smoothing: exactly -1, 0 or 1 for keys. */
  static getAxisRaw(name: string): number {
    return currentEngine().input.getAxisRaw(name);
  }

  /** True while a named button is held. Built in: Fire1-3, Jump, Submit, Cancel. */
  static getButton(name: string): boolean {
    return currentEngine().input.getButton(name);
  }

  static getButtonDown(name: string): boolean {
    return currentEngine().input.getButtonDown(name);
  }

  static getButtonUp(name: string): boolean {
    return currentEngine().input.getButtonUp(name);
  }

  /** Adds or replaces a key axis. This stands in for Unity's Input Manager settings. */
  static defineAxis(name: string, positive: KeyCode[], negative: KeyCode[]): void {
    currentEngine().input.axes.set(name, { positive, negative });
  }

  /** Adds or replaces a named button. */
  static defineButton(name: string, keys: KeyCode[], mouseButtons: number[] = []): void {
    currentEngine().input.buttons.set(name, { keys, mouseButtons });
  }
}

/** Unity's `Screen`: the size of the game view, in CSS pixels. */
export class Screen {
  static get width(): number {
    return currentEngine().canvasSize.width;
  }

  static get height(): number {
    return currentEngine().canvasSize.height;
  }

  /** Device pixels per CSS pixel. */
  static get pixelRatio(): number {
    return currentEngine().isHeadless ? 1 : (globalThis.devicePixelRatio ?? 1);
  }
}
