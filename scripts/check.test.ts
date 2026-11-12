import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import cloudflareConfig from '../cloudflare/tsconfig.json';
import packageJson from '../package.json';
import rootConfig from '../tsconfig.json';
import {
  clip,
  parseArgs,
  renderReport,
  sortFindings,
  type Step,
  type StepResult,
  STEPS,
  TIMEOUT_SECONDS,
} from './check';

function step(name: string): Step {
  const found = STEPS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`There is no step called ${name}`);
  return found;
}

function result(name: string, status: StepResult['status'], output = ''): StepResult {
  return { step: step(name), status, seconds: 1.234, output };
}

describe('arguments', () => {
  test('no arguments means every check, and nothing is changed', () => {
    expect(parseArgs([])).toEqual({ fix: false, help: false, only: [], unknown: [] });
  });

  test('step names pick steps, --fix asks for fixes', () => {
    expect(parseArgs(['--fix', 'lint', 'types'])).toEqual({
      fix: true,
      help: false,
      only: ['lint', 'types'],
      unknown: [],
    });
  });

  test('anything else is reported, not ignored', () => {
    expect(parseArgs(['lnt', '--fast']).unknown).toEqual(['lnt', '--fast']);
  });
});

describe('the steps', () => {
  test('each runs a script that exists', () => {
    for (const { name, command } of STEPS) {
      if (command[1] !== 'run') continue;
      const script = command.slice(2).find((part) => !part.startsWith('-'));
      expect(Object.keys(packageJson.scripts), `the script behind "${name}"`).toContain(script ?? '');
    }
  });

  test('the test step counts passes, failures and errors', () => {
    const detail = step('test').detail;
    expect(detail?.(' 404 pass\n 0 fail\n 3587 expect() calls\nRan 404 tests across 26 files.')).toBe(
      '404 pass in 26 files',
    );
    expect(detail?.(' 404 pass\n 2 fail\n 1 error\n')).toBe('2 fail, 1 error, 404 pass');
    // A test that did not run is not a pass, and the line says so.
    expect(detail?.(' 3 pass\n 2 skip\n 1 todo\n 0 fail\nRan 6 tests across 1 file.')).toBe(
      '3 pass, 2 skip (NOT RUN), 1 todo (NOT RUN) in 1 file',
    );
  });

  test('the lint and type steps count findings, and say nothing when there are none', () => {
    const lint = 'a.ts:1:2: error eslint(eqeqeq): Expected ===\nb.ts:3:4: error synergy(no-value-keys): A Map keyed by';
    expect(step('lint').detail?.(lint)).toBe('2 problems');
    expect(step('lint').detail?.('')).toBe('');
    expect(step('types').detail?.("a.ts(1,2): error TS2307: Cannot find module 'x'.")).toBe('1 error');
  });

  test('the project step adds up what both of its commands found', () => {
    const output = '[X] Exit code 1: gate error-severity-findings (3 at or above error) failed.\n(1 at or above error)';
    expect(step('project').detail?.(output)).toBe('4 problems');
  });
});

describe('long output', () => {
  test('is cut to its first lines, with a count of the rest', () => {
    expect(clip('a\nb\nc\nd\n', 2)).toEqual({ text: 'a\nb', hidden: 2 });
    expect(clip('a\nb\n', 2)).toEqual({ text: 'a\nb', hidden: 0 });
  });

  test('lint findings are put in reading order, with other lines after them', () => {
    const lines = [
      'b.ts:2:1: error x',
      'Found 3 errors.',
      'a.ts:10:1: error x',
      'a.ts:9:20: error x',
      'a.ts:9:3: error x',
    ];
    expect(sortFindings(lines)).toEqual([
      'a.ts:9:3: error x',
      'a.ts:9:20: error x',
      'a.ts:10:1: error x',
      'b.ts:2:1: error x',
      'Found 3 errors.',
    ]);
  });
});

