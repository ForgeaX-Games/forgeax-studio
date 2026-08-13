#!/usr/bin/env bun

/**
 * Snapshot the public Engine package types and the canonical game template.
 * The snapshot is intentionally generated from the same Engine checkout that
 * produces the Runtime artifact.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(import.meta.dir, '..');
/**
 * Root of the ForgeaX Studio checkout this build reads from.
 *
 * The plugin's own source has no dependency on Studio, but producing its Runtime does:
 * the Engine checkout, the desktop resource tree and the server closure all live there.
 * As a submodule at `packages/game-plugin` the default resolves to the Studio root, so
 * an in-tree build needs no configuration; a standalone clone points at one explicitly.
 */
const repoRoot = resolve(process.env.FORGEAX_STUDIO_ROOT?.trim() || resolve(packageRoot, '../..'));
const engineRoot = join(repoRoot, 'packages/editor/packages/engine');
const output = resolve(packageRoot, '.runtime/engine-sdk');

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'packages'), { recursive: true });

if (!existsSync(engineRoot)) {
  throw new Error(
    `Engine checkout is missing: ${engineRoot}\n` +
    'Set FORGEAX_STUDIO_ROOT to a ForgeaX Studio checkout, or run this from packages/game-plugin inside one.',
  );
}

/**
 * Copy a package's public declarations, following relative re-exports transitively.
 *
 * The entry declarations named by package.json are almost always barrels that
 * `export … from './components/mesh-filter'`. Copying only the named entries leaves
 * those specifiers dangling, and TypeScript then reports every re-exported symbol as
 * missing — which reads to a model as "this API does not exist" and pushes it toward
 * inventing one. So the closure is copied, not just the entry points.
 */
function copyExportedDeclarations(source: string, destination: string, metadata: { exports?: unknown; types?: unknown }): number {
  const queue: string[] = [];
  const seen = new Set<string>();

  const enqueue = (relative: string): void => {
    const normalized = relative.replace(/^\.\/+/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
  };

  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.endsWith('.d.ts')) enqueue(value);
    else if (value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    }
  };
  visit(metadata.types);
  visit(metadata.exports);

  /**
   * Resolve a relative specifier the way TypeScript would, to a .d.ts inside the
   * package. Emitted declarations use NodeNext-style `./clock.js` specifiers, which
   * must map onto `./clock.d.ts` — resolving only bare paths leaves those unresolved.
   */
  const resolveDeclaration = (fromRelative: string, specifier: string): string | undefined => {
    const base = join(dirname(fromRelative), specifier);
    const withoutJs = base.replace(/\.[cm]?js$/, '');
    for (const candidate of [
      `${withoutJs}.d.ts`,
      join(withoutJs, 'index.d.ts'),
      `${base}.d.ts`,
      join(base, 'index.d.ts'),
      base,
    ]) {
      const normalized = candidate.replace(/^\.\/+/, '');
      if (normalized.endsWith('.d.ts') && existsSync(join(source, normalized))) return normalized;
    }
    return undefined;
  };

  let copied = 0;
  while (queue.length > 0) {
    const relative = queue.shift()!;
    const from = join(source, relative);
    if (!existsSync(from)) continue;
    const to = join(destination, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    copied += 1;

    // `from '…'`, `import('…')` and bare `import '…'` all carry relative specifiers.
    const text = readFileSync(from, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = resolveDeclaration(relative, match[1]!);
      if (resolved) enqueue(resolved);
    }
  }
  return copied;
}

function copyTemplate(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTemplate(from, to);
    else cpSync(from, to);
  }
}

