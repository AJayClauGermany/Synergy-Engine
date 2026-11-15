import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ADR_FOLDER, fixture, loadAdrs, runAdr } from './harness';

// Each rule in .archgate/adrs runs on small projects: one it must accept, one it must
// report, with the text each report must contain. The rules themselves only run on this
// repository through the archgate CLI (`bun run adrs`), which is optional; these tests
// hold the rules to what their ADRs say whether or not it is installed.

interface Case {
  files: Record<string, string>;
  /** `ctx.changedFiles`. Empty: a full scan. */
  changed?: string[];
  /** One entry per finding of this rule, in order: text its message must contain. Empty: none. */
  reports?: (string | RegExp)[];
}

const adrs = await loadAdrs();

// A multi-line import names the type too (`  type Command,`): it is not where the type is declared.
const SESSION =
  "import { CommandSession } from '@synergy/net';\nimport {\n  type Command,\n  check,\n} from '../rules/game';\n" +
  'const session = CommandSession.local<Command>();\n';

const CASES: Record<string, Case[]> = {
  'GAME-001/loaded-scenes-are-registered': [
    {
      files: {
        'game/src/main.tsx':
          "import { FRONTIER_SCENE } from './frontier/scene';\n" +
          "SceneManager.register('Menu', buildMenuScene);\n" +
          'SceneManager.register(FRONTIER_SCENE, frontierScene);\n' +
          "await SceneManager.loadScene('Menu');\n" +
          'await manager.sceneManager.loadScene(FRONTIER_SCENE);\n' +
          '// a name held in a variable is not followed\n' +
          'await SceneManager.loadScene(requested);\n',
        'game/src/frontier/scene.ts': "export const FRONTIER_SCENE = 'Frontier';\n",
      },
    },
    {
      files: {
        'game/src/main.tsx': "SceneManager.register('Main', build);\nawait SceneManager.loadScene('Menu');\n",
        // Registered only by a test: not there when the game runs.
        'game/test/flow.test.ts': "SceneManager.register('Menu', build);\n",
      },
      reports: [/Scene "Menu" is loaded here.*Registered scenes: "Main"/],
    },
  ],
  'GAME-001/scenes-have-a-main-camera-and-a-light': [
    {
      files: {
        'game/src/main.tsx':
          "import { buildMenu } from './scenes/Menu';\nSceneManager.register('Menu', buildMenu);\n" +
          "SceneManager.register('Arena', buildArena);\n",
        'game/src/scenes/Menu.ts':
          "export const buildMenu = () => {\n  const camera = new GameObject('Main Camera');\n" +
          "  camera.tag = 'MainCamera';\n  new GameObject('Sun').addComponent(Light);\n};\n",
        // The camera comes from a helper the scene file imports.
        'game/src/scenes/Arena.ts':
          "import { makeRig } from '../behaviours/rig';\nexport function buildArena() { makeRig(); new GameObject('Sun').addComponent(Light); }\n",
        'game/src/behaviours/rig.ts':
          "export function makeRig() { const c = new GameObject('Cam'); c.tag = 'MainCamera'; c.addComponent(Camera); }\n",
      },
    },
    {
      files: {
        'game/src/main.tsx': "SceneManager.register('Dark', buildDark);\n",
        'game/src/scenes/Dark.ts':
          "export const buildDark = () => {\n  const camera = new GameObject('Camera');\n  camera.tag = 'mainCamera';\n};\n",
      },
      reports: [
        /Scene "Dark" \(built in game\/src\/scenes\/Dark\.ts\) has no a camera tagged 'MainCamera'.*and no a Light/,
      ],
    },
  ],

  'GAME-002/layers-are-defined': [
    {
      files: {
        'game/src/main.tsx': "LayerMask.define(8, 'Units');\n",
        'game/src/behaviours/Picker.ts':
          "const mask = LayerMask.getMask('Units', 'Default');\nunit.layer = LayerMask.nameToLayer('UI');\n",
      },
    },
    {
      files: {
        'game/src/main.tsx': "LayerMask.define(8, 'Units');\nLayerMask.define(40, 'Far');\n",
        'game/src/behaviours/Picker.ts': "unit.layer = LayerMask.nameToLayer('Untis');\n",
      },
      reports: ['Layer index 40 is out of range', /Layer "Untis" is never defined.*"Units"/],
    },
  ],
  'GAME-002/looked-up-tags-are-assigned': [
    {
      files: {
        'game/src/prefabs.ts': "export const Enemy = new Prefab('Enemy', (go) => { go.tag = 'Enemy'; });\n",
        'game/src/behaviours/Radar.ts':
          "const all = GameObject.findGameObjectsWithTag('Enemy');\nif (other.compareTag('Untagged')) return;\n",
        'game/src/scenes/A.ts': "camera.tag = 'MainCamera';\n",
      },
    },
    {
      files: {
        'game/src/prefabs.ts': "go.tag = 'Enemy';\ncamera.tag = 'mainCamera';\n",
        'game/src/behaviours/Radar.ts': "GameObject.findWithTag('Pickup');\nother.compareTag('enemy');\n",
      },
      reports: [
        'Tag "Pickup" is looked up here but no code in game/src sets it',
        'Tag "mainCamera" differs from "MainCamera" only in case',
        // Reported once, as a spelling, not also as never assigned.
        'Tag "enemy" differs from "Enemy" only in case',
      ],
    },
  ],

  'GAME-003/no-component-lookups-in-field-initialisers': [
    {
      files: {
        'game/src/behaviours/Unit.ts':
          'export class Unit extends MonoBehaviour {\n' +
          '  static readonly requireComponents = [BoxCollider];\n' +
          '  readonly box = this.getComponent(BoxCollider);\n' +
          '  private body: MeshRenderer | null = null;\n' +
          '  onHit = () => this.getComponent(Health);\n' +
          '  awake() {\n    this.body = this.getComponent(MeshRenderer);\n    const kids = this.getComponentsInChildren(Collider);\n  }\n' +
          '}\n',
      },
    },
    {
      files: {
        'game/src/behaviours/Unit.ts':
          'export class Unit extends MonoBehaviour {\n' +
          '  private body = this.getComponent(MeshRenderer);\n' +
          '  // readonly kids = this.getComponent(Commented);\n' +
          '  readonly kids = this.gameObject.getComponentsInChildren(Collider);\n' +
          '}\n',
      },
      reports: [/Unit: getComponent\(MeshRenderer\) runs in a field initialiser/, 'getComponentsInChildren(Collider)'],
    },
  ],
  'GAME-003/prefabs-build-onto-their-instance': [
    {
      files: {
        'game/src/prefabs.ts':
          "export const Enemy = new Prefab('Enemy', (go) => { go.addComponent(Enemy); });\n" +
          "export const Squad = new Prefab('Squad', (go) => instantiate(Child, go.transform));\n" +
          "export const Hat = new Prefab('Hat', (go) => {\n  const hat = new GameObject('Hat');\n  hat.transform.setParent(go.transform);\n});\n",
      },
    },
    {
      files: {
        'game/src/prefabs.ts':
          "export const Enemy = new Prefab('Enemy', () => {\n  const enemy = new GameObject('Enemy');\n  enemy.addComponent(BoxCollider);\n  return enemy;\n});\n" +
          "export const Unit = new NetworkPrefab('Unit', (go) => {\n  const unit = new GameObject('Unit');\n  return unit;\n});\n",
      },
      reports: [
        'This build function makes a GameObject of its own',
        'This build function makes a GameObject of its own',
      ],
    },
  ],
  'GAME-003/integer-vectors-get-whole-numbers': [
    {
      files: {
        'game/src/board.ts':
          'const a = new Vector3Int(Math.trunc(width / 2), 0, 0);\n' +
          'const b = new Vector2Int(Mathf.floorToInt(x / size), y);\n' +
          "const c = new Vector2Int(parse('a/b'), 0); // a / in a string or a comment is not a division\n",
      },
    },
    {
      files: {
        'game/src/board.ts':
          'const a = new Vector3Int(width / 2, 0, 0);\nconst b = new Vector2Int(Math.trunc(w / 2) + h / 2, 0);\n',
      },
      reports: ['A division inside new Vector3Int(...)', 'A division inside new Vector2Int(...)'],
    },
  ],

  'GAME-004/commands-are-plain-data': [
    {
      files: {
        'game/src/rules/game.ts':
          'export interface Cell {\n  x: number;\n  y: number;\n}\nexport type Team = 0 | 1;\n' +
          "export type Command =\n  | { type: 'move'; unit: number; to: Cell }\n  | { type: 'pass'; team: Team; note: string | null };\n",
        'game/src/behaviours/GameController.ts': SESSION,
      },
    },
    {
      files: {
        'game/src/rules/game.ts':
          "import { type Vector3 } from '@synergy/engine/math';\n" +
          'export interface Order {\n  targets: Set<number>;\n}\n' +
          "export type Command = { type: 'spawn'; at: Vector3 };\nexport type Other = { type: 'order'; order: Order };\n",
        'game/src/behaviours/GameController.ts':
          SESSION +
          "const other = CommandSession.local<Other>();\nconst again = CommandSession.join<Command>(t, 'host');\n",
      },
      reports: ['Command > Vector3: a command is sent to every player as JSON', 'Other > Order > Set'],
    },
  ],
  'GAME-004/rpc-arguments-are-plain-data': [
    {
      files: {
        'game/src/frontier/Soldier.ts':
          'readonly moveRpc = this.serverRpc((x: number, y: number) => this.move(x, y), { requireOwnership: false });\n' +
          'readonly sayRpc = this.clientRpc((text: string, at: { x: number; y: number }) => show(text, at));\n',
      },
    },
    {
      files: {
        'game/src/frontier/Soldier.ts':
          'interface Order {\n  seen: Map<string, number>;\n}\n' +
          'readonly lookRpc = this.serverRpc((at: Vector3) => {\n  this.look(at);\n});\n' +
          'readonly orderRpc = this.clientRpc((order: Order) => this.obey(order));\n',
      },
      reports: ['This serverRpc takes argument > Vector3', 'This clientRpc takes argument > Order > Map'],
    },
  ],
  'GAME-004/network-variables-are-plain-or-serialized': [
    {
      files: {
        'game/src/frontier/Soldier.ts':
          'readonly cell = new NetworkVariable({ x: 0, y: 0 });\nreadonly winner = new NetworkVariable(-1);\n' +
          'readonly at = new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 });\n' +
          'readonly loot = new NetworkList<string>();\n',
      },
    },
    {
      files: {
        'game/src/frontier/Soldier.ts':
          'readonly at = new NetworkVariable(Vector3.zero);\nreadonly until = new NetworkVariable(Number.POSITIVE_INFINITY);\n' +
          'readonly facing = new NetworkVariable<Quaternion | null>(null);\nreadonly seen = new NetworkList<Map<string, number>>();\n',
      },
      reports: [
        'This NetworkVariable starts as Vector3',
        'This NetworkVariable starts as POSITIVE_INFINITY',
        'This NetworkVariable is declared to hold Quaternion',
        'This NetworkList is declared to hold Map',
      ],
    },
  ],

  'GAME-005/shipped-content-is-checked': [
    {
      files: {
        'game/src/maps/data/map.json': JSON.stringify({ layers: [{ name: 'Terrain', tiles: ['plain'] }] }),
        'game/src/maps/data/tiles.json': JSON.stringify({ tiles: [{ id: 'plain' }] }),
        'game/src/maps/data/names.json': JSON.stringify(['not', 'content']),
        'game/package.json': JSON.stringify({ name: 'game' }),
        'game/src/maps/rules.ts':
          "import mapJson from './data/map.json';\nimport tilesJson from './data/tiles.json';\n",
        'game/test/content.test.ts':
          "import { map, tiles } from '../src/maps/rules';\n" +
          'expect(checkTilePaletteData(tiles)).toEqual([]);\nexpect(checkTilemapData(map, ids)).toEqual([]);\n',
      },
    },
    {
      files: {
        'game/src/maps/data/level2.json': JSON.stringify({ layers: [{ name: 'Terrain', tiles: ['plain'] }] }),
        'game/src/maps/data/map.json': JSON.stringify({ layers: [{ name: 'Terrain', tiles: ['plain'] }] }),
        'game/src/maps/data/tiles.json': JSON.stringify({ tiles: [{ id: 'plain' }] }),
        'game/src/maps/rules.ts':
          "import mapJson from './data/map.json';\nimport tilesJson from './data/tiles.json';\n",
        'game/test/content.test.ts':
          "import { tiles } from '../src/maps/rules';\nexpect(checkTilePaletteData(tiles)).toEqual([]);\n",
      },
      reports: [
        'game/src/maps/data/level2.json is a tile map the game ships, and no test runs checkTilemapData over it',
        'game/src/maps/data/map.json is a tile map',
      ],
    },
  ],
  'GAME-005/command-variants-are-tested': [
    {
      files: {
        'game/src/rules/game.ts':
          "export type Command =\n  | { type: 'move'; unit: number }\n  | { type: 'endTurn' };\n",
        'game/src/behaviours/GameController.ts': SESSION,
        'game/test/game.test.ts':
          'expect(check(state, { type: \'move\', unit: 1 }, 0)).toBeNull();\napply(state, { type: "endTurn" });\n',
      },
    },
    {
      files: {
        'game/src/rules/game.ts':
          "export interface HealCommand {\n  type: 'heal';\n  unit: number;\n}\n" +
          "export type Command =\n  | { type: 'move'; unit: number }\n  | { type: 'retreat' }\n  | HealCommand;\n",
        'game/src/behaviours/GameController.ts': SESSION,
        'game/test/game.test.ts':
          "apply(state, { type: 'move', unit: 1 });\n// { type: 'retreat' } in a comment does not count\n",
      },
      reports: ["Command 'retreat' (Command) is not named in any test", "Command 'heal' (Command)"],
    },
  ],

  'FE-001/text-fields-update-on-input': [
    {
      files: {
        'game/src/ui/Lobby.tsx':
          'const a = <input value={code} onInput={(event) => setCode(event.currentTarget.value)} />;\n' +
          'const b = <input type="checkbox" checked={on} onChange={() => setOn(!on)} />;\n' +
          'const c = <select onChange={(event) => pick(event.currentTarget.value)}>{options}</select>;\n',
      },
    },
    {
      files: {
        'game/src/ui/Lobby.tsx':
          'const a = <input value={v} onChange={(event) => set(event.currentTarget.value)} />;\n' +
          'const b = (\n  <textarea\n    rows={3}\n    onChange={(event) => setNote(event.currentTarget.value)}\n  />\n);\n',
      },
      reports: ['onChange on a text <input>', 'onChange on a text <textarea>'],
    },
  ],
  'FE-001/pointer-handlers-are-interactive': [
    {
      files: {
        'game/src/ui/Hud.tsx':
          'const [code, setCode] = useState<string>("");\n' +
          'const a = <button type="button" onClick={() => endTurn()}>End turn</button>;\n' +
          'const b = <div data-interactive onClick={() => pick()} />;\n' +
          'const c = <li data-interactive="" onPointerDown={() => drag()} />;\n' +
          'const d = <Panel onClick={() => close()} />;\n' +
          'const e = <div className="panel">{n > 1 ? "many" : "one"}</div>;\n',
      },
    },
    {
      files: {
        'game/src/ui/Hud.tsx':
          'const a = <div className="card" onClick={() => pick(card)}>{card.name}</div>;\n' +
          'const b = (\n  <span\n    onPointerDown={() => count > 1 && go()}\n  >\n    drag\n  </span>\n);\n',
      },
      reports: ['<div onClick=...> without data-interactive', '<span onPointerDown=...> without data-interactive'],
    },
  ],

  'GEN-001/browser-code-reads-only-public-variables': [
    {
      files: {
        'game/src/env.ts': 'export const convexUrl = read(() => process.env.PUBLIC_CONVEX_URL);\n',
        'game/src/main.tsx': "const devtools = process.env.NODE_ENV !== 'production';\n",
        'packages/net/src/Lobby.ts': '/**\n *   new Lobby(process.env.SECRET_URL)\n */\n',
        'scripts/deploy.ts': 'const token = process.env.CLOUDFLARE_API_TOKEN;\n',
      },
    },
    {
      files: {
        'game/src/online.ts': 'const url = process.env.CONVEX_URL;\n',
        'game/src/env.ts': "const a = import.meta.env.PUBLIC_A;\nconst b = Bun.env['PUBLIC_B'];\n",
      },
      reports: [
        'import.meta.env.PUBLIC_A in code that runs in the browser',
        'Bun.env.PUBLIC_B in code that runs in the browser',
        /process\.env\.CONVEX_URL in code that runs in the browser: only NODE_ENV and PUBLIC_ variables/,
      ],
    },
  ],
  'GEN-001/public-variables-are-declared': [
    {
      files: {
        '.env.schema': '# The lobby.\n# @type=url\nPUBLIC_CONVEX_URL=${CONVEX_URL}\n',
        'game/src/env.ts': 'export const convexUrl = read(() => process.env.PUBLIC_CONVEX_URL);\n',
      },
    },
    {
      files: {
        '.env.schema': 'PUBLIC_CONVEX_URL=\n',
        'scripts/build.ts': "if (!process.env['PUBLIC_BUILD_ID']) process.env.PUBLIC_BUILD_ID = 'x';\n",
      },
      reports: [
        'PUBLIC_BUILD_ID is read here but .env.schema does not declare it',
        'PUBLIC_BUILD_ID is read here but .env.schema does not declare it',
      ],
    },
  ],
  'GEN-001/public-variables-are-not-secret': [
    {
      files: {
        '.env.schema':
          '# @defaultSensitive=false\n# ---\n\n# Not secret.\nPUBLIC_CONVEX_URL=\n\n# @sensitive\nCONVEX_DEPLOY_KEY=\n',
      },
    },
    {
      files: {
        '.env.schema':
          '# @defaultSensitive=true\n# ---\n\n# A key.\n# @sensitive\nPUBLIC_KEY=\n\n# Sensitive by default.\nPUBLIC_A=\n\n# @sensitive=false\nPUBLIC_B=\n',
      },
      reports: ['PUBLIC_KEY is marked secret', 'PUBLIC_A is marked secret'],
    },
  ],

  'GEN-002/generated-code-changes-with-its-sources': [
    { files: { 'convex/rooms.ts': '' }, changed: ['convex/_generated/api.d.ts', 'convex/rooms.ts'] },
    { files: { 'bun.lock': '' }, changed: ['bun.lock', 'convex/_generated/api.js'] },
    // A full scan has no change set, so nothing to compare.
    { files: { 'convex/_generated/api.d.ts': '' } },
    {
      files: { 'convex/_generated/api.d.ts': '' },
      changed: ['convex/_generated/api.d.ts', 'game/src/main.tsx'],
      reports: ['convex/_generated/api.d.ts changed, but no Convex function, package.json or bun.lock did'],
    },
  ],
};

