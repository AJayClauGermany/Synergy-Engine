import { describe, expect, test } from 'bun:test';
import {
  type Block,
  checkBlocks,
  checkPaths,
  checkScripts,
  checkSkill,
  extractBlocks,
  extractMembers,
  fileHints,
  knownExports,
  shapeOf,
} from './docs';

/** A Markdown file with one TypeScript block, opened on line 3. */
function guide(code: string, info = 'ts'): string {
  return `# A guide\n\n\`\`\`${info}\n${code}\n\`\`\`\n`;
}

/** What the checker says about one block of a guide. */
async function compile(code: string, prose = ''): Promise<string[]> {
  const text = `${guide(code)}\n${prose}\n`;
  const blocks = [...extractBlocks('guide.md', text), ...extractMembers('guide.md', text, knownExports())];
  return (await checkBlocks(blocks)).map((finding) => `${finding.line}: ${finding.message}`);
}

describe('finding the blocks', () => {
  test('TypeScript blocks are found with the line they open on; other languages are left alone', () => {
    const text =
      '# Title\n\n```bash\nbun run check\n```\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n```tsx\n<div />\n```\n';
    expect(extractBlocks('a.md', text).map(({ line, lang, code }) => ({ line, lang, code }))).toEqual([
      { line: 7, lang: 'ts', code: 'const a = 1;\nconst b = 2;' },
      { line: 12, lang: 'tsx', code: '<div />' },
    ]);
  });

  test('a block inside a list item loses the list indent', () => {
    const [block] = extractBlocks('a.md', '1. Step:\n   ```ts\n   if (ready) {\n     go();\n   }\n   ```\n');
    expect(block?.code).toBe('if (ready) {\n  go();\n}');
  });

  test('```ts sketch is found and marked as not to be compiled', () => {
    expect(extractBlocks('a.md', guide('foo(...)', 'ts sketch'))[0]?.sketch).toBe(true);
    expect(extractBlocks('a.md', guide('foo()'))[0]?.sketch).toBe(false);
  });

  test('a file can say what its bare names are', () => {
    expect(fileHints('<!-- check: manager: NetworkManager; session: CommandSession<Command> -->')).toEqual({
      manager: 'NetworkManager',
      session: 'CommandSession<Command>',
    });
  });
});

describe('the shape of a block', () => {
  test('a whole file, the members of a script, or statements from inside a method', () => {
    expect(shapeOf("import { Vector3 } from '@synergy/engine';\nconst up = Vector3.up;", 'ts')).toBe('module');
    expect(shapeOf('speed = 2;\nupdate() {\n  this.transform.translate(Vector3.forward);\n}', 'ts')).toBe('members');
    expect(shapeOf('yield new WaitForSeconds(1);\nthis.fire();', 'ts')).toBe('body');
  });

  test('two declarations of one name are alternatives, not a mistake', () => {
    expect(shapeOf('const a = one();\nconst a = other();', 'ts')).toBe('module');
  });

  test('what is not TypeScript is reported with its line', () => {
    expect(shapeOf('const a = 1;\nsession.submit(...);', 'ts')).toMatchObject({ line: 2 });
  });
});

