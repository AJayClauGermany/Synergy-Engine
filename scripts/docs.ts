/**
 * `bun run docs:check` (part of `bun run check`): holds the documentation to the code.
 *
 * People and agents copy what the guides show, so a guide that has drifted from the
 * engine sends them the wrong way with full confidence. This reads every Markdown file
 * in the repository and checks what a program can:
 *
 *   - Each ```ts / ```tsx block is compiled against the real packages. A block may be a
 *     whole module, the members of a script, or statements from inside a method; names
 *     the block leaves out (`unit`, `select`) are let through, everything it says about
 *     the engine is checked.
 *   - `bun run <script>` names a script that package.json has.
 *   - A path into the repository (`game/test/scene.test.ts`) exists.
 *   - A skill has the shape `docs/agent-skills.md` describes.
 *
 * `docs/checks.md` ("Documentation") says how to write a block so that it is checked.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

export interface Finding {
  file: string;
  line: number;
  message: string;
}

// ---- Code blocks ------------------------------------------------------------------------

export interface Block {
  file: string;
  /** Line of the opening fence, 1-based. The code starts on the next line. */
  line: number;
  lang: 'ts' | 'tsx';
  code: string;
  /** Opened with ```ts sketch: shown for its shape, not compiled. */
  sketch: boolean;
  /** What the file says its bare names are: `<!-- check: manager: NetworkManager -->`. */
  names: Readonly<Record<string, string>>;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)(.*)$/;
const HINT = /<!--\s*check:\s*([\s\S]*?)\s*-->/g;

/**
 * The names a file declares for its fragments, in a comment anywhere in it:
 * `<!-- check: manager: NetworkManager; session: CommandSession<Command> -->`.
 */
export function fileHints(text: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const match of text.matchAll(HINT)) {
    for (const part of (match[1] ?? '').split(';')) {
      const hint = /^\s*([\w$]+)\s*:\s*(.+?)\s*$/.exec(part);
      if (hint?.[1] && hint[2]) names[hint[1]] = hint[2];
    }
  }
  return names;
}

/** The TypeScript blocks of one Markdown file. */
export function extractBlocks(file: string, text: string): Block[] {
  const blocks: Block[] = [];
  const names = fileHints(text);
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE.exec(lines[index] ?? '');
    if (!open) continue;
    const [, fence = '', language = '', info = ''] = open;
    const indent = (lines[index] ?? '').length - (lines[index] ?? '').trimStart().length;
    const start = index;
    const body: string[] = [];
    for (index++; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') break;
      // A block inside a list item is indented with it; the code is not.
      body.push(line.slice(Math.min(indent, line.length - line.trimStart().length)));
    }
    if (language !== 'ts' && language !== 'tsx' && language !== 'typescript') continue;
    blocks.push({
      file,
      line: start + 1,
      lang: language === 'tsx' ? 'tsx' : 'ts',
      code: body.join('\n'),
      sketch: /\bsketch\b/.test(info),
      names,
    });
  }
  return blocks;
}

