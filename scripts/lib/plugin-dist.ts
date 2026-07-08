// Shared marketplace plugin dist freshness checks (build-plugins, setup, fx update).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLUGIN_SOURCE_STAMP = '.forgeax-source-rev';

/** Resolve a plugin's served dist dir (most use dist/; wb-narrative uses viz/dist/). */
export function distDirFor(pluginDir: string): string {
  if (existsSync(join(pluginDir, 'viz/dist/index.html'))
    || (existsSync(join(pluginDir, 'viz')) && !existsSync(join(pluginDir, 'dist')))) {
    return join(pluginDir, 'viz/dist');
  }
  return join(pluginDir, 'dist');
}

/** Broken = no index.html, or index.html references a missing assets/*.js|css. */
export function isBrokenDist(dist: string): boolean {
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) return true;
  const html = readFileSync(indexHtml, 'utf8');
  for (const m of html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) {
    if (!existsSync(join(dist, m[0]))) return true;
  }
  return false;
}

function gitSourceRevision(pluginDir: string): string | null {
  if (!existsSync(join(pluginDir, '.git'))) return null;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pluginDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: pluginDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!dirty) return head;
    const hash = createHash('sha256').update(dirty).digest('hex').slice(0, 12);
    return `${head}+dirty-${hash}`;
  } catch {
    return null;
  }
}

/** Fallback when the plugin dir is not its own git repo (vendored in marketplace). */
function treeSourceRevision(pluginDir: string): string {
  let newest = 0;
  const roots = ['src', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json'];
  for (const name of roots) {
    const p = join(pluginDir, name);
    if (!existsSync(p)) continue;
    newest = Math.max(newest, walkNewestMtime(p));
  }
  return `tree:${newest}`;
}

function walkNewestMtime(path: string): number {
  let newest = statSync(path).mtimeMs;
  if (!statSync(path).isDirectory()) return newest;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    newest = Math.max(newest, walkNewestMtime(join(path, e.name)));
  }
  return newest;
}

/** Fingerprint of plugin source used to decide whether dist/ is up to date. */
export function pluginSourceRevision(pluginDir: string): string {
  return gitSourceRevision(pluginDir) ?? treeSourceRevision(pluginDir);
}

export function readDistSourceStamp(distDir: string): string | null {
  const stampPath = join(distDir, PLUGIN_SOURCE_STAMP);
  if (!existsSync(stampPath)) return null;
  try {
    return readFileSync(stampPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeDistSourceStamp(distDir: string, revision: string): void {
  writeFileSync(join(distDir, PLUGIN_SOURCE_STAMP), `${revision}\n`, 'utf8');
}

/** True when dist is missing, broken, or was built from an older source revision. */
export function isPluginDistStale(pluginDir: string, distDir = distDirFor(pluginDir)): boolean {
  if (isBrokenDist(distDir)) return true;
  const expected = pluginSourceRevision(pluginDir);
  const stamped = readDistSourceStamp(distDir);
  if (!stamped) return true;
  return stamped !== expected;
}

export type PluginDistReason = 'force' | 'broken' | 'stale' | 'fresh';

export function pluginDistStatus(
  pluginDir: string,
  opts: { force?: boolean } = {},
): { distDir: string; reason: PluginDistReason } {
  const distDir = distDirFor(pluginDir);
  if (opts.force) return { distDir, reason: 'force' };
  if (isBrokenDist(distDir)) return { distDir, reason: 'broken' };
  if (isPluginDistStale(pluginDir, distDir)) return { distDir, reason: 'stale' };
  return { distDir, reason: 'fresh' };
}