describe('ADR rules', () => {
  for (const adr of adrs) {
    for (const rule of Object.keys(adr.rules)) {
      const id = `${adr.id}/${rule}`;
      test(id, async () => {
        const cases = CASES[id] ?? [];
        // Every rule is shown both accepting code and reporting it.
        expect(
          cases.some((each) => !each.reports?.length),
          `${id} has a case it accepts`,
        ).toBe(true);
        expect(
          cases.some((each) => (each.reports?.length ?? 0) > 0),
          `${id} has a case it reports`,
        ).toBe(true);
        for (const each of cases) {
          const project = fixture(each.files);
          try {
            const found = (await runAdr(adr, project.root, { changed: each.changed })).filter((f) => f.rule === id);
            const expected = each.reports ?? [];
            expect(found.map((f) => f.message).length, found.map((f) => f.message).join('\n')).toBe(expected.length);
            expected.forEach((text, index) => {
              const message = found[index]?.message ?? '';
              if (typeof text === 'string') expect(message).toContain(text);
              else expect(message).toMatch(text);
              // A finding says where, and what to write instead.
              expect(found[index]?.file).toBeTruthy();
              expect(found[index]?.fix).toBeTruthy();
            });
          } finally {
            project.dispose();
          }
        }
      });
    }
  }

  test('every case belongs to a rule that exists', () => {
    const ids = new Set(adrs.flatMap((adr) => Object.keys(adr.rules).map((rule) => `${adr.id}/${rule}`)));
    expect(Object.keys(CASES).filter((id) => !ids.has(id))).toEqual([]);
  });
});

