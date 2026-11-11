/**
 * `bun run check`: every automatic check, one verdict.
 *
 *   bun run check              all checks
 *   bun run check lint types   only the named ones
 *   bun run fix                apply what can be fixed automatically, then run all checks
 *
 * The checks themselves are ordinary package.json scripts (`bun run lint`, `bun test`, ...)
 * and can be run on their own. This file adds what a person or an agent wants around
 * them: they run at once, each failure is shown with what to do about it, long output is
 * cut to its first lines (the first error is the one to fix), and the last line says
 * whether the change is good. `docs/checks.md` describes each check.
 */

/** One check: a command that exits 0 when the code is fine. */
export interface Step {
  name: string;
  /** What the step checks, for the report. */
  checks: string;
  /** The command, run from the repository root. `bun` is replaced by the running Bun. */
  command: string[];
  /** What to do when it fails. Shown under the failure. */
  hint: string;
  /** A few words about the result ("404 pass"), read from the command's output. */
  detail?: (output: string) => string;
  /** How many lines of a failure to show. */
  lines?: number;
  /** Tidies the output for the report: its lines in, the lines to show out. */
  present?: (lines: string[]) => string[];
}

/** `file:line:column: ...`, as the linter prints a finding. */
const FINDING = /^(\S+?):(\d+):(\d+): /;

/** Findings in reading order (the linter prints them as its threads finish), other lines last. */
export function sortFindings(lines: readonly string[]): string[] {
  const key = (line: string): [string, number, number] | null => {
    const match = FINDING.exec(line);
    return match ? [match[1] ?? '', Number(match[2]), Number(match[3])] : null;
  };
  return lines.toSorted((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (!x || !y) return Number(!x) - Number(!y);
    return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2];
  });
}

/**
 * Lines that say nothing new (`bun run` repeating that a script failed), or that offer
 * the wrong way out (how to silence the finding instead of fixing it).
 */
const NOISE = [/^error: (script )?"[^"]+" exited with code \d+$/, /^\[X\] Exit code \d+: /, /^\s*To suppress: /];

