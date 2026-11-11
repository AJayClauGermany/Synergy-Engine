/** How many single-character edits turn `a` into `b`. Used to suggest the id that was probably meant. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * A set of definitions looked up by id: unit types, buildings, weapons, tiles.
 *
 * This is where Unity's ScriptableObject assets go. Each asset becomes one plain record
 * and the asset's name becomes its `id`, so maps, saves and network messages can refer
 * to it by a string that survives a rename of the class or a change of platform.
 *
 *   interface UnitType { id: string; hp: number; moves: number }
 *   export const unitTypes = new Catalog<UnitType>('unit type', [
 *     { id: 'footman', hp: 10, moves: 3 },
 *     { id: 'scout', hp: 6, moves: 5 },
 *   ]);
 *
 *   unitTypes.get('scout').moves        // 5
 *   unitTypes.get('scuot')              // throws: There is no unit type "scuot". Did you mean "scout"?
 *
 * The records can equally come from a JSON file. A duplicate or empty id is an error
 * when the catalog is made, so a bad data file fails at startup and in tests rather
 * than at the moment the missing thing is first needed.
 */
export class Catalog<T extends { readonly id: string }> implements Iterable<T> {
  private readonly byId = new Map<string, T>();

  /** `kind` names what is inside, for error messages: 'unit type', 'tile'. */
  constructor(
    readonly kind: string,
    entries: Iterable<T> = [],
  ) {
    for (const entry of entries) this.add(entry);
  }

  /** Adds one more definition. Its id must be new. */
  add(entry: T): this {
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new Error(`Every ${this.kind} needs an "id" (a non-empty string); got ${JSON.stringify(entry)}.`);
    }
    if (this.byId.has(entry.id)) throw new Error(`Two ${this.kind}s share the id "${entry.id}". Ids must be unique.`);
    this.byId.set(entry.id, entry);
    return this;
  }

  /** The definition with this id. Throws, naming the ids that do exist, when there is none. */
  get(id: string): T {
    const found = this.byId.get(id);
    if (found) return found;
    const ids = this.ids;
    const closest = ids
      .map((known) => ({ known, distance: editDistance(known.toLowerCase(), String(id).toLowerCase()) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const hint =
      closest && closest.distance <= Math.max(2, Math.floor(closest.known.length / 3))
        ? ` Did you mean "${closest.known}"?`
        : '';
    const known = ids.length === 0 ? '(none)' : ids.slice(0, 30).join(', ') + (ids.length > 30 ? `, and ${ids.length - 30} more` : '');
    throw new Error(`There is no ${this.kind} "${id}".${hint} Known ${this.kind}s: ${known}.`);
  }

  /** The definition with this id, or `null`. */
  find(id: string): T | null {
    return this.byId.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Every id, in the order the definitions were added. */
  get ids(): string[] {
    return [...this.byId.keys()];
  }

  /** Every definition, in the order they were added. */
  get all(): T[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.byId.values();
  }
}
