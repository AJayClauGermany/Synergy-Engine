import { Signal } from '@synergy/net';
import type { NetworkBehaviour } from './NetworkBehaviour';
import { SERVER_CLIENT_ID } from './protocol';
import { jsonSerializer, type Serializer } from './Serializers';

/** Who may read a variable. Unity: `NetworkVariableReadPermission`. */
export enum NetworkVariableReadPermission {
  /** Every client that can see the object. */
  Everyone = 'everyone',
  /** Only the owner (and the server). */
  Owner = 'owner',
}

/** Who may change a variable. Unity: `NetworkVariableWritePermission`. */
export enum NetworkVariableWritePermission {
  /** Only the server (the host). */
  Server = 'server',
  /** Only the owner. The server relays the change to everyone else. */
  Owner = 'owner',
}

export interface NetworkVariableOptions<T> {
  read?: NetworkVariableReadPermission;
  write?: NetworkVariableWritePermission;
  /** How to turn the value into JSON and back. Needed for `Vector3` and other class instances; see `Serializers`. */
  serializer?: Serializer<T>;
}

/**
 * What every replicated field has in common. Declare variables as fields of a
 * `NetworkBehaviour`; the engine finds them by looking at the instance, as Unity does.
 */
export abstract class NetworkVariableBase {
  /** Who can read it. Fixed once the object spawns. */
  readPermission: NetworkVariableReadPermission;
  /** Who can write it. Fixed once the object spawns. */
  writePermission: NetworkVariableWritePermission;

  /** @internal */ _behaviour: NetworkBehaviour | null = null;
  /** @internal */ _name = '';
  /** @internal */ _dirty = false;
  /** @internal The client whose change this is, so the server does not echo it back. -1 for a local change. */
  _origin = -1;

  constructor(options: Pick<NetworkVariableOptions<unknown>, 'read' | 'write'> = {}) {
    this.readPermission = options.read ?? NetworkVariableReadPermission.Everyone;
    this.writePermission = options.write ?? NetworkVariableWritePermission.Server;
  }

  /** The field name this variable was declared under. Known once the object spawns. */
  get name(): string {
    return this._name;
  }

  /** True while there is a change that has not been sent yet. */
  get isDirty(): boolean {
    return this._dirty;
  }

  /**
   * Marks the variable as changed, so it is sent at the next tick. Needed only after
   * mutating an object or array in place; assigning a new value does it for you.
   */
  setDirty(dirty = true): void {
    this.markDirty(dirty, -1);
  }

  /** Whether `clientId` receives this variable. The server always can. */
  canClientRead(clientId: number): boolean {
    if (this.readPermission === NetworkVariableReadPermission.Everyone) return true;
    const owner = this._behaviour?._networkObject?.ownerClientId ?? SERVER_CLIENT_ID;
    return clientId === owner || clientId === SERVER_CLIENT_ID;
  }

  /** Whether `clientId` may change this variable. */
  canClientWrite(clientId: number): boolean {
    if (this.writePermission === NetworkVariableWritePermission.Server) return clientId === SERVER_CLIENT_ID;
    return clientId === (this._behaviour?._networkObject?.ownerClientId ?? SERVER_CLIENT_ID);
  }

  /** @internal */
  _bind(behaviour: NetworkBehaviour, name: string): void {
    this._behaviour = behaviour;
    this._name = name;
  }

  /** @internal */
  _unbind(): void {
    this._behaviour = null;
  }

  /** @internal */
  markDirty(dirty: boolean, origin: number): void {
    this._dirty = dirty;
    this._origin = dirty ? origin : -1;
    if (dirty) this._behaviour?._networkObject?._manager?._variableDirtied(this);
  }

  /** @internal Called after this variable's pending change has been sent. */
  _resetDirty(): void {
    this._dirty = false;
    this._origin = -1;
  }

  /** Throws when the local machine may not change a spawned variable. Unspawned objects are free to set initial values. */
  protected assertWritable(): void {
    const object = this._behaviour?._networkObject;
    const manager = object?._manager;
    if (!object || !manager || !object.isSpawned) return;
    if (!this.canClientWrite(manager.localClientId)) {
      throw new Error(
        `Client ${manager.localClientId} cannot write to NetworkVariable "${this._name}" on "${object.name}" ` +
          `(write permission: ${this.writePermission}, owner: ${object.ownerClientId}).`,
      );
    }
  }

  /** @internal The pending change as JSON. */
  abstract _writeDelta(): unknown;
  /** @internal The whole state as JSON. */
  abstract _writeFull(): unknown;
  /** @internal Applies a change from the network. `relayFrom` is the sender when the server must pass it on. */
  abstract _readDelta(data: unknown, relayFrom: number | null): void;
  /** @internal Applies a whole state. `notify` raises change events. */
  abstract _readFull(data: unknown, notify: boolean): void;
}

function sameValue(a: unknown, b: unknown, serializer: Serializer<never>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(serializer.write(a as never)) === JSON.stringify(serializer.write(b as never));
}