/** "3 problems" for three matches of `pattern`, and nothing for none. */
function countOf(output: string, pattern: RegExp, word: string): string {
  const found = output.match(pattern)?.length ?? 0;
  return found > 0 ? plural(found, word) : '';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const STEPS: readonly Step[] = [
  {
    name: 'install',
    checks: 'node_modules matches bun.lock',
    command: ['bun', 'install', '--frozen-lockfile'],
    hint:
      'Run `bun install`. If that changes bun.lock, keep the change: package.json and the lockfile must agree.\n' +
      'Add a package with `bun add <name>` (or `bun add -d <name>`), not by editing package.json by hand.',
  },
  {
    name: 'format',
    checks: 'code layout (bun fmt)',
    command: ['bun', 'run', '--silent', 'format:check'],
    hint: 'Run `bun run fix`. It rewrites these files; formatting is never fixed by hand.',
    detail: (output) => output.match(/(\d+) files? needs? formatting/)?.[0] ?? '',
  },
  {
    name: 'lint',
    checks: 'mistakes in one file (oxlint)',
    command: ['bun', 'run', '--silent', 'lint', '-f', 'agent'],
    hint:
      'Run `bun run fix` for what can be fixed automatically, then fix the rest by hand, first one first.\n' +
      'Each line names its rule in brackets; docs/checks.md explains the synergy(...) rules with examples.\n' +
      'Change the code, not the rule: a disable comment needs a reason a reviewer would accept.',
    detail: (output) => countOf(output, /^\S+:\d+:\d+: error\b/gm, 'problem'),
    present: sortFindings,
  },
  {
    name: 'types',
    checks: 'types (bun check)',
    command: ['bun', 'run', '--silent', 'typecheck'],
    hint:
      'Fix the first error first; later ones often follow from it.\n' +
      'UseCamelCase<"update"> in a message means a Unity-cased method: rename Update() to update().\n' +
      'An operator on vectors (a + b) is not TypeScript: write a.add(b), v.mul(2). See docs/unity-to-synergy.md.',
    detail: (output) => countOf(output, /: error TS\d+/g, 'error'),
  },
  {
    name: 'test',
    checks: 'behaviour (bun test)',
    command: ['bun', 'test', '--only-failures'],
    hint:
      'Run one file while you work on it: `bun test path/to/file.test.ts` (add `-t "name"` for one test).\n' +
      'Fix the code, or the test if what it expects is no longer right. Never skip or delete a test to pass.\n' +
      'If an object or a reference is missing, print the scene: console.log(Debug.hierarchy()).',
    detail(output) {
      const pass = Number(output.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
      const fail = Number(output.match(/^\s*(\d+) fail$/m)?.[1] ?? 0);
      const errors = Number(output.match(/^\s*(\d+) errors?$/m)?.[1] ?? 0);
      const failed = [fail > 0 ? `${fail} fail` : '', errors > 0 ? plural(errors, 'error') : ''].filter(Boolean);
      return [...failed, `${pass} pass`].join(', ');
    },
    lines: 100,
  },
  {
    name: 'project',
    checks: 'the files together (fallow)',
    command: ['bun', 'run', '--silent', 'lint:project'],
    hint:
      'Unused file or export: import it where it belongs, write its test, or delete it.\n' +
      'Unlisted dependency: `bun add <name>` in the package that imports it, or stop importing it.\n' +
      'Circular dependency: if one side needs only a type, `import type` ends the cycle; otherwise move the shared part to a third file.\n' +
      'Boundary violation: that folder may not import the other. Change the import, not the rule (docs/checks.md has the map).',
    detail: (output) => {
      const found = [...output.matchAll(/\((\d+) at or above error\)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
      return found > 0 ? plural(found, 'problem') : '';
    },
  },
];

/** Commands that change files, run by `--fix` before the checks. Order matters: fixes can unformat. */
const FIXERS: readonly { name: string; command: string[] }[] = [
  { name: 'lint fixes', command: ['bun', 'run', '--silent', 'lint:fix', '-f', 'agent', '--quiet'] },
  { name: 'format', command: ['bun', 'run', '--silent', 'format'] },
];

/**
 * A step that hangs is a result too: a loop that never ends, usually. The limit is far
 * above what the checks take (seconds), and can be changed for a slow machine.
 */
export const TIMEOUT_SECONDS = Number(process.env.CHECK_TIMEOUT_SECONDS) || 180;

export interface Options {
  fix: boolean;
  help: boolean;
  /** Step names to run; empty means all. */
  only: string[];
  /** Arguments that are neither a flag nor a step name. */
  unknown: string[];
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { fix: false, help: false, only: [], unknown: [] };
  const names = new Set(STEPS.map((step) => step.name));
  for (const argument of argv) {
    if (argument === '--fix') options.fix = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (names.has(argument)) options.only.push(argument);
    else options.unknown.push(argument);
  }
  return options;
}

export interface StepResult {
  step: Step;
  status: 'passed' | 'failed' | 'timed out' | 'not run';
  seconds: number;
  /** Everything the command printed, without colour codes. */
  output: string;
}

/** Keeps the first `limit` lines and says how many were left out. */
export function clip(output: string, limit: number): { text: string; hidden: number } {
  const lines = output.trimEnd().split('\n');
  if (lines.length <= limit) return { text: lines.join('\n'), hidden: 0 };
  return { text: lines.slice(0, limit).join('\n'), hidden: lines.length - limit };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** How a step is run by hand, for messages: `bun run lint`, not the full command line. */
function shortCommand(step: Step): string {
  const [, verb, ...rest] = step.command;
  if (verb === 'run') return `bun run ${rest.find((part) => !part.startsWith('-')) ?? ''}`;
  return `bun ${verb}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

/** The report: each failure with its output and what to do, then one line per step, then the verdict. */
export function renderReport(results: readonly StepResult[], seconds: number): string {
  const parts: string[] = [];
  const failures = results.filter((result) => result.status === 'failed' || result.status === 'timed out');

  for (const result of failures) {
    const { step } = result;
    const lines = result.output.split('\n').filter((line) => !NOISE.some((noise) => noise.test(line)));
    const { text, hidden } = clip((step.present?.(lines) ?? lines).join('\n'), step.lines ?? 60);
    parts.push(`---- ${step.name} FAILED: ${step.checks} ----`);
    if (result.status === 'timed out') {
      parts.push(
        indent(
          `Stopped after ${TIMEOUT_SECONDS} seconds without finishing. Something loops forever: ` +
            'a `while (true)` with no `yield` in a coroutine, or a test waiting on a promise that never settles.\n' +
            `To find it, run \`${shortCommand(step)}\` on the files you changed, one at a time: the one that never finishes has it.`,
        ),
      );
    }
    if (text) parts.push(indent(text));
    if (hidden > 0) {
      parts.push(
        indent(`... ${plural(hidden, 'more line')}. Fix these first, or run \`${shortCommand(step)}\` to see all.`),
      );
    }
    parts.push(`${indent(`What to do:\n${indent(step.hint)}`)}\n`);
  }

  const width = Math.max(...results.map((result) => result.step.name.length));
  for (const result of results) {
    const mark = result.status === 'passed' ? 'ok    ' : result.status === 'not run' ? 'skip  ' : 'FAILED';
    const detail = result.status === 'not run' ? 'not run' : (result.step.detail?.(result.output) ?? '');
    const time = result.status === 'not run' ? '' : `${result.seconds.toFixed(1)}s`;
    parts.push(`${mark}  ${result.step.name.padEnd(width)}  ${time.padStart(5)}  ${detail}`.trimEnd());
  }

  const skipped = results.filter((result) => result.status === 'not run');
  if (failures.length === 0 && skipped.length === 0) {
    parts.push(`\nPASSED: ${plural(results.length, 'check')} in ${seconds.toFixed(1)}s.`);
  } else {
    const names = failures.map((result) => result.step.name).join(', ');
    const first = failures[0]?.step.name;
    const then = first === 'install' ? 'The other checks need the packages, so they were not run.' : '';
    parts.push(
      `\nFAILED: ${names}. Fix what is listed above, top first, then run \`bun run check\` again.` +
        (then ? ` ${then}` : '') +
        (failures.some((result) => result.step.name === 'format' || result.step.name === 'lint')
          ? ' `bun run fix` does the automatic part.'
          : ''),
    );
  }
  return parts.join('\n');
}

async function run(command: readonly string[], cwd: string): Promise<{ code: number | 'timeout'; output: string }> {
  // The tools print for whoever is watching. Here nobody is, so they are told to print
  // plainly, and the same on every machine: no colour, no agent-specific formats.
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const name of ['AGENT', 'CLAUDECODE', 'REPL_ID']) delete env[name];

  const [program, ...rest] = command;
  const child = Bun.spawn([program === 'bun' ? process.execPath : (program ?? ''), ...rest], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(); // asks first, so a tool can stop what it started
    setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  }, TIMEOUT_SECONDS * 1000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  const output = [stdout, stderr]
    .map((text) => text.replace(ANSI, '').trim())
    .filter(Boolean)
    .join('\n');
  return { code: timedOut ? 'timeout' : code, output };
}

