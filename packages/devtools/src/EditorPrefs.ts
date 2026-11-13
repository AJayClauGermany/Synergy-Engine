/**
 * Unity's `EditorPrefs`: small settings the editor keeps between page loads (which panels
 * are open, the Console's filters). Stored in the browser's localStorage under
 * `synergy.editor.`; when that is unavailable (a private window), values last until the
 * page closes.
 */
const memory = new Map<string, string>();
const PREFIX = 'synergy.editor.';

function read(key: string): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(PREFIX + key);
    if (stored !== null && stored !== undefined) return stored;
  } catch {
    // Storage can be switched off; fall through to the in-memory copy.
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    globalThis.localStorage?.setItem(PREFIX + key, value);
  } catch {
    // As above: the in-memory copy is enough for this page.
  }
}

export class EditorPrefs {
  static hasKey(key: string): boolean {
    return read(key) !== null;
  }

  static deleteKey(key: string): void {
    memory.delete(key);
    try {
      globalThis.localStorage?.removeItem(PREFIX + key);
    } catch {
      // Nothing stored, nothing to remove.
    }
  }

  static getBool(key: string, defaultValue = false): boolean {
    const value = read(key);
    return value === null ? defaultValue : value === 'true';
  }

  static setBool(key: string, value: boolean): void {
    write(key, String(value));
  }

  static getFloat(key: string, defaultValue = 0): number {
    const value = Number(read(key) ?? Number.NaN);
    return Number.isFinite(value) ? value : defaultValue;
  }

  static setFloat(key: string, value: number): void {
    write(key, String(value));
  }

  static getInt(key: string, defaultValue = 0): number {
    return Math.trunc(EditorPrefs.getFloat(key, defaultValue));
  }

  static setInt(key: string, value: number): void {
    write(key, String(Math.trunc(value)));
  }

  static getString(key: string, defaultValue = ''): string {
    return read(key) ?? defaultValue;
  }

  static setString(key: string, value: string): void {
    write(key, value);
  }
}
