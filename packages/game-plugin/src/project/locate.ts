/**
 * Locate the ForgeaX project the current request is about.
 *
 * The MCP server is installed at user level (one config shared by every client and
 * every project), so the project must be resolved per request rather than baked into
 * the launch command. Baking a `cwd` into user-level config is what makes two open
 * projects silently write into each other.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Game slugs are directory names; keep the same shape the runtime already enforces. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** How the project directory was determined, surfaced in status for debugging. */
export type ProjectSource = 'explicit' | 'env' | 'cwd-walkup' | 'none';

export interface ProjectBinding {
  /** Instance root: the directory containing `.forgeax/`. Undefined when unbound. */
  readonly root?: string;
  readonly source: ProjectSource;
  /** Directory we started resolution from, for diagnostics. */
  readonly searchedFrom: string;
}

export interface LocalProjectInitResult {
  readonly root: string;
  readonly gameRoot: string;
  readonly projectCreated: boolean;
}

/**
 * Create the smallest useful ForgeaX instance without talking to Studio.
 *
 * The server normally owns this metadata, but a package-only install must still
 * be able to get a new user from an empty directory to an editable game. Existing
 * metadata is never replaced; this keeps the operation safe for partially-created
 * projects and lets a later server run enrich the instance in place.
 */
export function ensureLocalProject(root: string): { root: string; created: boolean } {
  const projectRoot = resolve(root);
  const forgeaxRoot = join(projectRoot, '.forgeax');
  const created = !existsSync(forgeaxRoot);
  mkdirSync(join(forgeaxRoot, 'games'), { recursive: true });
  const metadataPath = join(forgeaxRoot, 'project.json');
  if (!existsSync(metadataPath)) {
    const name = projectRoot.split(sep).filter(Boolean).pop() || 'forgeax-project';
    writeFileSync(
      metadataPath,
      `${JSON.stringify({ version: 1, type: 'game', name }, null, 2)}\n`,
      'utf8',
    );
  }
  return { root: projectRoot, created };
}

const LOCAL_GAME_MAIN = `/** Minimal ForgeaX game scaffold. Add systems and assets here. */
export function bootstrap() {
  // The engine accepts an empty bootstrap; this keeps package-only init offline.
}
`;

/** Scaffold and activate a game when no ForgeaX server is available. */
export function initLocalGame(root: string, slug: string): LocalProjectInitResult {
  const project = ensureLocalProject(root);
  const gameRoot = join(project.root, '.forgeax', 'games', slug);
  if (existsSync(gameRoot)) throw new Error(`game ${JSON.stringify(slug)} already exists`);
  mkdirSync(gameRoot, { recursive: true });
  writeFileSync(
    join(gameRoot, 'forge.json'),
    `${JSON.stringify(
      { id: slug, name: slug, schemaVersion: '1.0.0', entry: 'main.ts', physics: '3d' },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(gameRoot, 'package.json'),
    `${JSON.stringify({ name: slug, private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(gameRoot, 'main.ts'), LOCAL_GAME_MAIN, 'utf8');
  writeFileSync(
    join(gameRoot, 'tsconfig.json'),
    `${JSON.stringify({
      extends: '../../engine-sdk/tsconfig.json',
      include: ['**/*.ts'],
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(gameRoot, 'FORGE.md'),
    `# ${slug}\n\n_(created by the package-local ForgeaX bootstrap)_\n`,
    'utf8',
  );
  writeFileSync(
    join(project.root, '.forgeax', 'active-game.json'),
    `${JSON.stringify({ version: 1, slug }, null, 2)}\n`,
    'utf8',
  );
  return { root: project.root, gameRoot, projectCreated: project.created };
}

function isConfinedToProject(root: string, path: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Does this directory hold a ForgeaX *project*, as opposed to any `.forgeax/` directory?
 *
 * The bare directory name is not sufficient evidence. `~/.forgeax/` is this plugin's own
 * user-level state — runtime cache, agent-host sockets — and it exists on any machine
 * that has run ForgeaX once. Treating it as a marker made every directory under $HOME
 * resolve its project root to $HOME, which wrote project files into the home directory
 * and then failed the server's instance-root check. So a project must show a file that
 * only `init` (or Studio) writes.
 */
function isProjectRoot(dir: string): boolean {
  if (resolve(dir) === resolve(homedir())) return false;
  const forgeax = join(dir, '.forgeax');
  if (!existsSync(forgeax)) return false;
  return ['project.json', 'active-game.json', 'games'].some((marker) => existsSync(join(forgeax, marker)));
}

/** Walk up from `start` until a directory looks like a ForgeaX project. */
function findInstanceRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (isProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the project for this request.
 *
 * Precedence is explicit argument, then environment, then walking up from cwd. An
 * explicit directory that is not a ForgeaX project stays unbound rather than silently
 * falling back, so a typo surfaces instead of operating on the wrong tree.
 */
export function resolveProject(explicitDir?: string): ProjectBinding {
  if (explicitDir?.trim()) {
    const from = resolve(explicitDir.trim());
    const root = findInstanceRoot(from);
    return root ? { root, source: 'explicit', searchedFrom: from } : { source: 'none', searchedFrom: from };
  }

  const envRoot = process.env.FORGEAX_PROJECT_ROOT?.trim();
  if (envRoot) {
    const from = resolve(envRoot);
    if (isProjectRoot(from)) return { root: from, source: 'env', searchedFrom: from };
  }

  const cwd = process.cwd();
  const root = findInstanceRoot(cwd);
  return root ? { root, source: 'cwd-walkup', searchedFrom: cwd } : { source: 'none', searchedFrom: cwd };
}

/** Read the currently active game slug, if one is recorded and well-formed. */
export function activeGame(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, '.forgeax', 'active-game.json'), 'utf8');
    const slug = (JSON.parse(raw) as { slug?: unknown }).slug;
    return typeof slug === 'string' && SLUG_RE.test(slug) ? slug : undefined;
  } catch {
    return undefined;
  }
}

/**
 * List game slugs. Reads the canonical `.forgeax/games/` plus the legacy top-level
 * `games/` that older instances still use, dropping `_template` and dotfiles.
 */
export function listGames(root: string): string[] {
  const found = new Set<string>();
  for (const base of [join(root, '.forgeax', 'games'), join(root, 'games')]) {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      if (e.isDirectory() && isConfinedToProject(root, join(base, e.name))) {
        found.add(e.name);
        continue;
      }
      // Sample games are mounted as project-internal directory symlinks.
      // Dirent.isDirectory() is false for a symlink, so follow it while rejecting
      // broken links and links that escape the instance root.
      if (e.isSymbolicLink()) {
        try {
          const path = join(base, e.name);
          if (statSync(path).isDirectory() && isConfinedToProject(root, path)) found.add(e.name);
        } catch {
          /* broken link — not an available game */
        }
      }
    }
  }
  return [...found].sort();
}

/** Absolute directory for a game, preferring the canonical location. */
export function gameDir(root: string, slug: string): string | undefined {
  if (!SLUG_RE.test(slug)) return undefined;
  for (const base of [join(root, '.forgeax', 'games'), join(root, 'games')]) {
    const dir = join(base, slug);
    try {
      if (statSync(dir).isDirectory() && isConfinedToProject(root, dir)) return dir;
    } catch {
      /* try the next base */
    }
  }
  return undefined;
}
