// A check that has been silenced has to say why, where it was silenced. The linter cannot
// hold its own off-switch to that: `/* oxlint-disable */` at the top of a file turns off
// every rule, including any rule about disabling rules. So this reads the files instead.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const SKIP =
  /(^|\/)(node_modules|dist|\.git|\.screenshots|\.wrangler|\.fallow|\.claude\/worktrees|convex\/_generated|desktop\/\.hutch|\.hutch)(\/|$)/;
/** Files that write these comments inside strings, as the subject of their own tests. */
const ABOUT_SUPPRESSIONS = new Set(['tools/lint/suppressions.test.ts']);

interface Suppression {
  line: number;
  problem: string;
}

/** Comments in `source` that silence a check without a reason, or silence everything. */
function unexplainedSuppressions(source: string): Suppression[] {
  const found: Suppression[] = [];
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    const comment =
      /(?:\/\/|\/\*)\s*(@ts-nocheck|@ts-ignore|(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?)\b(.*)$/.exec(
        text,
      );
    if (!comment) return;
    const [, kind = '', rest = ''] = comment;
    const after = rest.replace(/\*\/\s*$/, '').trim();
    if (kind === '@ts-nocheck') {
      found.push({ line, problem: '@ts-nocheck turns the type checker off for the whole file. Fix the errors.' });
    } else if (kind === '@ts-ignore') {
      found.push({
        line,
        problem: '@ts-ignore hides whatever is wrong on the next line, now and later. Use `// @ts-expect-error <why>`.',
      });
    } else if (kind.endsWith('-enable')) {
      // Turning rules back on needs no excuse.
    } else {
      const [rulePart = '', reason = ''] = after.split(/\s--\s/, 2);
      if (!rulePart.trim()) {
        found.push({ line, problem: `${kind} with no rule named turns every rule off. Name the rule, and say why.` });
      } else if (reason.trim().length < 10) {
        found.push({
          line,
          problem: `${kind} needs its reason on the same line: \`${kind} ${rulePart.trim()} -- why this place is different\`.`,
        });
      }
    }
  });
  return found;
}

describe('recognising a suppression', () => {
  const problems = (source: string) => unexplainedSuppressions(source).map((found) => found.problem);

  test('one with a rule and a reason is fine', () => {
    expect(problems('// oxlint-disable-next-line synergy/no-unsent-message -- the mistake this test is about')).toEqual(
      [],
    );
    expect(problems('/* oxlint-enable */')).toEqual([]);
    expect(problems('const text = "plain code";')).toEqual([]);
  });

  test('one without a reason, or without a rule, is not', () => {
    expect(problems('// oxlint-disable-next-line synergy/no-unsent-message').join()).toContain('needs its reason');
    expect(problems('/* oxlint-disable */').join()).toContain('turns every rule off');
    expect(problems('// eslint-disable-next-line no-console -- no').join()).toContain('needs its reason');
  });

  test('the type checker is not switched off', () => {
    expect(problems('// @ts-nocheck').join()).toContain('whole file');
    expect(problems('  // @ts-ignore').join()).toContain('@ts-expect-error');
  });
});

test('no file in the project silences a check without saying why', () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: ROOT, dot: true })].filter(
    (file) => !SKIP.test(file) && !ABOUT_SUPPRESSIONS.has(file),
  );
  expect(files.length).toBeGreaterThan(50);
  const found = files.flatMap((file) =>
    unexplainedSuppressions(readFileSync(path.join(ROOT, file), 'utf8')).map(
      (suppression) => `${file}:${suppression.line}: ${suppression.problem}`,
    ),
  );
  expect(found).toEqual([]);
});