const MEMBER = /`([A-Za-z_$][\w$]*)\.([a-z_$][\w$]*)[^`]*`/g;

/** The helper a member check calls: `key` must be a member of `owner` or of its instances. */
const HAS =
  'declare function __has<T, K extends keyof T | (T extends { prototype: infer P } ? keyof P : never)>(owner: T, key: K): void;';

/**
 * `Tween.move(...)` or `tilemap.setTile` written in a sentence is a claim that the member
 * exists. Each becomes a one-line block that asks the compiler. Only names the checker
 * knows are asked about (an export, or a bare name with a known type), and only members in
 * camelCase: `Physics.Raycast` is Unity's spelling, quoted on purpose.
 */
export function extractMembers(file: string, text: string, known: ReadonlyMap<string, Export>): Block[] {
  const blocks: Block[] = [];
  const names = fileHints(text);
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    const checks: string[] = [];
    for (const match of line.matchAll(MEMBER)) {
      const [, owner = '', member = ''] = match;
      const type = names[owner] ?? WELL_KNOWN[owner];
      if (type) checks.push(`__has(null as unknown as ${type}, '${member}');`);
      else if (known.get(owner)?.isType === false && /^[A-Z]/.test(owner)) checks.push(`__has(${owner}, '${member}');`);
    }
    // One line of code for one line of prose, so an error lands on the sentence.
    if (checks.length > 0) blocks.push({ file, line: index, lang: 'ts', code: checks.join(' '), sketch: false, names });
  });
  return blocks;
}

/** How a block is turned into a file that compiles: as it is, or inside a script. */
export type Shape = 'module' | 'members' | 'body';

const HEADER: Record<Shape, string> = {
  module: '',
  members: 'class __Snippet extends __Base {',
  body: 'class __Snippet extends __Base { async *__run() {',
};
const FOOTER: Record<Shape, string> = { module: '', members: '}', body: '}}' };

interface SyntaxError {
  message: string;
  line: number;
}

function syntaxErrors(code: string, lang: 'ts' | 'tsx'): SyntaxError[] {
  try {
    new Bun.Transpiler({ loader: lang }).transformSync(code);
    return [];
  } catch (error) {
    const list = error instanceof AggregateError ? (error.errors as unknown[]) : [error];
    return (
      list
        .map((item) => {
          const { message, position } = item as { message?: unknown; position?: { line?: unknown } | null };
          return { message: String(message), line: typeof position?.line === 'number' ? position.line : 1 };
        })
        // Two `const palette = ...` lines show two ways to do one thing. That is a habit of
        // documentation, not a mistake in it.
        .filter((item) => !/has already been declared/.test(item.message))
    );
  }
}

/**
 * Which shape the block has: the first that parses. A block that uses `this` and declares
 * no class is taken to be inside a script, since `this` means nothing at the top of a file.
 */
export function shapeOf(code: string, lang: 'ts' | 'tsx'): Shape | SyntaxError {
  const insideScript = /\bthis\s*[.[]/.test(code) && !/\bclass\s/.test(code);
  const shapes: Shape[] = insideScript ? ['members', 'body'] : ['module', 'members', 'body'];
  let first: SyntaxError | null = null;
  for (const shape of shapes) {
    const errors = syntaxErrors(`${HEADER[shape]}\n${code}\n${FOOTER[shape]}`, lang);
    if (errors.length === 0) return shape;
    // Report the error of the plainest reading; line 1 is the header.
    first ??= errors.map((item) => ({ ...item, line: item.line - 1 })).find((item) => item.line >= 1) ?? null;
  }
  return first ?? { message: 'This is not TypeScript.', line: 1 };
}

// ---- What the packages export -------------------------------------------------------------

/** Entry points a block may use without importing, first match wins. */
const ENTRY_POINTS: readonly (readonly [specifier: string, file: string])[] = [
  ['@synergy/engine', 'packages/engine/src/index.ts'],
  ['@synergy/engine/math', 'packages/engine/src/math/index.ts'],
  ['@synergy/engine/grid', 'packages/engine/src/grid/index.ts'],
  ['@synergy/engine/data', 'packages/engine/src/data/index.ts'],
  ['@synergy/netcode', 'packages/netcode/src/index.ts'],
  ['@synergy/netcode/testing', 'packages/netcode/src/testing.ts'],
  ['@synergy/netcode/lobby', 'packages/netcode/src/lobby.ts'],
  ['@synergy/net', 'packages/net/src/index.ts'],
  ['@synergy/net/peerjs', 'packages/net/src/PeerJsTransport.ts'],
  ['@synergy/net/convex', 'packages/net/src/ConvexLobby.ts'],
  ['@synergy/ui', 'packages/ui/src/index.ts'],
];

/** Names from outside the repository that guides use bare. */
const EXTERNAL: readonly (readonly [specifier: string, values: string, types: string])[] = [
  ['bun:test', 'test expect describe beforeEach afterEach beforeAll afterAll mock spyOn', ''],
  ['preact/hooks', 'useState useEffect useRef useMemo useCallback useLayoutEffect', ''],
  ['preact', 'render', 'ComponentChildren CSSProperties'],
];

interface Export {
  specifier: string;
  isType: boolean;
}

function resolveModule(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((file) => existsSync(file)) ?? null;
}

/** Every name a source file exports, and whether it is only a type. Follows `export ... from`. */
export function exportsOfFile(file: string, seen = new Set<string>()): Map<string, boolean> {
  const names = new Map<string, boolean>();
  if (seen.has(file)) return names;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const add = (name: string, isType: boolean) => names.set(name, (names.get(name) ?? true) && isType);

  for (const match of source.matchAll(/^export \* from '([^']+)'/gm)) {
    const target = resolveModule(file, match[1] ?? '');
    if (target) for (const [name, isType] of exportsOfFile(target, seen)) add(name, isType);
  }
  for (const match of source.matchAll(/^export (type )?\{([^}]*)\}/gm)) {
    for (const part of (match[2] ?? '').split(',')) {
      const item = /^\s*(type\s+)?[\w$]+(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      const plain = /^\s*(?:type\s+)?([\w$]+)/.exec(part);
      const name = item?.[2] ?? plain?.[1];
      if (name) add(name, Boolean(match[1] ?? item?.[1]));
    }
  }
  const declaration =
    /^export (?:declare )?(?:abstract )?(?:async )?(class|function\*?|const|let|enum|interface|type|namespace) ([\w$]+)/gm;
  for (const match of source.matchAll(declaration)) {
    add(match[2] ?? '', match[1] === 'interface' || match[1] === 'type');
  }
  return names;
}

/** Name to where it is imported from, over every entry point. */
export function knownExports(root = ROOT): Map<string, Export> {
  const known = new Map<string, Export>();
  for (const [specifier, file] of ENTRY_POINTS) {
    for (const [name, isType] of exportsOfFile(path.join(root, file))) {
      if (!known.has(name)) known.set(name, { specifier, isType });
    }
  }
  for (const [specifier, values, types] of EXTERNAL) {
    for (const name of values.split(' ').filter(Boolean)) known.set(name, { specifier, isType: false });
    for (const name of types.split(' ').filter(Boolean)) known.set(name, { specifier, isType: true });
  }
  return known;
}

// ---- Turning a block into a file ----------------------------------------------------------

const NETWORKED =
  /\b(NetworkBehaviour|NetworkVariable|NetworkList|serverRpc|clientRpc|onNetworkSpawn|onNetworkDespawn|networkObject|networkManager|isOwner|isServer|isHost|ownerClientId)\b/i;

/** Names a block declares itself, which must not be imported over. */
function declaredNames(code: string): Set<string> {
  const names = new Set<string>();
  const add = (list: string) => {
    for (const part of list.split(',')) {
      const name = /([\w$]+)\s*(?:=[^,]*)?$/.exec(part.replace(/:\s*[^,]+$/, '').trim())?.[1];
      if (name) names.add(name);
    }
  };
  for (const match of code.matchAll(/\b(?:class|interface|type|enum|function\*?|const|let|var)\s+([\w$]+)/g)) {
    names.add(match[1] ?? '');
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g)) add(match[1] ?? '');
  for (const match of code.matchAll(/\bimport\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (match[1]) names.add(match[1]);
    for (const part of (match[2] ?? '').split(',')) {
      const name = /([\w$]+)\s*$/.exec(part.trim())?.[1];
      if (name) names.add(name);
    }
  }
  for (const match of code.matchAll(/\bimport\s+\*\s+as\s+([\w$]+)/g)) names.add(match[1] ?? '');
  return names;
}

/** The module specifiers a block imports from. */
function importedFrom(code: string): Set<string> {
  return new Set([...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? ''));
}

export interface Snippet {
  block: Block;
  shape: Shape;
  /** The file to compile. Line 1 is added; line n of the block is line n + 1 here. */
  source: string;
}

/**
 * What a bare name means in a fragment that does not declare it. `tilemap.setTile(...)`
 * in a guide is then checked against `Tilemap`, not waved through. Any other undeclared
 * name (`unit`, `select`, `Command`) is the reader's own and is not checked.
 */
export const WELL_KNOWN: Readonly<Record<string, string>> = {
  engine: 'Engine',
  gameObject: 'GameObject',
  transform: 'Transform',
  grid: 'Grid',
  tilemap: 'Tilemap',
  networkManager: 'NetworkManager',
  networkObject: 'NetworkObject',
};

const ANY = 'any';

/** `declare let unit: any; type unit<...> = any;`: a name the block uses and its surroundings would supply. */
function assume(name: string, type: string): string {
  return type === ANY
    ? `declare let ${name}: any; type ${name}<_A = any, _B = any, _C = any> = any;`
    : `declare let ${name}: ${type};`;
}

const RELATIVE_IMPORT = /^import\s+(?:type\s+)?(.+?)\s+from\s+['"]\.{1,2}\/[^'"]*['"].*$/gm;

/** Names bound by the clause of an import: `A, { b, c as d }` or `* as e`. */
function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  for (const part of (braces?.[1] ?? '').split(',')) {
    const name = /([\w$]+)\s*$/.exec(part.trim())?.[1];
    if (name) names.push(name);
  }
  const rest = clause.replace(/\{[^}]*\}/, '');
  const namespace = /\*\s+as\s+([\w$]+)/.exec(rest)?.[1];
  const byDefault = /^\s*([\w$]+)/.exec(rest)?.[1];
  for (const name of [namespace, namespace ? undefined : byDefault]) if (name) names.push(name);
  return names;
}

/**
 * The block as a file: on the first line the imports it left out, the names its
 * surroundings would supply (`assumed`) and, for a fragment, the script it sits in; then
 * the block, so line numbers carry over. An import of one of the reader's own files
 * (`'../src/behaviours/Mover'`) becomes a declaration of its names on the same line.
 */
export function toSnippet(
  block: Block,
  shape: Shape,
  known: ReadonlyMap<string, Export>,
  assumed: ReadonlyMap<string, string> = new Map(),
): Snippet {
  const code = block.code.replace(RELATIVE_IMPORT, (_line, clause: string) =>
    importedNames(clause)
      .map((name) => assume(name, ANY))
      .join(' '),
  );
  const declared = declaredNames(code);
  const explicit = importedFrom(code);
  const bySpecifier = new Map<string, string[]>();
  const need = (name: string) => {
    const source = known.get(name);
    // A block that imports from a package says what it needs from it: nothing is added,
    // and a name it forgot is reported.
    if (!source || declared.has(name) || explicit.has(source.specifier)) return;
    const list = bySpecifier.get(source.specifier) ?? [];
    const entry = source.isType ? `type ${name}` : name;
    if (!list.includes(entry)) list.push(entry);
    bySpecifier.set(source.specifier, list);
  };
  for (const match of code.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) need(match[0]);
  for (const type of assumed.values()) {
    if (type !== ANY) for (const match of type.matchAll(/[A-Za-z_$][\w$]*/g)) need(match[0]);
  }

  const header = [...bySpecifier].map(([specifier, names]) => `import { ${names.join(', ')} } from '${specifier}';`);
  if (code.includes('__has(')) header.push(HAS);
  for (const [name, type] of assumed) if (!declared.has(name)) header.push(assume(name, type));
  if (shape !== 'module') {
    header.push(
      NETWORKED.test(code)
        ? "import { NetworkBehaviour as __Base } from '@synergy/netcode';"
        : "import { MonoBehaviour as __Base } from '@synergy/engine';",
      HEADER[shape],
    );
  }
  return { block, shape, source: `${header.join(' ')}\n${code}\n${FOOTER[shape]}\n` };
}

// ---- Compiling --------------------------------------------------------------------------

/**
 * Where the blocks are written to be compiled: under `game/`, so `@synergy/*` and `preact`
 * resolve as they do for game code, and inside node_modules, so no other tool reads them.
 * Each run has a folder of its own: `bun run check` runs this at the same time as the
 * tests, which compile blocks too.
 */