const packages: string[] = [];
const missingDeclarations: string[] = [];
for (const entry of readdirSync(join(engineRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(engineRoot, 'packages', entry.name);
  const packageJson = join(source, 'package.json');
  if (!existsSync(packageJson)) continue;
  const metadata = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string; exports?: unknown; types?: unknown };
  if (!metadata.name?.startsWith('@forgeax/engine-')) continue;
  const destination = join(output, 'packages', entry.name);
  mkdirSync(destination, { recursive: true });
  cpSync(packageJson, join(destination, 'package.json'));
  const declarations = copyExportedDeclarations(source, destination, metadata);
  if (declarations === 0) missingDeclarations.push(metadata.name);
  packages.push(metadata.name);
}

const template = join(engineRoot, 'templates/game-default');
if (existsSync(template)) {
  copyTemplate(template, join(output, 'examples/game-default'));
}

/**
 * Authoring skills teach the calling model how to write against this Engine; the
 * declarations above only state what exists. Shipping them from the same checkout
 * keeps one commit answering both "what is the API" and "how is it meant to be used".
 */
const skills: string[] = [];
const skillsSource = join(engineRoot, 'skills');
if (existsSync(skillsSource)) {
  for (const entry of readdirSync(skillsSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(skillsSource, entry.name, 'SKILL.md'))) continue;
    copyTemplate(join(skillsSource, entry.name), join(output, 'skills', entry.name));
    skills.push(entry.name);
  }
}
if (skills.length === 0) {
  throw new Error(
    `no Engine authoring skills found under ${skillsSource}; the plugin would ship a Runtime it cannot teach a model to target`,
  );
}

/**
 * Source is the last escalation when a skill plus declarations still leave the model
 * guessing, or when it must trace an Engine-side bug. Only the authoring source is
 * copied: test fixtures under forgeax-engine-assets are hundreds of megabytes and
 * answer no authoring question.
 *
 * This is bundled rather than fetched on demand because the public Engine mirror
 * carries neither this commit nor a resolvable mapping to it, so a download could
 * silently deliver source from a different Engine than the Runtime being previewed.
 */
const sourcePackages: string[] = [];
for (const entry of readdirSync(join(engineRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = join(engineRoot, 'packages', entry.name, 'src');
  if (!existsSync(from)) continue;
  copyTemplate(from, join(output, 'source', entry.name, 'src'));
  sourcePackages.push(entry.name);
}

const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const engineCommit = git.status === 0 ? git.stdout.trim() : 'unknown';
writeFileSync(
  join(output, 'engine-version.json'),
  `${JSON.stringify({
    engineCommit,
    packageCount: packages.length,
    packages: packages.sort(),
    skills: skills.sort(),
    sourcePackages: sourcePackages.sort(),
  }, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  join(output, 'tsconfig.json'),
  `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      // The snapshot carries prebuilt Engine declarations. Their own internal gaps
      // (WebGPU ambient globals, cross-package re-exports) are not the game author's
      // to fix, and reporting them buries the errors that are.
      skipLibCheck: true,
      baseUrl: '.',
      paths: Object.fromEntries(packages.map((name) => [
        name,
        [`packages/${name.slice('@forgeax/engine-'.length)}/dist/index.d.ts`],
      ]).concat(packages.map((name) => [
        `${name}/*`,
        [`packages/${name.slice('@forgeax/engine-'.length)}/dist/*`],
      ]))),
    },
    include: ['examples/**/*.ts'],
  }, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  join(output, 'README.md'),
  `# ForgeaX Engine SDK snapshot\n\nEngine commit: ${engineCommit}\n\nEverything here is generated from the exact Engine pin used by the bundled Runtime, so a game written against it runs on the Runtime that previews it.\n\nRead in this order, and stop as soon as the question is answered:\n\n1. \`skills/\` (${skills.length}) — how this Engine is meant to be used: schedules, lifecycles, and the invariants declarations cannot state.\n2. \`packages/*/dist/*.d.ts\` (${packages.length}) and \`examples/game-default/\` — the exact API surface and a working game.\n3. \`source/*/src/\` (${sourcePackages.length}) — the implementation, for when a skill and the declarations still leave a choice open or an Engine-side bug must be traced.\n`,
  'utf8',
);

console.log(
  `Engine SDK snapshot: ${output} (${packages.length} packages, ${skills.length} skills, ${sourcePackages.length} source trees, commit ${engineCommit})`,
);
