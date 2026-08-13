import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readPackage(path: string): { version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { version?: string };
  } catch {
    return null;
  }
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve a dependency from the same parent package that declared it.
 *
 * Bun's isolated linker records the exact lockfile selection as a symlink in
 * `<parent>/node_modules/<dependency>`. Following that link is the only
 * reliable way to distinguish valid parallel versions such as
 * `cos-request -> tough-cookie@4` and `jsdom -> tough-cookie@5`. The flat
 * Runtime payload still has one destination per package name, so the first
 * graph edge wins deterministically; the important part is that it is the
 * lockfile-selected edge, never filesystem enumeration order or "newest".
 */
export function resolveBunDependency(
  root: string,
  store: string,
  parent: string,
  dependency: string,
): string | null {
  const candidates: string[] = [];
  let current = parent;
  // Resolve like Node/Bun: a package can use a nested dependency or the
  // sibling link in the enclosing `.bun/<package>/node_modules` directory.
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(current, 'node_modules', dependency));
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  candidates.push(join(root, 'node_modules', dependency));
  for (const candidate of candidates) {
    if (!readPackage(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  }

  // This is only a compatibility fallback for a partially materialized
  // install. Keep it deterministic and prefer the highest version, while the
  // normal path above remains authoritative for a complete frozen install.
  let best: { path: string; version: number[] } | null = null;
  for (const entry of directories(store)) {
    const candidate = join(entry, 'node_modules', dependency);
    const pkg = readPackage(candidate);
    if (!pkg?.version) continue;
    const version = String(pkg.version)
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
    const newer = !best
      || version.some((part, index) => part !== (best.version[index] ?? 0) && part > (best.version[index] ?? 0))
      || (version.every((part, index) => part >= (best.version[index] ?? 0)) && version.length > best.version.length);
    if (newer) best = { path: candidate, version };
  }
  return best?.path ?? null;
}
