/**
 * Runs the rules in `.archgate/adrs/` without the archgate CLI, so that `bun test` can hold
 * them to fixtures. The context offers the part of archgate's `RuleContext` the rules use,
 * with the same meaning: project-relative POSIX paths, globs that include dot folders and
 * come back sorted, `grep` line by line, findings whose severity is the report method's.
 *
 * The CLI stays the way to run the rules on the project (`bun run adrs`). This is only how
 * the rules themselves are tested; see `.archgate/README.md`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ADR_FOLDER = path.resolve(import.meta.dir, '../../.archgate/adrs');

export interface Finding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

interface Detail {
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

interface GrepMatch {
  file: string;
  line: number;
  column: number;
  content: string;
}

/** The members of archgate's `RuleContext` the rules in this project may use. */
export interface Context {
  projectRoot: string;
  scopedFiles: string[];
  changedFiles: string[];
  glob(pattern: string): Promise<string[]>;
  grep(file: string, pattern: RegExp): Promise<GrepMatch[]>;
  grepFiles(pattern: RegExp, fileGlob: string): Promise<GrepMatch[]>;
  readFile(file: string): Promise<string>;
  readJSON(file: string): Promise<unknown>;
  report: { violation(detail: Detail): void; warning(detail: Detail): void; info(detail: Detail): void };
}

interface Rule {
  description: string;
  check(ctx: Context): Promise<void>;
}

export interface Adr {
  id: string;
  title: string;
  /** The ADR file's name, without `.md`. */
  name: string;
  files: string[];
  rules: Record<string, Rule>;
  /** The companion `.rules.ts` as written. */
  source: string;
}

function frontmatter(text: string): Record<string, unknown> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!block) return {};
  const parsed: unknown = Bun.YAML.parse(block);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Every ADR that has rules, with its rules loaded, in file order. */
export async function loadAdrs(): Promise<Adr[]> {
  const adrs: Adr[] = [];
  for (const file of readdirSync(ADR_FOLDER).toSorted()) {
    if (!file.endsWith('.md')) continue;
    const meta = frontmatter(readFileSync(path.join(ADR_FOLDER, file), 'utf8'));
    if (meta.rules !== true) continue;
    const name = file.slice(0, -'.md'.length);
    const rulesFile = path.join(ADR_FOLDER, `${name}.rules.ts`);
    // A path the type-checker does not follow: the rules are typed by archgate's own
    // rules.d.ts, which `archgate check` writes and git ignores.
    const loaded = (await import(rulesFile)) as { default: { rules: Record<string, Rule> } };
    adrs.push({
      id: String(meta.id),
      title: String(meta.title),
      name,
      files: Array.isArray(meta.files) ? meta.files.map(String) : [],
      rules: loaded.default.rules,
      source: readFileSync(rulesFile, 'utf8'),
    });
  }
  return adrs;
}

/** Which of archgate's run modes to imitate. */
export interface RunOptions {
  /** `ctx.changedFiles`: what the branch changed. Empty means a full scan. */
  changed?: string[];
}

/** Runs one ADR's rules on a project folder, as `archgate check --adr <id>` would. */
export async function runAdr(adr: Adr, root: string, options: RunOptions = {}): Promise<Finding[]> {
  const glob = async (pattern: string) => {
    const seen = new Set<string>();
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, dot: true })) {
      if (!file.split('/').includes('node_modules')) seen.add(file.replaceAll('\\', '/'));
    }
    return [...seen].toSorted();
  };
  const readFile = (file: string) => Bun.file(path.join(root, file)).text();
  const grep = async (file: string, pattern: RegExp) => {
    const matches: GrepMatch[] = [];
    (await readFile(file)).split('\n').forEach((content, index) => {
      const found = new RegExp(pattern.source, pattern.flags).exec(content);
      if (found) matches.push({ file, line: index + 1, column: found.index + 1, content });
    });
    return matches;
  };
  const scoped = new Set<string>();
  for (const pattern of adr.files.length > 0 ? adr.files : ['**/*']) {
    for (const file of await glob(pattern)) scoped.add(file);
  }

  const findings: Finding[] = [];
  for (const [rule, config] of Object.entries(adr.rules)) {
    const record = (severity: Finding['severity']) => (detail: Detail) =>
      findings.push({ rule: `${adr.id}/${rule}`, severity, ...detail });
    const ctx: Context = {
      projectRoot: root,
      scopedFiles: [...scoped].toSorted(),
      changedFiles: options.changed ?? [],
      glob,
      grep,
      async grepFiles(pattern, fileGlob) {
        return (await Promise.all((await glob(fileGlob)).map((file) => grep(file, pattern)))).flat();
      },
      readFile,
      async readJSON(file) {
        return Bun.file(path.join(root, file)).json();
      },
      report: { violation: record('error'), warning: record('warning'), info: record('info') },
    };
    await config.check(ctx);
  }
  return findings;
}

/** A throwaway project holding `files` (path to content). Remove it with `dispose()`. */
export function fixture(files: Record<string, string>): { root: string; dispose(): void } {
  const root = mkdtempSync(path.join(tmpdir(), 'synergy-adr-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
