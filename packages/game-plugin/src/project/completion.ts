import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const BASELINE_SCHEMA = 'forgeax.game-authoring-baseline/1.1.0';
const BASELINE_PATH = ['.forgeax', 'game-authoring-baseline.json'] as const;
const AUTHOR_INPUTS = ['forge.json', 'package.json', 'README.md', 'src', 'assets'] as const;

interface AuthoringBaseline {
  readonly schemaVersion: typeof BASELINE_SCHEMA;
  readonly authorDigest: string;
  readonly gameplayDigest: string;
  readonly testsDigest: string;
  readonly readmeDigest: string;
  readonly wasEmptyTemplate: boolean;
  readonly recordedAt: string;
}

interface AuthorDigests {
  readonly author: string;
  readonly gameplay: string;
  readonly tests: string;
  readonly readme: string;
}

interface AuthorTestFile {
  readonly path: string;
  readonly content: string;
}

function fileBytesOrEmpty(path: string): Buffer {
  try { return readFileSync(path); } catch { return Buffer.alloc(0); }
}

function isTestPath(name: string): boolean {
  return name.split('/').includes('__tests__') || /(?:^|\/)test(?:s)?\//.test(name) || /\.(?:test|spec)\.[^.]+$/.test(name);
}

function authorDigests(root: string): AuthorDigests {
  const canonicalRoot = resolve(root);
  const rows: string[] = [];
  const gameplayRows: string[] = [];
  const testRows: string[] = [];
  const visit = (path: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch { return; }
    const name = relative(canonicalRoot, path).split('\\').join('/');
    if (stat.isSymbolicLink()) {
      const row = `L\0${name}\0${readlinkSync(path)}`;
      rows.push(row);
      if (isTestPath(name)) testRows.push(row);
      else if (name.startsWith('src/') || name.startsWith('assets/')) gameplayRows.push(row);
      return;
    }
    if (stat.isDirectory()) {
      rows.push(`D\0${name}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (stat.isFile()) {
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      const row = `F\0${name}\0${digest}`;
      rows.push(row);
      if (isTestPath(name)) testRows.push(row);
      else if (name.startsWith('src/') || name.startsWith('assets/')) gameplayRows.push(row);
    }
  };
  for (const input of AUTHOR_INPUTS) visit(join(canonicalRoot, input));
  const hashRows = (value: readonly string[]): string => createHash('sha256').update(value.join('\n')).digest('hex');
  return {
    author: hashRows(rows),
    gameplay: hashRows(gameplayRows),
    tests: hashRows(testRows),
    readme: createHash('sha256').update(fileBytesOrEmpty(join(root, 'README.md'))).digest('hex'),
  };
}

export function ensureAuthoringBaseline(gameRoot: string): string {
  const path = join(gameRoot, ...BASELINE_PATH);
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as AuthoringBaseline;
    if (
      existing.schemaVersion === BASELINE_SCHEMA &&
      [existing.authorDigest, existing.gameplayDigest, existing.testsDigest, existing.readmeDigest]
        .every((digest) => /^[a-f0-9]{64}$/.test(digest))
    ) return path;
  } catch {
    // A missing baseline is expected for an existing game first bound by the plugin.
  }
  mkdirSync(join(gameRoot, '.forgeax'), { recursive: true, mode: 0o700 });
  const digests = authorDigests(gameRoot);
  const forge = JSON.parse(readFileSync(join(gameRoot, 'forge.json'), 'utf8')) as { id?: unknown; name?: unknown };
  const pkg = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8')) as { name?: unknown };
  const value: AuthoringBaseline = {
    schemaVersion: BASELINE_SCHEMA,
    authorDigest: digests.author,
    gameplayDigest: digests.gameplay,
    testsDigest: digests.tests,
    readmeDigest: digests.readme,
    wasEmptyTemplate: forge.id === 'template-empty' || forge.name === 'Empty' || pkg.name === '@forgeax/template-game-empty',
    recordedAt: new Date().toISOString(),
  };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return path;
}

export function assertGameAuthoringComplete(gameRoot: string): void {
  const path = join(gameRoot, ...BASELINE_PATH);
  let baseline: AuthoringBaseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8')) as AuthoringBaseline;
  } catch {
    // Games created before this contract stay runnable; the next `init` records a baseline.
    return;
  }
  if (
    baseline.schemaVersion !== BASELINE_SCHEMA ||
    [baseline.authorDigest, baseline.gameplayDigest, baseline.testsDigest, baseline.readmeDigest]
      .some((digest) => !/^[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error('game_authoring_baseline_invalid: rerun `forgeax-game init`');
  }
  const current = authorDigests(gameRoot);
  if (current.author === baseline.authorDigest) return;

  const forge = JSON.parse(readFileSync(join(gameRoot, 'forge.json'), 'utf8')) as { id?: unknown; name?: unknown };
  const pkg = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8')) as { name?: unknown };
  const readme = fileBytesOrEmpty(join(gameRoot, 'README.md')).toString('utf8');
  const stale: string[] = [];
  if (forge.id === 'template-empty') stale.push('forge.json id');
  if (forge.name === 'Empty') stale.push('forge.json name');
  if (pkg.name === '@forgeax/template-game-empty') stale.push('package.json name');
  if (/^#\s+ForgeaX Empty Game\s*$/m.test(readme)) stale.push('README title');
  if (readme.trim() === '') stale.push('README content');
  if (/forgeax-empty-game-web\.zip/.test(readme)) stale.push('README package output');
  const headings = readme.match(/^#\s+.+$/gm) ?? [];
  if (headings.length !== 1) stale.push(`README top-level headings (${headings.length})`);
  const authoredGameplay = baseline.wasEmptyTemplate && current.gameplay !== baseline.gameplayDigest;
  if (authoredGameplay && current.tests === baseline.testsDigest) stale.push('gameplay tests');
  if (authoredGameplay && current.readme === baseline.readmeDigest) stale.push('README content');
  if (authoredGameplay && hasDirectDocumentBodyMount(readGameplaySource(gameRoot))) {
    stale.push('Engine Host UI mount (direct document.body mutation)');
  }
  if (authoredGameplay && !hasGameplayBehaviorTest(gameRoot)) {
    stale.push('gameplay behavior tests (export and exercise a named gameplay function)');
  }
  for (const testMarker of ['empty game starter', 'ForgeaX Empty Game']) {
    if (authoredGameplay && readAuthorTests(gameRoot).includes(testMarker)) {
      stale.push(`template test marker ${JSON.stringify(testMarker)}`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `game_completion_incomplete: gameplay changed but completion evidence is stale: ${stale.join(', ')}; finalize identity, Host UI mounting, README/controls, and behavior tests before claiming completion`,
    );
  }
}

function readAuthorTestFiles(root: string): AuthorTestFile[] {
  const values: AuthorTestFile[] = [];
  const visit = (path: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch { return; }
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    const name = relative(root, path).split('\\').join('/');
    if (stat.isFile() && isTestPath(name)) values.push({ path, content: readFileSync(path, 'utf8') });
  };
  visit(join(root, 'src'));
  return values;
}

function readAuthorTests(root: string): string {
  return readAuthorTestFiles(root).map((test) => test.content).join('\n');
}

function readGameplaySource(root: string): string {
  const values: string[] = [];
  const visit = (path: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch { return; }
    const name = relative(root, path).split('\\').join('/');
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (stat.isFile() && !isTestPath(name) && /\.[cm]?[jt]sx?$/.test(name)) {
      values.push(readFileSync(path, 'utf8'));
    }
  };
  visit(join(root, 'src'));
  return values.join('\n');
}

function hasDirectDocumentBodyMount(source: string): boolean {
  return /\bdocument\s*\.\s*body\s*\.\s*(?:append|appendChild|prepend|replaceChildren|insertAdjacentElement|insertAdjacentHTML)\s*\(/u.test(source) ||
    /\bdocument\s*\.\s*body\s*\.\s*(?:innerHTML|outerHTML|textContent)\s*=/u.test(source) ||
    /\bdocument\s*\.\s*querySelector\s*\(\s*['"]body['"]\s*\)\s*\??\.\s*(?:append|appendChild|prepend|replaceChildren)\s*\(/u.test(source);
}

function sourceModule(testPath: string, specifier: string): { path: string; content: string } | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const unresolved = resolve(dirname(testPath), specifier);
  const extension = extname(unresolved);
  const candidates = extension === '.js' || extension === '.jsx'
    ? [`${unresolved.slice(0, -extension.length)}.ts`, `${unresolved.slice(0, -extension.length)}.tsx`, unresolved]
    : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, join(unresolved, 'index.ts')];
  for (const path of candidates) {
    try {
      if (!lstatSync(path).isFile()) continue;
      return { path, content: readFileSync(path, 'utf8') };
    } catch {
      // Try the next source spelling.
    }
  }
  return undefined;
}

function hasGameplayBehaviorTest(root: string): boolean {
  for (const test of readAuthorTestFiles(root)) {
    if (!/\b(?:expect|assert)\s*\(/u.test(test.content)) continue;
    const imports = test.content.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gu);
    for (const imported of imports) {
      const module = sourceModule(test.path, imported[2]!);
      if (!module) continue;
      const moduleName = relative(root, module.path).split('\\').join('/');
      if (!moduleName.startsWith('src/') || isTestPath(moduleName)) continue;
      const body = test.content.replace(imported[0], '');
      for (const rawBinding of imported[1]!.split(',')) {
        const parts = rawBinding.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u);
        const exported = parts[0]?.trim();
        const local = parts.at(-1)?.trim();
        if (!exported || !local) continue;
        const exportPattern = new RegExp(
          `\\bexport\\s+(?:(?:async\\s+)?function\\s+${exported}\\b|const\\s+${exported}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`,
          'u',
        );
        const invocationPattern = new RegExp(`\\b${local}\\s*\\(`, 'u');
        if (exportPattern.test(module.content) && invocationPattern.test(body)) return true;
      }
    }
  }
  return false;
}
