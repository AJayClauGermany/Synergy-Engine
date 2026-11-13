import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/engine/src/core/Engine';
import { GameObject } from '../../packages/engine/src/core/GameObject';
import { NOT_SENT as ENGINE_NOT_SENT } from '../../packages/engine/src/core/messageNames';
import { MonoBehaviour } from '../../packages/engine/src/core/MonoBehaviour';
import { NetworkBehaviour } from '../../packages/netcode/src/NetworkBehaviour';
import { ENGINE_MEMBERS, MESSAGES, NOT_SENT, rules } from './synergy';

// Each rule runs on small snippets: code it must accept, and code it must report. The
// snippets go through the real linter (one run for all of them), so this also proves
// that oxlint loads the plugin under Bun.

type RuleName = keyof typeof rules;

interface Snippet {
  code: string;
  /** Only matters to rules that read the file name. */
  filename?: string;
  /** One entry per expected report, in source order: text the message must contain. */
  errors?: (string | RegExp)[];
}

const CASES: Record<RuleName, { valid: (string | Snippet)[]; invalid: Snippet[] }> = {
  'no-detached-method': {
    valid: [
      // Calling the method is not handing it over.
      'class A { hit() { this.hp--; } run() { this.hit(); } }',
      // An arrow keeps `this`, whether written at the call or as the field itself.
      'class A { hit() { this.hp--; } run() { button.onClick.addListener(() => this.hit()); } }',
      'class A { hit = () => { this.hp--; }; run() { button.onClick.addListener(this.hit); } }',
      // The engine's invoke family binds the method itself.
      'class A { tick() { this.n++; } start() { this.invoke(this.tick, 1); this.invokeRepeating(this.tick, 0, 1); } }',
      'class A { tick() { this.n++; } stop() { this.cancelInvoke(this.tick); return this.isInvoking(this.tick); } }',
      // So does a call that is also given `this` (PlayCanvas: on(name, callback, scope)).
      "class A { onUpdate() { this.n++; } awake() { this.app.on('update', this.onUpdate, this); } }",
      // Bound by hand.
      'class A { hit() { this.hp--; } run() { events.add(this.hit.bind(this)); } }',
      // A method that never uses `this` loses nothing.
      'class A { double(n: number) { return n * 2; } run(list: number[]) { return list.map(this.double); } }',
      // Looking at a method without taking it.
      "class A { hit() { this.hp--; } run() { return typeof this.hit === 'function' && entry.method === this.hit; } }",
      // Not a method of this class: nothing can be said from here.
      'class A { run() { events.add(this.hit); } }',
      // Getters and fields are values already.
      'class A { get hp() { return this._hp; } run() { show(this.hp); } }',
      // A coroutine is started by calling the method that makes it.
      'class A { *blink() { yield null; } start() { this.startCoroutine(this.blink()); } }',
    ],
    invalid: [
      {
        code: 'class A { hit() { this.hp--; } start() { button.onClick.addListener(this.hit); } }',
        errors: ['`this.hit` is handed over without its `this`'],
      },
      {
        code: 'class A { score(u: Unit) { return u.hp * this.weight; } best(units: Unit[]) { return units.map(this.score); } }',
        errors: ['Pass `() => this.score()`'],
      },
      { code: 'class A { hit() { this.hp--; } run() { const f = this.hit; f(); } }', errors: ['this.hit'] },
      { code: 'class A { hit() { this.hp--; } run() { this.handler = this.hit; } }', errors: ['this.hit'] },
      { code: 'class A { hit() { this.hp--; } run() { return { onHit: this.hit }; } }', errors: ['this.hit'] },
      { code: 'class A { hit() { this.hp--; } handler() { return this.hit; } }', errors: ['this.hit'] },
      { code: 'class A { hit() { super.hit(); } start() { events.add(this.hit!); } }', errors: ['this.hit'] },
      // Unity's StartCoroutine(Blink()) with the call left off: the advice is to call it, not to wrap it.
      {
        code: 'class A { *blink() { yield null; } start() { this.startCoroutine(this.blink); } }',
        errors: ['Call it: `this.startCoroutine(this.blink())`'],
      },
      {
        code: 'class A { hit() { this.hp--; } render() { return <button onClick={this.hit} />; } }',
        filename: 'View.tsx',
        errors: ['this.hit'],
      },
    ],
  },

  'no-identity-compare': {
    valid: [
      'if (velocity.equals(Vector3.zero)) stop();',
      'if (!a.equals(b)) move();',
      'if (speed === 0) stop();',
      // Not one of the engine's value types.
      'if (key === KeyCode.Space) jump();',
      'if (Mathf.PI > 3) ok();',
      // Ordering comparisons are not about identity.
      'if (a.x < Vector3.one.x) ok();',
    ],
    invalid: [
      {
        code: 'if (velocity == Vector3.zero) stop();',
        errors: ['`==` compares two Vector3 objects by identity, not by their numbers, so this is false'],
      },
      {
        code: 'if (this.transform.position !== Vector3.zero) move();',
        errors: ['`!==` compares two Vector3 objects by identity, not by their numbers, so this is true'],
      },
      { code: 'const same = cell === new Vector3Int(1, 2, 0);', errors: ['two Vector3Int objects'] },
      { code: 'const white = Color.white === tint;', errors: ['two Color objects'] },
      { code: 'const still = rotation === (Quaternion.identity);', errors: ['Use `a.equals(b)`'] },
    ],
  },

  'no-value-keys': {
    valid: [
      'const units = new Map<string, Unit>();',
      'const seen = new Set<string>();',
      'const byId: Map<number, Unit> = new Map();',
      // Keyed by identity on purpose: these are objects with an identity, not values.
      'const health = new Map<GameObject, number>();',
      'const cache = new WeakMap<Vector3, number>();',
      // Values may be anything.
      'const positions = new Map<string, Vector3>();',
      'const cells: Vector3Int[] = [];',
    ],
    invalid: [
      {
        code: 'const units = new Map<Vector3Int, Unit>();',
        errors: ['A Map keyed by Vector3Int finds keys by identity'],
      },
      { code: 'const visited = new Set<Vector2Int>();', errors: ['Key it by a string instead: Set<string>'] },
      { code: 'let units: Map<CellLike, Unit>;', errors: ['Key it by a string instead: Map<string, …>'] },
      { code: 'function f(seen: ReadonlySet<Vector3>): void {}', errors: ['A ReadonlySet keyed by Vector3'] },
      {
        code: 'const costs = new Map<{ x: number; y: number }, number>();',
        errors: ['A Map keyed by an object'],
      },
      { code: 'const seen = new Set<[number, number]>();', errors: ['A Set keyed by a tuple'] },
      // The annotation and the constructor are each reported where they are written.
      {
        code: 'const units: Map<Vector3Int, Unit> = new Map<Vector3Int, Unit>();',
        errors: ['Vector3Int', 'Vector3Int'],
      },
    ],
  },

  'no-unsent-message': {
    valid: [
      'class Unit extends MonoBehaviour { awake() {} start() {} update() {} onDestroy() {} onMouseDown() {} }',
      'class Unit extends NetworkBehaviour { onNetworkSpawn() {} onGainedOwnership() {} }',
      // An ordinary method that happens to start with "on".
      'class Unit extends MonoBehaviour { onHit() {} onSelected() {} }',
      // Not a script, so nothing sends it messages either way.
      'class Machine { onStart() {} onTriggerEnter() {} }',
      'class Machine extends Base { onStart() {} }',
      // Nor is a state of a state machine, whose own code calls its onStart().
      "import { UnitState } from './UnitState'; class Patrol extends UnitState { onStart() {} update() { this.unit.transform.translate(step); } }",
      // Unity's capitals are a type error already; one report is enough.
      'class Unit extends MonoBehaviour { Update() {} }',
      'class Unit extends MonoBehaviour { static onStart() {} }',
    ],
    invalid: [
      {
        code: 'class Unit extends MonoBehaviour { onStart() {} }',
        errors: ['Unit.onStart() looks like a Unity message, but the engine never calls it. The message is start()'],
      },
      {
        code: 'class Unit extends MonoBehaviour { onUpdate() {} OnAwake() {} }',
        errors: ['The message is update()', 'The message is awake()'],
      },
      {
        code: 'class Coin extends MonoBehaviour { onTriggerEnter(other: Collider) {} }',
        errors: [/Coin\.onTriggerEnter\(\) is a Unity message this engine does not send.*Physics\.overlapSphere/],
      },
      {
        code: 'class Crate extends NetworkBehaviour { OnCollisionEnter() {} }',
        errors: ['there is no rigidbody physics yet'],
      },
      // A script that extends another script in the same file is a script too.
      {
        code: 'class Unit extends MonoBehaviour {} class Archer extends Unit { onStart() {} }',
        errors: ['Archer.onStart()'],
      },
      // So is one whose base is imported, when it declares a message the engine sends.
      {
        code: "import { UnitView } from './UnitView'; export class Archer extends UnitView { update() { this.transform.rotate(Vector3.up, 1); } onTriggerEnter() {} }",
        errors: ['Archer.onTriggerEnter()'],
      },
      // A message written as a field is no more a message.
      {
        code: 'class Unit extends MonoBehaviour { onStart = () => { this.ready = true; }; }',
        errors: ['Unit.onStart()'],
      },
      {
        code: 'class Coin extends MonoBehaviour { onPointerClick() {} onValidate() {} }',
        errors: ['uGUI pointer events', 'there is no editor'],
      },
      { code: 'class Crate extends NetworkBehaviour { onOwnershipChanged() {} }', errors: ['onGainedOwnership()'] },
    ],
  },

  'no-skipped-test': {
    valid: [
      // A name with no body is a test still to be written.
      "test.todo('the opponent retreats when outnumbered');",
      "test('moves', () => { expect(1).toBe(1); });",
      "describe('board', () => { it('loads', () => { expect(1).toBe(1); }); });",
      // A test still to be written, and one that cannot run everywhere, are honest about it.
      "test.todo('handles a draw');",
      "test.skipIf(!process.env.CI)('uploads', () => { expect(1).toBe(1); });",
      "test.each([1, 2])('doubles %d', (n) => { expect(n * 2).toBe(n + n); });",
      // Other things called skip or only.
      "queue.skip(2); filter.only('a');",
    ],
    invalid: [
      { code: "test.skip('moves', () => { expect(1).toBe(2); });", errors: ['test.skip switches this test off'] },
      { code: "describe.skip('board', () => {});", errors: ['describe.skip switches this test off'] },
      { code: "it.only('moves', () => { expect(1).toBe(1); });", errors: ['it.only stops every other test'] },
      { code: "describe.only('board', () => {});", errors: ["use: bun test -t 'part of its name'"] },
      {
        code: "test.skip.each([1, 2])('doubles %d', (n) => { expect(n).toBe(n); });",
        errors: ['test.skip.each switches this test off'],
      },
      // The same thing under other names.
      {
        code: "test.skipIf(true)('moves', () => { expect(1).toBe(2); });",
        errors: ['test.skipIf with a fixed condition'],
      },
      { code: "test.if(false)('moves', () => { expect(1).toBe(2); });", errors: ['test.if with a fixed condition'] },
      {
        code: "test.failing('moves', () => { expect(1).toBe(2); });",
        errors: ['test.failing passes while the test fails'],
      },
      {
        code: "test.todo('moves', () => { expect(1).toBe(2); });",
        errors: ['test.todo with a body is a skipped test'],
      },
    ],
  },

  'test-needs-expect': {
    valid: [
      "test('counts', () => { expect.assertions(1); run((n) => expect(n).toBe(1)); });",
      "test('same state', () => { expectSameState(host, guest); });",
      "test('adds', () => { expect(1 + 1).toBe(2); });",
      "test('loads', async () => { await expect(load()).resolves.toBe(1); });",
      "it('does not throw', () => { expect(() => run()).not.toThrow(); });",
      // A helper named like an assertion counts.
      "test('board', () => { expectBoard(state); });",
      "test('board', () => { assert.equal(1, 1); });",
      "test('rows', () => { for (const row of rows) { if (row) expect(row.length).toBe(3); } });",
      "test.todo('handles a draw');",
      "describe('board', () => {});",
    ],
    invalid: [
      { code: "test('moves', () => { const unit = move(state); });", errors: ['This test has no expect(...)'] },
      { code: "it('runs', async () => { await engine.step(); });", errors: ['This test has no expect(...)'] },
      { code: "test('moves', () => {});", errors: ['This test has no expect(...)'] },
      // NUnit's Assert.IsTrue(x), ported word for word: nothing is compared.
      { code: "test('adds', () => { expect(1 + 1 === 3); });", errors: ['This test has no expect(...)'] },
    ],
  },

  'no-inline-remove': {
    valid: [
      // The function that was added, kept in a field.
      'class A { onAlarm = () => { this.n++; }; onEnable() { alarm.addListener(this.onAlarm); } onDisable() { alarm.removeListener(this.onAlarm); } }',
      // What adding returned.
      'class A { onEnable() { this.stop = alarm.addListener(() => this.n++); } onDisable() { this.stop(); } }',
      'class A { tick() {} stop() { this.cancelInvoke(this.tick); this.cancelInvoke(); } }',
      'window.removeEventListener("resize", onResize);',
    ],
    invalid: [
      {
        code: 'class A { onDisable() { alarm.removeListener((level) => this.onAlarm(level)); } }',
        errors: ['removeListener() is given a function written right here'],
      },
      { code: 'class A { stop() { this.cancelInvoke(() => this.fire()); } }', errors: ['cancelInvoke()'] },
      { code: 'window.removeEventListener("resize", function () { layout(); });', errors: ['removeEventListener()'] },
      { code: "app.off('update', () => tick());", errors: ['off()'] },
    ],
  },
  'no-discarded-result': {
    valid: [
      'transform.position = transform.position.add(step);',
      'const next = a.sub(b).mul(2);',
      // Real changes that happen to share a name.
      'seen.add(cell); list.add(item);',
      // PlayCanvas's own vectors (through gameObject.entity) do change in place.
      'offset.sub(target); offset.mul(v); side.cross(a, b); matrix.mul(other);',
      'context.scale(2, 2); this.transform.rotate(Vector3.up, 90);',
      'bounds = bounds.encapsulate(point);',
      'return velocity.mul(Time.deltaTime);',
    ],
    invalid: [
      { code: 'this.transform.position.add(step);', errors: ['.add() returns a new value'] },
      { code: 'this.transform.forward.mul(0.5);', errors: ['.mul() returns a new value'] },
      { code: 'bounds.encapsulate(point);', errors: ['.encapsulate()'] },
      { code: 'unit.transform.localScale.scale(Vector3.one.mul(2));', errors: ['.scale()'] },
      { code: 'Vector3.zero.add(offset); new Vector3(1, 2, 3).sub(origin);', errors: ['.add()', '.sub()'] },
      { code: 'color.withAlpha(0.5);', errors: ['.withAlpha()'] },
    ],
  },
  'no-engine-member': {
    valid: [
      'class A extends MonoBehaviour { private _cooldown = 0; private _hasStarted = false; update() {} }',
      // Not a script: the names mean nothing here.
      'class Pool { _started = false; _destroy() {} }',
      // Engine code overriding its own hooks says so.
      'class Light extends Behaviour { override _attach() {} override _destroy() {} }',
      // A state machine and an emitter have update() and start() too, and are not scripts.
      'class UnitState { update() {} } class Patrol extends UnitState { _started = false; _enabled = true; update() {} }',
      "import { Emitter } from './Emitter'; class Connection extends Emitter { _live = false; _send() {} start() {} }",
    ],
    invalid: [
      {
        code: 'class A extends MonoBehaviour { _started = false; start() { this._started = true; } }',
        errors: ['A._started has the name of a member the engine keeps'],
      },
      {
        code: 'class A extends NetworkBehaviour { _live = true; _destroy() { this.cleanUp(); } }',
        errors: ['A._live', 'A._destroy'],
      },
      {
        code: "import { UnitView } from './UnitView'; class Archer extends UnitView { _enabled = true; update() { this.transform.rotate(Vector3.up, 1); } }",
        errors: ['Archer._enabled'],
      },
    ],
  },
  'network-members': {
    valid: [
      'class Unit extends NetworkBehaviour { readonly hp = new NetworkVariable(10); readonly healRpc = this.serverRpc(() => { this.hp.value += 1; }); }',
      'class Unit extends NetworkBehaviour { private readonly hp = new NetworkVariable(10); heal() { this.healRpc(); } }',
      // One variable holding a collection is fine.
      'class Unit extends NetworkBehaviour { readonly stock = new NetworkVariable({ wood: 0, ore: 0 }); readonly squad = new NetworkList<number>(); }',
      // Not networked: a method may be called anything.
      'class Radio { pingRpc() {} }',
      // The body of a handler, moved out of its field.
      'class Unit extends NetworkBehaviour { readonly moveRpc = this.serverRpc((x: number) => this.onMoveRpc(x)); private onMoveRpc(x: number) { this.x.value = x; } }',
    ],
    invalid: [
      {
        code: 'class Unit extends NetworkBehaviour { requestHealServerRpc() { this.hp.value += 1; } showHitClientRpc(amount: number) {} }',
        errors: ['requestHealServerRpc() is a method', 'showHitClientRpc() is a method'],
      },
      {
        code: 'class Unit extends NetworkBehaviour { readonly #stamina = new NetworkVariable(50); readonly #pingRpc = this.clientRpc(() => {}); }',
        errors: ['#stamina is a #private field', '#pingRpc is a #private field'],
      },
      {
        code: 'class Health extends MonoBehaviour { readonly hp = new NetworkVariable(100); }',
        errors: ['hp is a network member on a class that does not extend NetworkBehaviour'],
      },
      {
        code: 'class Unit extends NetworkBehaviour { readonly resources = [new NetworkVariable(0), new NetworkVariable(0)]; readonly orders = { stopRpc: this.serverRpc(() => {}) }; }',
        errors: ['inside an array or object', 'inside an array or object'],
      },
    ],
  },
  'no-module-state': {
    valid: [
      'export const MAX_HP = 5; const COSTS = { plain: 1, forest: 2 };',
      'export function apply(state: State) { let total = 0; for (const unit of state.units) total += unit.hp; return total; }',
    ],
    invalid: [
      {
        code: 'let nextId = 100; export function spawn() { return nextId++; }',
        errors: ['`let nextId` at the top of a rules file'],
      },
      { code: 'var turn = 0;', errors: ['`var turn`'] },
    ],
  },
  'behaviour-file-name': {
    valid: [
      { code: 'export class Health extends MonoBehaviour {}', filename: 'Health.ts' },
      { code: 'export class Soldier extends NetworkBehaviour {}', filename: 'frontier/Soldier.ts' },
      // Helpers and prefabs may sit next to the script.
      {
        code: 'class Blink extends MonoBehaviour {} export class Health extends MonoBehaviour {} export const P = 1;',
        filename: 'Health.ts',
      },
      // Not scripts.
      { code: 'export class Inventory {} export class Slot {}', filename: 'items.ts' },
    ],
    invalid: [
      {
        code: 'export class Health extends MonoBehaviour {}',
        filename: 'health.ts',
        errors: [
          'The script Health is exported from health.ts. A script lives in a file named after it: rename the file to Health.ts',
        ],
      },
      {
        code: 'export class Health extends MonoBehaviour {} export class Armor extends MonoBehaviour {}',
        filename: 'Health.ts',
        errors: ['Armor is the second script exported from this file (Health is the first)'],
      },
    ],
  },
};