describe('what is type-checked', () => {
  // A file outside every tsconfig's `include` is linted, formatted and run by its tests,
  // and never type-checked: `bun run check` says PASSED over a type error in it.
  test('every TypeScript file in the project belongs to a tsconfig', () => {
    const root = path.resolve(import.meta.dir, '..');
    const skip = /(^|\/)(node_modules|dist|\.git|\.screenshots|\.claude\/worktrees|convex\/_generated|desktop)(\/|$)/;
    const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: root, dot: true })].filter(
      (file) => !skip.test(file),
    );
    const covered = [
      ...rootConfig.include.map((entry) => new Bun.Glob(entry.includes('*') ? entry : `${entry}/**`)),
      new Bun.Glob('convex/**'), // convex/tsconfig.json
      ...cloudflareConfig.include.map((entry) => new Bun.Glob(`cloudflare/${entry}`)),
    ];
    const unchecked = files.filter((file) => !covered.some((glob) => glob.match(file)));
    expect(files.length).toBeGreaterThan(100);
    expect(unchecked, 'add the folder to "include" in tsconfig.json').toEqual([]);
  });
});

describe('the report', () => {
  test('a run of some checks does not say PASSED, and names what it left out', () => {
    const report = renderReport([result('lint', 'passed'), result('types', 'passed')], 1.1, ['install', 'test']);
    expect(report).not.toContain('PASSED');
    expect(report).toContain('OK so far: lint, types in 1.1s. Not run: install, test. This is not the full check');
  });

  test('a clean run is one line per check and a verdict', () => {
    const report = renderReport([result('format', 'passed'), result('test', 'passed', ' 12 pass\n 0 fail')], 2.5);
    expect(report).toBe(
      ['ok      format   1.2s', 'ok      test     1.2s  12 pass', '', 'PASSED: 2 checks in 2.5s.'].join('\n'),
    );
  });

  test('a failure shows its output, what to do, and how to rerun', () => {
    const output = 'game/src/Unit.ts:4:7: error eslint(prefer-const): `hp` is never reassigned.';
    const report = renderReport([result('lint', 'failed', output), result('types', 'passed')], 1);
    expect(report).toContain('---- lint FAILED: mistakes in one file (oxlint) ----');
    expect(report).toContain(`  ${output}`);
    expect(report).toContain('What to do:');
    expect(report).toContain('FAILED  lint    1.2s  1 problem');
    expect(report).toContain('ok      types   1.2s');
    expect(report).toEndWith(
      'FAILED: lint. Fix what is listed above, top first, then run `bun run check` again. `bun run fix` does the automatic part.',
    );
  });

  test('lines that only repeat the failure, or say how to silence it, are left out', () => {
    const output = [
      '● Unused files (1)',
      '  game/src/Orphan.ts',
      '  To suppress: // fallow-ignore-file unused-file',
      '[X] Exit code 1: gate error-severity-findings (1 at or above error) failed. To report a finding type without a failure, set its rule to "warn".',
      'error: "fallow" exited with code 1',
    ].join('\n');
    const report = renderReport([result('project', 'failed', output)], 1);
    expect(report).toContain('game/src/Orphan.ts');
    expect(report).not.toContain('To suppress');
    expect(report).not.toContain('set its rule to "warn"');
    expect(report).not.toContain('exited with code');
    expect(report).toContain('FAILED  project   1.2s  1 problem');
  });

  test('output past the limit is counted, with the command that shows all of it', () => {
    const findings = Array.from({ length: 75 }, (_, index) => `a.ts:${index + 1}:1: error eslint(no-var): no`);
    const report = renderReport([result('lint', 'failed', findings.join('\n'))], 1);
    expect(report).toContain('a.ts:60:1:');
    expect(report).not.toContain('a.ts:61:1:');
    expect(report).toContain('... 15 more lines. Fix these first, or run `bun run lint` to see all.');
    expect(report).toContain('75 problems');
  });

  test('a step that never finished says so', () => {
    const report = renderReport([result('test', 'timed out')], TIMEOUT_SECONDS);
    expect(report).toContain(`Stopped after ${TIMEOUT_SECONDS} seconds without finishing`);
    expect(report).toContain('run `bun test` on the files you changed, one at a time');
    expect(report).toContain('FAILED  test');
  });

  test('when the packages are not installed the other checks are not run, and the report says why', () => {
    const report = renderReport(
      [result('install', 'failed', 'error: lockfile had changes'), result('lint', 'not run')],
      1,
    );
    expect(report).toContain('skip    lint            not run');
    expect(report).toContain('FAILED: install.');
    expect(report).toContain('The other checks need the packages, so they were not run.');
  });
});