const WORK_ROOT = 'game/node_modules/.cache/synergy-docs';
let runs = 0;

interface Diagnostic {
  file: string;
  line: number;
  code: number;
  message: string;
}

/** `file(line,col): error TS2339: message`, as the type checker prints without colour. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = /^(.+?)\((\d+),\d+\): error TS(\d+): (.*)$/.exec(line);
    if (match)
      found.push({ file: match[1] ?? '', line: Number(match[2]), code: Number(match[3]), message: match[4] ?? '' });
  }
  return found;
}

/** The name a "cannot find name" error is about, or null for any other error. */
function missingName(diagnostic: Diagnostic): string | null {
  // 2304/2552/2663: Cannot find name 'x'. 18004: no value in scope for the shorthand property 'x'.
  if (![2304, 2552, 2663, 18004].includes(diagnostic.code)) return null;
  return /'([^']+)'/.exec(diagnostic.message)?.[1] ?? null;
}

/** One letter added, dropped or changed, or only the capitals differ: a typo, not another word. */
function isNearMiss(written: string, real: string): boolean {
  if (written.toLowerCase() === real.toLowerCase()) return true;
  if (Math.abs(written.length - real.length) > 1) return false;
  let start = 0;
  while (start < written.length && written[start] === real[start]) start++;
  let end = 0;
  while (end < written.length - start && end < real.length - start && written.at(-1 - end) === real.at(-1 - end)) end++;
  return Math.max(written.length, real.length) - start - end <= 1;
}

