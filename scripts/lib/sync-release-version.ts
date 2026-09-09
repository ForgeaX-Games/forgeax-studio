// Studio owns source-orchestration metadata only. The independently versioned IDE
// owns package.json, Tauri, Cargo.toml, and Cargo.lock synchronization through its
// public Release workflow. Never reach into packages/ide or packages/interface here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readRootVersion(root: string): string {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
}

/**
 * Retained as a read-only compatibility export for non-release callers. Release
 * orchestration passes the exact version to the IDE owner workflow instead of
 * mutating any desktop manifest in Studio.
 */
export function syncReleaseVersion(root: string): string {
  const version = readRootVersion(root);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`root package version is not an exact semver: ${version}`);
  }
  return version;
}