describe('compiling blocks against the engine', () => {
  test('a block that uses the engine as it is passes, with or without its imports', async () => {
    expect(
      await compile(
        "import { MonoBehaviour, Time, Vector3 } from '@synergy/engine';\n\n" +
          'export class Thing extends MonoBehaviour {\n  speed = 2;\n  update() {\n' +
          '    this.transform.translate(Vector3.forward.mul(this.speed * Time.deltaTime));\n  }\n}',
      ),
    ).toEqual([]);
    expect(
      await compile(
        'const hit = Physics.raycast(new Ray(Vector3.zero, Vector3.forward));\nif (hit) select(hit.gameObject);',
      ),
    ).toEqual([]);
  });

  test('a method the engine does not have is reported on its line in the guide', async () => {
    const found = await compile('const position = Vector3.zero;\nconst moved = position.plus(Vector3.up);');
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith('5: ');
    expect(found[0]).toContain("'plus'");
  });

  test("names the block leaves to the reader are let through; what is built on the engine's is not", async () => {
    expect(await compile('unit.transform.position = grid.getCellCenterWorld(cell);\nboard.refresh(unit);')).toEqual([]);
    const found = await compile('unit.transform.position = grid.getCellCentreWorld(cell);');
    expect(found.join()).toContain('getCellCentreWorld');
  });

  test('the members of a script are checked as a script', async () => {
    expect(
      await compile(
        'start() {\n  this.startCoroutine(this.run());\n}\n*run(): IEnumerator {\n  yield new WaitForSeconds(1);\n}',
      ),
    ).toEqual([]);
    expect((await compile('Update() {\n  this.tick();\n}')).join()).toContain("'Update'");
  });

  test('a networked fragment is checked as a NetworkBehaviour', async () => {
    expect(
      await compile(
        'readonly health = new NetworkVariable(100);\nreadonly hitRpc = this.serverRpc((amount: number) => {\n  this.health.value -= amount;\n});',
      ),
    ).toEqual([]);
    expect((await compile('readonly hitRpc = this.serverRPC(() => {});')).join()).toContain('serverRPC');
  });

  test('a block that imports from a package must import all it uses from it', async () => {
    const found = await compile(
      "import { MonoBehaviour } from '@synergy/engine';\nexport class A extends MonoBehaviour {\n  at = Vector3.zero;\n}",
    );
    expect(found).toEqual([
      "6: `Vector3` is used but not imported. This block imports from '@synergy/engine', so add it to that import.",
    ]);
  });

  test("an import of the reader's own file is taken on trust", async () => {
    expect(
      await compile(
        "import { Mover } from '../src/behaviours/Mover';\nconst mover = new GameObject('M').addComponent(Mover);\nmover.speed = 3;",
      ),
    ).toEqual([]);
  });

  test('a member named in a sentence must exist; Unity spellings are quotations', async () => {
    expect(
      await compile(
        'const a = 1;',
        'Use `Tween.move(transform, to, 0.3)` and `tilemap.setTile`, as Unity has `Physics.Raycast`.',
      ),
    ).toEqual([]);
    const found = await compile('const a = 1;', 'Call `Tween.moveTo(...)` or `tilemap.paint`.');
    expect(found).toHaveLength(2);
    expect(found.join()).toContain('names `.moveTo`');
    expect(found.join()).toContain('names `.paint`');
    expect(found[0]).toStartWith('7: ');
  });

  test('a sketch is not compiled', async () => {
    const blocks: Block[] = extractBlocks('guide.md', guide('this is not code at all (...)', 'ts sketch'));
    expect(await checkBlocks(blocks)).toEqual([]);
  });
});

describe('commands and paths', () => {
  const scripts = new Set(['check', 'fix', 'screenshot']);

  test('`bun run` must name a script; running a file is not a script', () => {
    expect(checkScripts('a.md', 'Run `bun run check`, then `bun run screenshot --hierarchy`.\n', scripts)).toEqual([]);
    expect(checkScripts('a.md', '```bash\nbun run scripts/build.ts\n```\n', scripts)).toEqual([]);
    const found = checkScripts('a.md', 'line one\nRun `bun run verify` first.\n', scripts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2 });
    expect(found[0]?.message).toContain('"verify"');
  });

  const exists = (file: string) => ['game/test/scene.test.ts', 'docs/checks.md'].includes(file);

  test('a path to a file in the repository must exist', () => {
    expect(checkPaths('AGENTS.md', 'Copy `game/test/scene.test.ts` (see `docs/checks.md`).', exists)).toEqual([]);
    const found = checkPaths('AGENTS.md', 'Copy `game/test/scenes.test.ts`.', exists);
    expect(found[0]?.message).toContain('game/test/scenes.test.ts');
  });

  test('example names, folders and package names are not claims about the repository', () => {
    const text = 'Create `game/src/behaviours/Thing.ts`, put images in `game/public/`, import `convex/values`.';
    expect(checkPaths('AGENTS.md', text, exists)).toEqual([]);
  });

  test('a relative link is followed from the file it is in', () => {
    expect(checkPaths('docs/setup.md', 'See [checks](checks.md) and [the site](https://example.com).', exists)).toEqual(
      [],
    );
    expect(checkPaths('docs/setup.md', 'See [checks](check.md).', exists)[0]?.message).toContain('check.md');
  });
});