/** A value as text, for `toString()`. */
function printable(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) return JSON.stringify(value);
  return String(value);
}

/**
 * One value kept in step across the network. Unity: `NetworkVariable<T>`.
 *
 *   readonly health = new NetworkVariable(100);
 *
 *   onNetworkSpawn() {
 *     this.health.onValueChanged.add((previous, current) => this.showHealth(current));
 *   }
 *   // on the server: this.health.value -= 10;
 *
 * By default only the server writes and everyone reads. Assign a new value to change it;
 * to change an object or array, replace it (`this.stats.value = { ...this.stats.value, kills: 3 }`).
 * Setting a value equal to the current one sends nothing.
 *
 * `onValueChanged` fires for changes, not for the value a late joiner receives when the
 * object spawns; read `value` in `onNetworkSpawn` for that.
 */
export class NetworkVariable<T> extends NetworkVariableBase {
  /** Called with the previous and the new value whenever it changes on this machine. */
  readonly onValueChanged = new Signal<[previous: T, current: T]>();

  private current: T;
  private readonly serializer: Serializer<T>;

  constructor(initial: T, options: NetworkVariableOptions<T> = {}) {
    super(options);
    this.current = initial;
    this.serializer = options.serializer ?? (jsonSerializer as Serializer<T>);
  }

  get value(): T {
    return this.current;
  }

  /** For logs and `Debug.hierarchy()`: `NetworkVariable(100)`. */
  toString(): string {
    return `NetworkVariable(${printable(this.current)})`;
  }

  set value(next: T) {
    this.assertWritable();
    if (sameValue(this.current, next, this.serializer as Serializer<never>)) return;
    const previous = this.current;
    this.current = next;
    this.markDirty(true, -1);
    this.onValueChanged.emit(previous, next);
  }

  /** @internal */
  _writeDelta(): unknown {
    return this.serializer.write(this.current);
  }

  /** @internal */
  _writeFull(): unknown {
    return this.serializer.write(this.current);
  }

  /** @internal */
  _readDelta(data: unknown, relayFrom: number | null): void {
    this.apply(data, true);
    if (relayFrom !== null) this.markDirty(true, relayFrom);
  }

  /** @internal */
  _readFull(data: unknown, notify: boolean): void {
    this.apply(data, notify);
  }

  private apply(data: unknown, notify: boolean): void {
    const next = this.serializer.read(data);
    if (sameValue(this.current, next, this.serializer as Serializer<never>)) return;
    const previous = this.current;
    this.current = next;
    if (notify) this.onValueChanged.emit(previous, next);
  }
}

// ---- NetworkList --------------------------------------------------------------------

/** What happened to a `NetworkList`. Unity: `NetworkListEvent<T>`. */
export interface NetworkListEvent<T> {
  type: 'add' | 'insert' | 'remove' | 'value' | 'clear' | 'full';
  /** Where it happened. -1 for `clear` and `full`. */
  index: number;
  /** The item added, or the new value of the item that changed. */
  value?: T;
  /** The item removed, or the old value of the item that changed. */
  previousValue?: T;
}

interface ListOp {
  /** The list's version after this operation. Receivers skip operations they already have. */
  n: number;
  k: 'add' | 'insert' | 'removeAt' | 'set' | 'clear';
  i?: number;
  v?: unknown;
}

/**
 * A list kept in step across the network. Unity: `NetworkList<T>`. Only the changes are
 * sent (add, insert, remove, set, clear), not the whole list.
 *
 *   readonly inventory = new NetworkList<string>();
 *   this.inventory.add('sword');
 *   this.inventory.onListChanged.add((event) => redraw());
 */
export class NetworkList<T> extends NetworkVariableBase implements Iterable<T> {
  readonly onListChanged = new Signal<[event: NetworkListEvent<T>]>();

  private items: T[];
  private version = 0;
  private pending: ListOp[] = [];
  private readonly serializer: Serializer<T>;

  constructor(initial: readonly T[] = [], options: NetworkVariableOptions<T> = {}) {
    super(options);
    this.items = [...initial];
    this.serializer = options.serializer ?? (jsonSerializer as Serializer<T>);
  }

  /** Number of items. Unity: `Count`. */
  get count(): number {
    return this.items.length;
  }

  /** For logs and `Debug.hierarchy()`: `NetworkList(3 items)`. */
  toString(): string {
    return `NetworkList(${this.items.length} ${this.items.length === 1 ? 'item' : 'items'})`;
  }

  get(index: number): T {
    if (index < 0 || index >= this.items.length) throw new RangeError(`NetworkList index ${index} is out of range.`);
    return this.items[index] as T;
  }

  set(index: number, value: T): void {
    this.assertWritable();
    const previous = this.get(index);
    this.items[index] = value;
    this.record({ k: 'set', i: index, v: this.serializer.write(value) });
    this.onListChanged.emit({ type: 'value', index, value, previousValue: previous });
  }