/**
 * Whether a compiler error is about the block being a fragment rather than about what it
 * says. `loose` is true for a block with names of its own that nothing declares: what is
 * built from those (`addComponent(Mover).target`, a callback handed to `session`) cannot
 * be judged either.
 */
export function isFragmentNoise(diagnostic: Diagnostic, loose: boolean): boolean {
  const { code, message } = diagnostic;
  // Property 'board' does not exist on the script the fragment was put in: the reader's own
  // field. A near miss of a real member is not: "'serverRPC' ... Did you mean 'serverRpc'?"
  if (code === 2339 || code === 2551) {
    const onScript = /on type '(__Snippet|this)'/.test(message);
    const names = /^Property '([^']+)' .* Did you mean '([^']+)'\?$/.exec(message);
    if (onScript && names) return !isNearMiss(names[1] ?? '', names[2] ?? '');
    // What a generic call makes of an unknown argument: `addComponent(Mover)`, `useObservable(hud)`.
    return onScript || (loose && /on type '(Component|unknown)'/.test(message));
  }
  if (code === 18046) return loose;
  // A parameter with no type, in a callback given to something unknown; type arguments on a call to it.
  if (code === 7006 || code === 7031 || code === 7005 || code === 7034 || code === 2347) return loose;
  // The same name declared twice: alternatives shown side by side.
  if (code === 2451 || code === 2300 || code === 2393) return true;
  // A relative import: the file belongs to the reader's game, not to this repository.
  if (code === 2307) return /'\.{1,2}\//.test(message);
  return false;
}