interface Report {
  rule: string;
  message: string;
  offset: number;
}

/** Reports per snippet file, as the linter gave them. */
const reports = new Map<string, Report[]>();
let workspace = '';

/** Where a snippet is written: every snippet gets a folder, so file names never collide. */
function snippetPath(rule: RuleName, kind: 'valid' | 'invalid', index: number, snippet: string | Snippet): string {
  const filename = typeof snippet === 'string' ? 'snippet.ts' : (snippet.filename ?? 'snippet.ts');
  return path.join(rule, `${kind}-${index}`, filename);
}

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'synergy-lint-'));
  for (const [rule, { valid, invalid }] of Object.entries(CASES) as [RuleName, (typeof CASES)[RuleName]][]) {
    for (const [kind, snippets] of [
      ['valid', valid],
      ['invalid', invalid],
    ] as const) {
      snippets.forEach((snippet, index) => {
        const file = path.join(workspace, snippetPath(rule, kind, index, snippet));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${typeof snippet === 'string' ? snippet : snippet.code}\n`);
      });
    }
  }
  // Only this plugin's rules, so a report can only come from the rule under test.
  const config = {
    jsPlugins: [path.join(import.meta.dir, 'synergy.ts')],
    plugins: [],
    categories: { correctness: 'off' },
    rules: Object.fromEntries(Object.keys(rules).map((rule) => [`synergy/${rule}`, 'error'])),
  };
  writeFileSync(path.join(workspace, 'oxlintrc.json'), JSON.stringify(config));

  const oxlint = path.join(path.dirname(Bun.resolveSync('oxlint/package.json', import.meta.dir)), 'bin/oxlint');
  const run = Bun.spawnSync([process.execPath, oxlint, '-c', 'oxlintrc.json', '-f', 'json', '.'], { cwd: workspace });
  const output = JSON.parse(run.stdout.toString()) as {
    diagnostics: { code: string; message: string; filename: string; labels: { span: { offset: number } }[] }[];
  };
  for (const diagnostic of output.diagnostics) {
    const file = path.normalize(diagnostic.filename);
    const list = reports.get(file) ?? [];
    list.push({ rule: diagnostic.code, message: diagnostic.message, offset: diagnostic.labels[0]?.span.offset ?? 0 });
    reports.set(file, list);
  }
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

for (const [rule, { valid, invalid }] of Object.entries(CASES) as [RuleName, (typeof CASES)[RuleName]][]) {
  /** What this rule said about a snippet, in source order. */
  const said = (kind: 'valid' | 'invalid', index: number, snippet: string | Snippet): string[] =>
    (reports.get(snippetPath(rule, kind, index, snippet)) ?? [])
      .filter((report) => report.rule === `synergy(${rule})`)
      .toSorted((a, b) => a.offset - b.offset)
      .map((report) => report.message);

  describe(rule, () => {
    valid.forEach((snippet, index) => {
      test(`accepts: ${typeof snippet === 'string' ? snippet : snippet.code}`, () => {
        expect(said('valid', index, snippet)).toEqual([]);
      });
    });

    invalid.forEach((snippet, index) => {
      test(`reports: ${snippet.code}`, () => {
        const messages = said('invalid', index, snippet);
        const expected = snippet.errors ?? [];
        expect(messages).toHaveLength(expected.length);
        expected.forEach((text, at) => {
          if (typeof text === 'string') expect(messages[at]).toContain(text);
          else expect(messages[at]).toMatch(text);
        });
      });
    });
  });
}

// The linter cannot import the engine (it loads this plugin for every run, and the engine
// brings PlayCanvas with it), so the plugin keeps its own copies of two engine tables.
describe('the plugin agrees with the engine', () => {
  test('about which messages are sent', () => {
    const sent = new Set([...MonoBehaviour._messageNames, ...NetworkBehaviour._messageNames]);
    const listed: string[] = [...MESSAGES];
    expect(listed.toSorted()).toEqual([...sent].toSorted());
  });

  test('about which Unity messages are not', () => {
    expect(NOT_SENT).toEqual(ENGINE_NOT_SENT);
  });

  test('about which names the engine keeps on a script', () => {
    const engine = Engine.createHeadless();
    try {
      class Plain extends MonoBehaviour {}
      const script = new GameObject('Probe').addComponent(Plain);
      const kept = new Set<string>();
      for (
        let part: object | null = script;
        part && part !== Object.prototype;
        part = Object.getPrototypeOf(part) as object | null
      ) {
        for (const name of Object.getOwnPropertyNames(part)) if (name.startsWith('_')) kept.add(name);
      }
      // Fields of EngineObject that TypeScript already guards with `private`/`readonly` are in the list too.
      const listed: string[] = [...ENGINE_MEMBERS];
      expect(listed.toSorted()).toEqual([...kept].toSorted());
    } finally {
      engine.dispose();
    }
  });
});