  add(value: T): void {
    this.assertWritable();
    this.items.push(value);
    this.record({ k: 'add', v: this.serializer.write(value) });
    this.onListChanged.emit({ type: 'add', index: this.items.length - 1, value });
  }

  insert(index: number, value: T): void {
    this.assertWritable();
    if (index < 0 || index > this.items.length) throw new RangeError(`NetworkList index ${index} is out of range.`);
    this.items.splice(index, 0, value);
    this.record({ k: 'insert', i: index, v: this.serializer.write(value) });
    this.onListChanged.emit({ type: 'insert', index, value });
  }

  removeAt(index: number): void {
    this.assertWritable();
    const previous = this.get(index);
    this.items.splice(index, 1);
    this.record({ k: 'removeAt', i: index });
    this.onListChanged.emit({ type: 'remove', index, previousValue: previous });
  }

  /** Removes the first item equal to `value`. Returns false when there is none. */
  remove(value: T): boolean {
    const index = this.indexOf(value);
    if (index < 0) return false;
    this.removeAt(index);
    return true;
  }

  clear(): void {
    this.assertWritable();
    this.items = [];
    this.record({ k: 'clear' });
    this.onListChanged.emit({ type: 'clear', index: -1 });
  }

  indexOf(value: T): number {
    return this.items.findIndex((item) => sameValue(item, value, this.serializer as Serializer<never>));
  }

  contains(value: T): boolean {
    return this.indexOf(value) >= 0;
  }

  /** A copy of the items, safe to keep. */
  toArray(): T[] {
    return [...this.items];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  private record(op: Omit<ListOp, 'n'>): void {
    this.pending.push({ n: ++this.version, ...op });
    this.markDirty(true, -1);
  }

  /** @internal */
  override _resetDirty(): void {
    super._resetDirty();
    this.pending = [];
  }

  /** @internal */
  _writeDelta(): unknown {
    return this.pending;
  }

  /** @internal */
  _writeFull(): unknown {
    return { n: this.version, items: this.items.map((item) => this.serializer.write(item)) };
  }

  /** @internal */
  _readFull(data: unknown, notify: boolean): void {
    const full = data as { n: number; items: unknown[] };
    this.items = full.items.map((item) => this.serializer.read(item));
    this.version = full.n;
    if (notify) this.onListChanged.emit({ type: 'full', index: -1 });
  }

  /** @internal */
  _readDelta(data: unknown, relayFrom: number | null): void {
    if (relayFrom !== null) this.validateOps(data);
    for (const op of data as ListOp[]) {
      // The initial state and later changes can overlap; an operation we already have is skipped.
      if (op.n <= this.version) continue;
      this.version = op.n;
      this.applyRemote(op);
      if (relayFrom !== null) this.pending.push(op);
    }
    if (relayFrom !== null && this.pending.length > 0) this.markDirty(true, relayFrom);
  }

  /** The server checks what a client sends before applying and passing it on. */
  private validateOps(data: unknown): void {
    if (!Array.isArray(data)) throw new Error(`Malformed NetworkList update for "${this._name}".`);
    let version = this.version;
    let length = this.items.length;
    for (const op of data as ListOp[]) {
      const index = op.i ?? -1;
      const ok =
        Number.isInteger(op.n) &&
        op.n === version + 1 &&
        (op.k === 'clear' ||
          (op.k === 'add' && (length++, true)) ||
          (op.k === 'insert' && Number.isInteger(index) && index >= 0 && index <= length++) ||
          (op.k === 'removeAt' && Number.isInteger(index) && index >= 0 && index < length--) ||
          (op.k === 'set' && Number.isInteger(index) && index >= 0 && index < length));
      if (!ok) throw new Error(`Rejected an invalid NetworkList operation on "${this._name}".`);
      if (op.k === 'clear') length = 0;
      version = op.n;
    }
  }

  private applyRemote(op: ListOp): void {
    const index = op.i ?? this.items.length;
    switch (op.k) {
      case 'add': {
        const value = this.serializer.read(op.v);
        this.items.push(value);
        this.onListChanged.emit({ type: 'add', index: this.items.length - 1, value });
        break;
      }
      case 'insert': {
        const value = this.serializer.read(op.v);
        this.items.splice(index, 0, value);
        this.onListChanged.emit({ type: 'insert', index, value });
        break;
      }
      case 'removeAt': {
        const previous = this.items[index];
        this.items.splice(index, 1);
        this.onListChanged.emit({ type: 'remove', index, previousValue: previous });
        break;
      }
      case 'set': {
        const previous = this.items[index];
        const value = this.serializer.read(op.v);
        this.items[index] = value;
        this.onListChanged.emit({ type: 'value', index, value, previousValue: previous });
        break;
      }
      case 'clear':
        this.items = [];
        this.onListChanged.emit({ type: 'clear', index: -1 });
        break;
    }
  }
}
