/**
 * Locate the ForgeaX project the current request is about.
 *
 * The MCP server is installed at user level (one config shared by every client and
 * every project), so the project must be resolved per request rather than baked into
 * the launch command. Baking a `cwd` into user-level config is what makes two open
 * projects silently write into each other.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Game slugs are directory names; preserve the public project identifier shape. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const GUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** How the project directory was determined, surfaced in status for debugging. */
export type ProjectSource = 'explicit' | 'env' | 'cwd-walkup' | 'none';

export interface ProjectBinding {
  /** Canonical external Engine game root. Undefined when unbound. */
  readonly root?: string;
  readonly source: ProjectSource;
  /** Directory we started resolution from, for diagnostics. */
  readonly searchedFrom: string;
}

/** G0 binds only a released external Engine game, never a Studio project wrapper. */
function isProjectRoot(dir: string): boolean {
  return engineGameId(dir) !== undefined;
}

/** A released Engine game is a complete project for this connector. */
export function engineGameId(root: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'forge.json'), 'utf8')) as {
      id?: unknown;
      entry?: unknown;
      schemaVersion?: unknown;
      defaultScene?: unknown;
      roots?: unknown;
    };
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Readonly<Record<string, unknown>>;
    };
    return typeof manifest.id === 'string' && SLUG_RE.test(manifest.id) &&
      (manifest.schemaVersion === '3.0.0'
        ? manifest.roots !== null && typeof manifest.roots === 'object' && !Array.isArray(manifest.roots) &&
          Object.entries(manifest.roots).every(([realm, guid]) =>
            ['host', 'frontend', 'engine', 'build'].includes(realm) && typeof guid === 'string' && GUID_RE.test(guid))
        : manifest.schemaVersion === '2.0.0'
          ? typeof manifest.defaultScene === 'string' && GUID_RE.test(manifest.defaultScene)
          : (manifest.schemaVersion === undefined || manifest.schemaVersion === '1.0.0') && typeof manifest.entry === 'string') &&
      typeof pkg.dependencies?.['@forgeax/engine'] === 'string'
      ? manifest.id
      : undefined;
  } catch {
    return undefined;
  }
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
  return engineGameId(root);
}

/** G0 has exactly one game per external Engine root. */
export function listGames(root: string): string[] {
  const direct = engineGameId(root);
  return direct ? [direct] : [];
}

/** Absolute directory for this root's one released Engine game. */
export function gameDir(root: string, slug: string): string | undefined {
  if (!SLUG_RE.test(slug)) return undefined;
  return engineGameId(root) === slug ? realpathSync(root) : undefined;
}