function describe(diagnostic: Diagnostic, known: ReadonlyMap<string, Export>): string {
  const name = missingName(diagnostic);
  const source = name ? known.get(name) : undefined;
  if (name && source) {
    return `\`${name}\` is used but not imported. This block imports from '${source.specifier}', so add it to that import.`;
  }
  // The one-line check behind a member named in a sentence (see extractMembers).
  const member = /^Argument of type '"([\w$]+)"' is not assignable to parameter of type '(.+)'\.$/.exec(
    diagnostic.message,
  );
  if (diagnostic.code === 2345 && member) {
    return `This line names \`.${member[1]}\`, and there is no such member (${member[2]}). Use the name the code has, or fix the code.`;
  }
  return `${diagnostic.message} (TS${diagnostic.code})`;
}

/** Writes the snippets out and type-checks them together. Returns each snippet's errors. */
async function compile(snippets: readonly Snippet[], root: string): Promise<Diagnostic[][]> {
  const workDir = path.join(root, WORK_ROOT, `${process.pid}-${runs++}`);
  mkdirSync(workDir, { recursive: true });
  const names = snippets.map((snippet, index) => `${String(index).padStart(3, '0')}.${snippet.block.lang}`);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    snippets.forEach((snippet, index) => writeFileSync(path.join(workDir, names[index] ?? ''), snippet.source));
    writeFileSync(
      path.join(workDir, 'tsconfig.json'),
      JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.ts', '*.tsx'], exclude: [] }),
    );
    const child = Bun.spawn([process.execPath, 'check', '--no-script', '--no-pretty', '--all', '-p', workDir], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const diagnostics = parseDiagnostics(`${stdout}\n${stderr}`);
  // A failure with nothing to show would otherwise read as "every block is fine".
  if (exitCode !== 0 && diagnostics.length === 0) {
    throw new Error(`The type checker failed without reporting an error:\n${stdout}\n${stderr}`);
  }
  const perSnippet: Diagnostic[][] = snippets.map(() => []);
  for (const diagnostic of diagnostics) {
    // An error in the packages themselves is the `types` check's to report, not this one's.
    perSnippet[names.indexOf(path.basename(diagnostic.file))]?.push(diagnostic);
  }
  return perSnippet;
}

/** Compiles the blocks and returns what is wrong with them, in the Markdown's own line numbers. */
export async function checkBlocks(blocks: readonly Block[], root = ROOT): Promise<Finding[]> {
  const findings: Finding[] = [];
  const known = knownExports(root);
  const drafts: { block: Block; shape: Shape; assumed: Map<string, string> }[] = [];
  for (const block of blocks) {
    if (block.sketch) continue;
    const shape = shapeOf(block.code, block.lang);
    if (typeof shape === 'string') {
      drafts.push({ block, shape, assumed: new Map() });
    } else {
      findings.push({
        file: block.file,
        line: block.line + shape.line,
        message: `${shape.message}: this block does not parse as a module, as the members of a class, or as statements. Make it real code, or open it with \`\`\`ts sketch if it only shows a shape.`,
      });
    }
  }
  if (drafts.length === 0) return findings;

  // The first pass finds the names each fragment leaves to its surroundings; they are
  // declared and the blocks compiled again, until a pass has nothing new to declare.
  let results: Diagnostic[][] = [];
  for (let pass = 0; pass < 4; pass++) {
    results = await compile(
      drafts.map((draft) => toSnippet(draft.block, draft.shape, known, draft.assumed)),
      root,
    );
    let changed = false;
    drafts.forEach((draft, index) => {
      for (const diagnostic of results[index] ?? []) {
        const name = missingName(diagnostic);
        if (name && !known.has(name) && !draft.assumed.has(name)) {
          draft.assumed.set(name, draft.block.names[name] ?? WELL_KNOWN[name] ?? ANY);
          changed = true;
        }
        // `return` at the top of a block: it is the inside of a function.
        if (diagnostic.code === 1108 && draft.shape === 'module') {
          draft.shape = 'body';
          changed = true;
        }
      }
    });
    if (!changed) break;
  }

  drafts.forEach((draft, index) => {
    const loose =
      [...draft.assumed.values()].includes(ANY) || new RegExp(RELATIVE_IMPORT.source, 'm').test(draft.block.code);
    for (const diagnostic of results[index] ?? []) {
      if (isFragmentNoise(diagnostic, loose)) continue;
      findings.push({
        file: draft.block.file,
        line: draft.block.line + Math.max(diagnostic.line - 1, 0),
        message: describe(diagnostic, known),
      });
    }
  });
  return findings;
}

// ---- Commands and paths -------------------------------------------------------------------

/** `bun run <name>` must name a script. Checked in code blocks and in `inline code`. */
export function checkScripts(file: string, text: string, scripts: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\bbun run (?:--[\w-]+ )*([\w:./-]+)/g)) {
      const name = match[1] ?? '';
      // `bun run scripts/build.ts` runs a file, which the path check covers.
      if (name.includes('/') || /\.(ts|tsx|js)$/.test(name) || scripts.has(name)) continue;
      findings.push({
        file,
        line: index + 1,
        message: `\`bun run ${name}\`: package.json has no script named "${name}". Its scripts: ${[...scripts].join(', ')}.`,
      });
    }
  });
  return findings;
}