/** The text of a `## Heading` section, up to the next heading of the same level. */
function section(text: string, heading: string): string | null {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

const BUILT_IN_DOMAINS = ['backend', 'frontend', 'data', 'architecture', 'general'];
const config = JSON.parse(readFileSync(path.join(ADR_FOLDER, '../config.json'), 'utf8')) as {
  domains?: Record<string, string>;
};

describe('ADRs load in archgate', () => {
  for (const adr of adrs) {
    test(adr.name, () => {
      const text = readFileSync(path.join(ADR_FOLDER, `${adr.name}.md`), 'utf8');

      // What archgate's loader requires of a rules file (src/engine/loader.ts).
      expect(adr.source).toMatch(/^\/\/\/\s*<reference\s+path=["'][^"']*rules\.d\.ts["']\s*\/>$/m);
      expect(adr.source).toMatch(/\bsatisfies\s+RuleSet\b/);
      // Its sandbox: no imports but these, and no names of what reaches outside `ctx`.
      const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(adr.source).map((each) => each.path);
      expect(imports.filter((each) => !['node:path', 'node:url', 'node:util', 'node:crypto'].includes(each))).toEqual(
        [],
      );
      const code = adr.source
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
      const banned =
        /(?<![\w$.\\])(globalThis|global|self|Bun|process|Reflect|eval|Function|fetch|WebSocket|require)\s*[.([]/;
      expect(banned.exec(code)?.[0] ?? null).toBeNull();

      // The ID is the file's prefix, the domain is one archgate knows.
      expect(adr.name.startsWith(`${adr.id}-`)).toBe(true);
      const domain = /^domain:\s*(\S+)$/m.exec(text)?.[1] ?? '';
      expect([...BUILT_IN_DOMAINS, ...Object.keys(config.domains ?? {})]).toContain(domain);
      expect(adr.files.length).toBeGreaterThan(0);

      // The sections the ADR schema recommends, and the two that agents are briefed with
      // short enough that `archgate review-context` does not cut them (2000 characters).
      for (const heading of [
        'Context',
        'Decision',
        "Do's and Don'ts",
        'Consequences',
        'Compliance and Enforcement',
        'References',
      ]) {
        expect(section(text, heading), heading).not.toBeNull();
      }
      for (const briefed of ['Decision', "Do's and Don'ts"]) {
        expect(section(text, briefed)?.length ?? 0, briefed).toBeLessThanOrEqual(2000);
      }
      // The document names every rule its companion file enforces.
      const enforcement = section(text, 'Compliance and Enforcement') ?? '';
      for (const rule of Object.keys(adr.rules)) expect(enforcement).toContain(`${adr.id}/${rule}`);
    });
  }
});
