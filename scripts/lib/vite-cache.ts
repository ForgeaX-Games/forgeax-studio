// scripts/lib/vite-cache.ts — clear STALE vite optimizeDeps caches only.
//
// vite keys its .vite pre-bundle on package.json/lockfile hashes, NOT on the
// mtime of the symlinked workspace deps it bundles. So when engine dist is
// rebuilt, or editor-shared/-core/interface/play/edit source changes, the vite
// servers keep serving a STALE pre-bundle → "Failed to resolve import X" for
// paths that exist on disk. See perf doc 08 §ViteCacheGuard.
//
// Anchor is a CONTENT hash of the source trees (not bare mtime): `git checkout`
// / main-merge resets every file mtime to "now", silently defeating an mtime
// test. A hash is immune. (Same idea the wgpu-wasm staleness check uses.)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SENTINEL_SUBDIR = join('.forgeax', 'sentinels');
const HASH_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.css', '.wgsl', '.glsl']);
const PRUNE_DIRS = new Set(['node_modules', '.vite', 'dist']);

function sentinelDir(root: string): string {
  return join(root, SENTINEL_SUBDIR);
}

/** Content-hash digest of the given source trees + file anchors (mtime-immune). */
function hashTrees(paths: string[]): string {
  const h = createHash('sha1');
  const addFile = (abs: string) => {
    try {
      h.update(readFileSync(abs));
    } catch {
      // unreadable — skip
    }
  };
  const walk = (abs: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // name-sorted for determinism
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue;
        walk(join(abs, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        if (dot >= 0 && HASH_EXTS.has(e.name.slice(dot))) {
          h.update(e.name);
          addFile(join(abs, e.name));
        }
      }
    }
  };
  for (const p of [...paths].sort()) {
    if (!existsSync(p)) continue;
    if (statSync(p).isFile()) {
      h.update(p);
      addFile(p);
    } else {
      walk(p);
    }
  }
  return h.digest('hex');
}

/**
 * Clear `cacheDir` iff its source trees' content hash differs from the stored
 * sentinel (or FORGEAX_VITE_FORCE_CLEAN=1). Always refreshes the sentinel.
 */
export function viteGuard(root: string, cacheDir: string, sentinelName: string, sourceTrees: string[]): void {
  const sdir = sentinelDir(root);
  mkdirSync(sdir, { recursive: true });
  const sentinel = join(sdir, `vite-${sentinelName}.hash`);
  const now = hashTrees(sourceTrees);
  const prev = existsSync(sentinel) ? readFileSync(sentinel, 'utf8').trim() : '';

  if (existsSync(cacheDir) && (process.env.FORGEAX_VITE_FORCE_CLEAN === '1' || now !== prev)) {
    rmSync(cacheDir, { recursive: true, force: true });
    console.log(`[vite-cache] cleared stale ${relative(root, cacheDir)} (source content changed)`);
  }
  writeFileSync(sentinel, `${now}\n`);
}

/** Nuke every known .vite cache + its sentinel (--purge-vite / --fresh). */
export function vitePurgeAll(root: string): void {
  const caches = [
    join(root, 'packages/interface/node_modules/.vite'),
    join(root, 'packages/studio/node_modules/.vite'),
    join(root, 'packages/editor/packages/edit-runtime/.vite'),
    join(root, 'packages/editor/packages/edit-runtime/node_modules/.vite'),
    join(root, 'packages/editor/packages/play-runtime/.vite'),
    join(root, 'packages/editor/packages/play-runtime/node_modules/.vite'),
  ];
  for (const c of caches) {
    if (existsSync(c)) {
      rmSync(c, { recursive: true, force: true });
      console.log(`[vite-cache] purged ${relative(root, c)}`);
    }
  }
  const sdir = sentinelDir(root);
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir)) {
      if (f.startsWith('vite-') && f.endsWith('.hash')) rmSync(join(sdir, f), { force: true });
    }
  }
}