/** Top-level folders a guide points into. A path starting with one of them is a claim that the file exists. */
const REPOSITORY_FOLDERS = [
  'game',
  'packages',
  'scripts',
  'docs',
  'tools',
  'cloudflare',
  'convex',
  'desktop',
  '.claude',
  '.github',
  '.githooks',
];

/**
 * Paths that stand for a file the reader will create, or that a command creates. Add a
 * name here only when the guide really means "a file like this", never to quiet a path
 * that has moved.
 */
export const EXAMPLE_PATHS: readonly RegExp[] = [
  /\/(Thing|Mover|Unit|Health|Patroller|Enemy|Turret|File)\.tsx?$/,
  /\/(mover|unit|thing|file)\.test\.ts$/,
  /^path\/to\//,
  /(^|\/)(dist|node_modules|\.screenshots|_generated)(\/|$)/,
  /\/\.env(\.local)?$|\.dev\.vars$/,
  /[*<>{}$]|\.\.\./,
];

const FILE_NAME = /\.(ts|tsx|js|json|jsonc|md|yml|yaml|toml|cs|html|css|png|schema)$/;
const PATH_IN_CODE = /`([^`\s]+)`/g;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Backticked repository paths and relative Markdown links must lead somewhere. */
export function checkPaths(file: string, text: string, exists: (relative: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  const folder = path.dirname(file);
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const match of line.matchAll(PATH_IN_CODE)) {
      const raw = (match[1] ?? '').replace(/[.,;:]+$/, '');
      const target = raw.replace(/:\d+(:\d+)?$/, '').replace(/\/$/, '');
      const top = target.split('/')[0] ?? '';
      // Only files: a folder may be one the reader makes, and `convex/values` is a package.
      if (!target.includes('/') || !REPOSITORY_FOLDERS.includes(top) || !FILE_NAME.test(target)) continue;
      if (EXAMPLE_PATHS.some((pattern) => pattern.test(target)) || exists(target)) continue;
      findings.push({
        file,
        line: index + 1,
        message: `\`${raw}\` does not exist. Point at the file that does; if it stands for a file the reader creates, use one of the example names (EXAMPLE_PATHS in scripts/docs.ts).`,
      });
    }
    for (const match of line.matchAll(LINK)) {
      const href = (match[1] ?? '').split('#')[0] ?? '';
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      const target = path.normalize(path.join(folder, href));
      if (!exists(target)) findings.push({ file, line: index + 1, message: `The link to ${href} leads nowhere.` });
    }
  });
  return findings;
}