describe('the shape of a skill', () => {
  const context = {
    skills: new Set(['tile-maps', 'game-ai']),
    agentsGuide: 'Skills: `tile-maps`, `game-ai`.',
    skillsGuide: '| `tile-maps` | maps |\n| `game-ai` | opponents |',
  };
  const skill = (changes: { description?: string; body?: string; name?: string } = {}) =>
    [
      '---',
      `name: ${changes.name ?? 'tile-maps'}`,
      `description: ${changes.description ?? 'Builds maps, grids and boards from tiles, with cell picking and movement ranges. Use when a task mentions tiles, hexes or pathfinding. Not for the opponent that walks the map (use `game-ai`).'}`,
      '---',
      '',
      '# Tile maps',
      '',
      changes.body ?? '## Gotchas\n\n- Cells are compared with `.equals`.\n\n## Verify\n\nRun `bun run check`.',
      '',
    ].join('\n');
  const check = (text: string) =>
    checkSkill('.claude/skills/tile-maps/SKILL.md', text, context).map((finding) => finding.message);

  test('a skill of the right shape passes', () => {
    expect(check(skill())).toEqual([]);
  });

  test('the name is the folder', () => {
    expect(check(skill({ name: 'tilemaps' })).join()).toContain('must match the folder');
  });

  test('the description says when to use it and names a neighbour that exists', () => {
    expect(check(skill({ description: `Builds maps from tiles. ${'It is thorough. '.repeat(5)}` })).join()).toContain(
      'Use when',
    );
    expect(
      check(
        skill({
          description: `Builds maps from tiles. Use when a task mentions tiles or hexes. ${'It is thorough. '.repeat(3)}`,
        }),
      ).join(),
    ).toContain('Not for');
    const wrong =
      'Builds maps from tiles. Use when a task mentions tiles, hexes or pathfinding. Not for opponents (use `enemy-ai`).';
    expect(check(skill({ description: wrong })).join()).toContain('`enemy-ai`, which is not a skill here');
  });

  test('a folded description is read whole', () => {
    const folded =
      '>\n  Builds maps, grids and boards from tiles. Use when a task mentions tiles,\n  hexes or pathfinding. Not for the opponent that walks the map (use `game-ai`).';
    expect(check(skill({ description: folded }))).toEqual([]);
  });

  test('Gotchas and a last section that checks the work are required', () => {
    expect(check(skill({ body: '## Traps\n\n- One.\n\n## Verify\n\nRun it.' })).join()).toContain('## Gotchas');
    expect(check(skill({ body: '## Gotchas\n\n- One.\n\n## Background\n\nHistory.' })).join()).toContain(
      'how to check the work',
    );
  });

  test('a skill it points to must exist, and it must be listed where people look', () => {
    expect(
      check(skill({ body: 'See the `netcode` skill.\n\n## Gotchas\n\n- One.\n\n## Verify\n\nRun it.' })).join(),
    ).toContain('`netcode` is not a skill here');
    const unlisted = checkSkill('.claude/skills/tile-maps/SKILL.md', skill(), {
      ...context,
      agentsGuide: '',
      skillsGuide: '',
    });
    expect(unlisted.map((finding) => finding.message).join()).toContain('AGENTS.md');
  });
});
