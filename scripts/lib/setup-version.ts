// Setup-version snapshot: the last successfully materialised dependency state.
// The file is runtime state under .forgeax/, not a hand-maintained version file.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SetupSubmoduleSnapshot = {
  path: string;
  pin: string;
  head: string;
};

export type SetupSnapshot = {
  schemaVersion: 1;
  recordedAt: string;
  rootHead: string;
  submodules: SetupSubmoduleSnapshot[];
};

export type SetupVersionCheck = {
  status: 'missing' | 'invalid' | 'current' | 'stale';
  differences: string[];
};

export function setupSnapshotPath(root: string): string {
  return join(root, '.forgeax', 'setup-version.json');
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function submodulePaths(repo: string): string[] {
  const output = git(repo, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

function collectSubmodules(root: string): SetupSubmoduleSnapshot[] {
  const rows: SetupSubmoduleSnapshot[] = [];
  const walk = (repo: string, prefix: string): void => {
    for (const path of submodulePaths(repo)) {
      const fullPath = prefix ? `${prefix}/${path}` : path;
      const pin = git(repo, ['rev-parse', `:${path}`]);
      if (!pin) throw new Error(`cannot read recorded submodule pin: ${fullPath}`);
      const child = join(repo, path);
      const initialized = existsSync(join(child, '.git'));
      rows.push({
        path: fullPath,
        pin,
        head: initialized ? git(child, ['rev-parse', 'HEAD']) : '',
      });
      if (initialized) walk(child, fullPath);
    }
  };
  walk(root, '');
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function captureSetupSnapshot(root: string, recordedAt = new Date().toISOString()): SetupSnapshot {
  const rootHead = git(root, ['rev-parse', 'HEAD']);
  if (!rootHead) throw new Error('cannot read root repository HEAD');
  return {
    schemaVersion: 1,
    recordedAt,
    rootHead,
    submodules: collectSubmodules(root),
  };
}

export function writeSetupSnapshot(root: string): SetupSnapshot {
  const snapshot = captureSetupSnapshot(root);
  const out = setupSnapshotPath(root);
  mkdirSync(join(root, '.forgeax'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

function isSnapshot(value: unknown): value is SetupSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SetupSnapshot>;
  return row.schemaVersion === 1
    && typeof row.recordedAt === 'string'
    && typeof row.rootHead === 'string'
    && Array.isArray(row.submodules)
    && row.submodules.every((sub) => (
      !!sub
      && typeof sub === 'object'
      && typeof (sub as SetupSubmoduleSnapshot).path === 'string'
      && typeof (sub as SetupSubmoduleSnapshot).pin === 'string'
      && typeof (sub as SetupSubmoduleSnapshot).head === 'string'
    ));
}

export function readSetupSnapshot(root: string): SetupSnapshot | null {
  const file = setupSnapshotPath(root);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

export function compareSetupSnapshots(expected: SetupSnapshot, current: SetupSnapshot): string[] {
  const differences: string[] = [];
  if (expected.rootHead !== current.rootHead) {
    differences.push(`root HEAD ${expected.rootHead.slice(0, 12)} → ${current.rootHead.slice(0, 12)}`);
  }

  const expectedByPath = new Map(expected.submodules.map((sub) => [sub.path, sub]));
  const currentByPath = new Map(current.submodules.map((sub) => [sub.path, sub]));
  const paths = new Set([...expectedByPath.keys(), ...currentByPath.keys()]);
  for (const path of [...paths].sort()) {
    const before = expectedByPath.get(path);
    const after = currentByPath.get(path);
    if (!before || !after) {
      differences.push(`${path} ${before ? 'removed' : 'added'}`);
      continue;
    }
    if (before.pin !== after.pin) {
      differences.push(`${path} pin ${before.pin.slice(0, 12)} → ${after.pin.slice(0, 12)}`);
    }
    if (before.head !== after.head) {
      differences.push(`${path} checkout ${before.head ? before.head.slice(0, 12) : '(missing)'} → ${after.head ? after.head.slice(0, 12) : '(missing)'}`);
    }
  }
  return differences;
}

export function checkSetupVersion(root: string): SetupVersionCheck {
  const expected = readSetupSnapshot(root);
  if (!existsSync(setupSnapshotPath(root))) return { status: 'missing', differences: [] };
  if (!expected) return { status: 'invalid', differences: ['setup-version.json is invalid'] };
  try {
    const differences = compareSetupSnapshots(expected, captureSetupSnapshot(root));
    return { status: differences.length === 0 ? 'current' : 'stale', differences };
  } catch (error) {
    return { status: 'stale', differences: [error instanceof Error ? error.message : String(error)] };
  }
}