// ---- Skills -----------------------------------------------------------------------------

const SKILL_FILE = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;
/** A skill is read whole each time it is used; past this it should move detail into a file it links. */
const SKILL_MAX_LINES = 400;

/**
 * The shape every skill has (`docs/agent-skills.md`, "Writing a skill"): a description
 * that says when to use it and what belongs to a neighbour, a Gotchas section, a last
 * step that checks the work, and an entry in the two lists people look in.
 */
export function checkSkill(
  file: string,
  text: string,
  context: { skills: ReadonlySet<string>; agentsGuide: string; skillsGuide: string },
): Finding[] {
  const name = SKILL_FILE.exec(file)?.[1];
  if (!name) return [];
  const findings: Finding[] = [];
  const report = (line: number, message: string) => findings.push({ file, line, message });
  const lines = text.split('\n');

  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) {
    report(1, 'A skill starts with front matter: `---`, `name:`, `description:`, `---`.');
    return findings;
  }
  const front = lines.slice(1, end).join('\n');
  const declared = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (declared !== name) report(2, `\`name: ${declared ?? ''}\` must match the folder, "${name}".`);
  const description = (/^description:\s*([\s\S]*?)(?=^\w+:|(?![\s\S]))/m.exec(front)?.[1] ?? '')
    .replace(/^[>|]-?\s*$/m, '')
    .replace(/\s+/g, ' ')
    .trim();
  const at = 1 + lines.findIndex((line) => line.startsWith('description:'));
  if (description.length < 80 || description.length > 1024) {
    report(at, `The description is ${description.length} characters; it is what a skill is chosen by, so 80 to 1024.`);
  }
  if (!/\bUse (it )?when\b/i.test(description)) {
    report(at, 'The description says when to use the skill: include "Use when ...".');
  }
  const others = [...context.skills].filter((skill) => skill !== name);
  if (others.length > 0 && !/\bNot for\b/.test(description)) {
    report(
      at,
      'The description ends with "Not for ... (use `other-skill`)", naming the neighbouring skill that owns the nearby work.',
    );
  }
  for (const match of description.matchAll(/`([a-z][a-z0-9-]+)`/g)) {
    if (!context.skills.has(match[1] ?? ''))
      report(at, `The description names \`${match[1]}\`, which is not a skill here.`);
  }

  if (!lines.some((line) => line === '## Gotchas')) {
    report(end + 1, 'A skill has a `## Gotchas` section (that exact heading): symptom, cause, what to do.');
  }
  const headings = lines.filter((line) => line.startsWith('## '));
  const last = headings.at(-1) ?? '';
  if (!/^## (Verify|Check|Finish|Report)/.test(last)) {
    report(
      lines.length,
      `The last section tells the reader how to check the work and is headed "## Verify" (or Check, Finish, Report); this one ends with "${last}".`,
    );
  }
  if (lines.length > SKILL_MAX_LINES) {
    report(
      SKILL_MAX_LINES,
      `${lines.length} lines: a skill is read whole each time, so keep it under ${SKILL_MAX_LINES} and move detail to a doc it links.`,
    );
  }
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/`([a-z][a-z0-9-]+)` skill\b|\bskill `([a-z][a-z0-9-]+)`/g)) {
      const other = match[1] ?? match[2] ?? '';
      if (!context.skills.has(other))
        report(index + 1, `\`${other}\` is not a skill here. The skills: ${[...context.skills].join(', ')}.`);
    }
  });
  if (!context.agentsGuide.includes(`\`${name}\``)) report(1, `AGENTS.md ("Skills") does not list \`${name}\`.`);
  if (!context.skillsGuide.includes(`\`${name}\``)) report(1, `docs/agent-skills.md does not list \`${name}\`.`);
  return findings;
}

