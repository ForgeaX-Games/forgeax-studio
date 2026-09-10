/**
 * Extension discovery — ManifestScanner (relocated from @forgeax/orchestrator
 * as the node-side landing point of the single extension domain).
 *
 * Walks the extension origins (built-in / user-installed / project-specific /
 * npm-declared) and returns parsed ExtensionManifest[] tagged by origin.
 * Validation goes through `@forgeax/toolkit/contracts`, the public native
 * extension standard consumed by Toolkit and every ForgeaX Host.
 *
 * The `npm` origin lets a product declare embedded extensions as npm
 * dependencies: the product resolves each package directory (require.resolve)
 * and passes them in, so a packaged extension shipped as `<pkg>/dist` is
 * discovered without being vendored as a marketplace submodule.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  parseExtensionManifest,
  type ExtensionManifest,
} from '@forgeax/toolkit/contracts';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';

export type ExtensionOrigin = 'builtin' | 'user' | 'project' | 'npm';

export interface ScannedManifest {
  origin: ExtensionOrigin;
  originPath: string;
  manifest: ExtensionManifest;
  /** The canonical public manifest; no compatibility projection is created. */
  normalizedManifest: ExtensionManifest;
}

export interface ScanError {
  origin: ExtensionOrigin;
  originPath: string;
  reason: string;
}

export interface ScanResult {
  found: ScannedManifest[];
  errors: ScanError[];
}

/** ADR 0025 M3.5 — user-disk directory migration (the sanctioned compat
 *  exception, same family as the scanner's legacy-id normalize): machines
 *  from before the Extension rename carry `.forgeax/plugins` directories.
 *  Rename once at the single resolution point; idempotent — skipped when
 *  the new dir already exists or the legacy one is absent. */
function migrateLegacyExtensionDir(base: string): void {
  const legacy = resolve(base, '.forgeax/plugins');
  const current = resolve(base, '.forgeax/extensions');
  try {
    if (safeIsDir(legacy) && !safeIsDir(current)) {
      renameSync(legacy, current);
      console.warn(`[extensions/scanner] migrated legacy directory ${legacy} -> ${current}`);
    }
  } catch (e) {
    console.warn(`[extensions/scanner] legacy directory migration failed (${legacy}): ${(e as Error).message}`);
  }
}

/** Resolve the canonical root directory for each directory-scanned origin.
 *
 *  builtin: `<host-assets>/extensions`
 *  user: `~/.forgeax/extensions`
 *  project: `<projectRoot>/.forgeax/extensions`
 *
 *  The `npm` origin has no single root (each extension is a separately
 *  resolved package directory), so it is not part of this map — it is passed
 *  to `scanAllExtensionOrigins` as explicit directories.
 *
 *  Returns null for an origin when its root doesn't exist (so newcomers
 *  without ~/.forgeax don't trip an error). Caller can override roots
 *  via `opts` for tests. */
export function defaultExtensionRoots(opts?: { repoRoot?: string; projectRoot?: string }): Record<'builtin' | 'user' | 'project', string | null> {
  const projectRoot = opts?.projectRoot ?? defaultProjectRoot();
  migrateLegacyExtensionDir(homedir());
  if (projectRoot) migrateLegacyExtensionDir(projectRoot);
  const candidates = (paths: string[]) => paths.find((p) => safeIsDir(p)) ?? null;
  return {
    // Built-ins, when a host bundles any, live under its generic resource root.
    // Product-selected npm extensions are supplied separately through the npm origin.
    builtin: candidates([
      resolve(assetRoot(), 'extensions'),
    ]),
    user: candidates([resolve(homedir(), '.forgeax/extensions')]),
    project: projectRoot ? candidates([resolve(projectRoot, '.forgeax/extensions')]) : null,
  };
}

function safeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parse one public manifest without deriving or rewriting business semantics. */
function ingestManifest(origin: ExtensionOrigin, manifestPath: string, raw: string, out: ScanResult): void {
  try {
    const manifest = parseExtensionManifest(JSON.parse(raw));
    out.found.push({ origin, originPath: manifestPath, manifest, normalizedManifest: manifest });
  } catch (error) {
    out.errors.push({
      origin,
      originPath: manifestPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function scanExtensionOrigin(origin: ExtensionOrigin, root: string): Promise<ScanResult> {
  const out: ScanResult = { found: [], errors: [] };
  // Async + withFileTypes — kills the per-entry statSync probe for "is this a
  // directory?" and the readdir itself stops blocking the event loop. The
  // existsSync on manifestPath is also gone; we just try-readFile and let
  // ENOENT surface as a 'continue' below.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    out.errors.push({ origin, originPath: root, reason: `readdir failed: ${(e as Error).message}` });
    return out;
  }
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith('.')) continue;
    const extensionDir = join(root, name);
    if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && safeIsDir(extensionDir))) continue;
    const manifestPath = join(extensionDir, 'forgeax-extension.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // not a plugin dir, just skip
      out.errors.push({ origin, originPath: manifestPath, reason: (e as Error).message });
      continue;
    }
    ingestManifest(origin, manifestPath, raw, out);
  }
  return out;
}

/** Scan a single already-resolved package directory (an npm-declared embedded
 *  extension) for its `forgeax-extension.json`. Unlike `scanExtensionOrigin`
 *  this treats `dir` as one extension, not a root of many. */
async function scanNpmExtensionDir(dir: string): Promise<ScanResult> {
  const out: ScanResult = { found: [], errors: [] };
  const manifestPath = join(dir, 'forgeax-extension.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (e) {
    out.errors.push({ origin: 'npm', originPath: manifestPath, reason: (e as Error).message });
    return out;
  }
  ingestManifest('npm', manifestPath, raw, out);
  return out;
}

/** Doc 14 §4 spike — Safe Boot: when `FORGEAX_SAFE_BOOT=1`, skip user+project
 *  scans so the host can be edited without a broken plugin breaking it.
 *  builtin (in-tree marketplace) is always scanned because the host bundles it.
 *  npm-declared extensions are host-bundled dependencies (product-pinned), so
 *  they are treated like builtin and always scanned.
 *  Returns `true` when safe-boot is active. */
export function isSafeBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_SAFE_BOOT;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Doc 14 §4 spike — Production gate for `entry.standalone.devOnly`.
 *  Reads `FORGEAX_NODE_ENV` (preferred — explicit) and falls back to
 *  `NODE_ENV`. Only the literal "production" counts. Used by the scanner
 *  to refuse devOnly standalone entries in packaged builds. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_NODE_ENV ?? env.NODE_ENV;
  return v === 'production';
}

/** Scan all extension origins. Caller usually passes the result through
 *  ManifestMerger to dedupe by id. Honours `FORGEAX_SAFE_BOOT=1` by scanning
 *  builtin (+ npm) only.
 *
 *  `npmExtensionDirs` are already-resolved package directories for
 *  npm-declared embedded extensions (product supplies them via
 *  `require.resolve`), scanned as individual single-extension packages. They
 *  are first-party (host-bundled) so, like builtin, they are scanned even
 *  under safe boot. */
export async function scanAllExtensionOrigins(
  roots?: Partial<Record<'builtin' | 'user' | 'project', string | null>>,
  npmExtensionDirs?: readonly string[],
): Promise<ScanResult> {
  const resolved = { ...defaultExtensionRoots(), ...(roots ?? {}) };
  const merged: ScanResult = { found: [], errors: [] };
  const safe = isSafeBoot();
  for (const origin of ['builtin', 'user', 'project'] as const) {
    if (safe && origin !== 'builtin') continue;
    const root = resolved[origin];
    if (!root) continue;
    const r = await scanExtensionOrigin(origin, root);
    merged.found.push(...r.found);
    merged.errors.push(...r.errors);
  }
  for (const dir of npmExtensionDirs ?? []) {
    const r = await scanNpmExtensionDir(dir);
    merged.found.push(...r.found);
    merged.errors.push(...r.errors);
  }
  return merged;
}
