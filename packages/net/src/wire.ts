/**
 * Everything that crosses the network crosses as JSON, and JSON keeps less than
 * JavaScript has: a `Vector3` arrives as a bare `{ x, y, z }` without its methods, a `Map`
 * or `Set` arrives empty, `undefined` in a list, `NaN` and `Infinity` arrive as `null`.
 * None of that throws. Worse, the machine that sent the value still has the original, so
 * the host and a single-player game see nothing wrong and only a guest breaks.
 *
 * `wireProblem` finds the first such thing in a value, so the sender can be stopped with
 * a sentence on its own machine, in a test.
 */

/** What JSON would lose or change in `value`, as a sentence, or `null` if it survives as it is. */
export function wireProblem(value: unknown, path = 'the value'): string | null {
  return find(value, path, new Set());
}

function find(value: unknown, path: string, above: Set<object>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? null
      : `${path} is ${value}, which JSON turns into null. Use null, or a number that means the same.`;
  }
  if (value === undefined)
    return `${path} is undefined, which JSON turns into null in a list. Send null, or leave it out.`;
  if (typeof value !== 'object')
    return `${path} is a ${typeof value}, which cannot be sent. Send plain data: numbers, strings, booleans, arrays and plain objects.`;
  if (above.has(value)) return `${path} contains itself, which cannot be sent.`;
  above.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const problem = find(value[index], `${path}[${index}]`, above);
        if (problem) return problem;
      }
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      const type = (prototype as { constructor?: { name?: string } }).constructor?.name || 'class instance';
      const lost = type === 'Map' || type === 'Set' ? 'arrives empty' : 'arrives as a plain object without its methods';
      return `${path} is a ${type}, which ${lost} on the other machines. Send plain data instead (for a vector, its numbers).`;
    }
    for (const [key, item] of Object.entries(value)) {
      // A key set to undefined is simply left out, on every machine alike.
      if (item === undefined) continue;
      const problem = find(item, `${path}.${key}`, above);
      if (problem) return problem;
    }
    return null;
  } finally {
    above.delete(value);
  }
}

/** A copy that has been through JSON: what the other machines will receive. */
export function wireCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