// ---- Running it ---------------------------------------------------------------------------

/** Every Markdown file that is part of the project. */
export function markdownFiles(root = ROOT): string[] {
  const skip = /(^|\/)(node_modules|dist|\.git|\.screenshots|\.claude\/worktrees|convex\/_generated)(\/|$)/;
  return [...new Bun.Glob('**/*.md').scanSync({ cwd: root, dot: true })].filter((file) => !skip.test(file)).toSorted();
}

export async function checkDocs(root = ROOT): Promise<{ findings: Finding[]; files: number; blocks: number }> {
  const files = markdownFiles(root);
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const manifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const scripts = new Set(Object.keys(manifest.scripts ?? {}));
  const skills = new Set(files.flatMap((file) => SKILL_FILE.exec(file)?.[1] ?? []));
  const context = { skills, agentsGuide: read('AGENTS.md'), skillsGuide: read('docs/agent-skills.md') };

  const known = knownExports(root);
  const findings: Finding[] = [];
  const blocks: Block[] = [];
  for (const file of files) {
    const text = read(file);
    blocks.push(...extractBlocks(file, text), ...extractMembers(file, text, known));
    findings.push(
      ...checkScripts(file, text, scripts),
      ...checkPaths(file, text, (relative) => existsSync(path.join(root, relative))),
      ...checkSkill(file, text, context),
    );
  }
  findings.push(...(await checkBlocks(blocks, root)));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, files: files.length, blocks: blocks.filter((block) => !block.sketch).length };
}

if (import.meta.main) {
  const { findings, files, blocks } = await checkDocs();
  for (const finding of findings) console.log(`${finding.file}:${finding.line}: ${finding.message}`);
  console.log(
    findings.length > 0
      ? `${findings.length} ${findings.length === 1 ? 'problem' : 'problems'} in the documentation.`
      : `${blocks} code blocks compiled, ${files} files read.`,
  );
  process.exit(findings.length > 0 ? 1 : 0);
}