async function runStep(step: Step, cwd: string): Promise<StepResult> {
  const started = performance.now();
  const { code, output } = await run(step.command, cwd);
  const status = code === 'timeout' ? 'timed out' : code === 0 ? 'passed' : 'failed';
  return { step, status, seconds: (performance.now() - started) / 1000, output };
}

const HELP = `Usage: bun run check [--fix] [${STEPS.map((step) => step.name).join('] [')}]

Runs every automatic check and ends with PASSED or FAILED (exit code 0 or 1).
Name one or more checks to run only those. --fix (or \`bun run fix\`) first applies
what can be fixed automatically: lint fixes, then formatting.

${STEPS.map((step) => `  ${step.name.padEnd(8)} ${step.checks}`).join('\n')}

docs/checks.md describes each check and what its messages mean.`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.unknown.length > 0) {
    console.error(`Unknown argument: ${options.unknown.join(' ')}\n\n${HELP}`);
    return 2;
  }

  const cwd = new URL('..', import.meta.url).pathname;
  const started = performance.now();
  const steps = options.only.length > 0 ? STEPS.filter((step) => options.only.includes(step.name)) : [...STEPS];

  // Without the packages nothing else can run, and their errors would bury this one.
  const install = steps.find((step) => step.name === 'install');
  const rest = steps.filter((step) => step !== install);
  const results: StepResult[] = [];
  if (install) results.push(await runStep(install, cwd));
  const blocked = results.some((result) => result.status !== 'passed');

  if (options.fix && !blocked) {
    for (const fixer of FIXERS) {
      const { output } = await run(fixer.command, cwd);
      // The formatter names the files it rewrote; the linter's leftovers come back in the check below.
      const rewritten = output.split('\n').filter((line) => line && !/^(Formatted|All) /.test(line));
      if (fixer.name === 'format' && rewritten.length > 0) console.log(`Formatted:\n${indent(rewritten.join('\n'))}\n`);
    }
  }

  if (blocked) {
    results.push(...rest.map((step): StepResult => ({ step, status: 'not run', seconds: 0, output: '' })));
  } else {
    results.push(...(await Promise.all(rest.map((step) => runStep(step, cwd)))));
  }

  console.log(renderReport(results, (performance.now() - started) / 1000));
  return results.every((result) => result.status === 'passed') ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
