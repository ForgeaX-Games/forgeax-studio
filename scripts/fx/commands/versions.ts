import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function publicVersions(root: string): Record<string, unknown> {
  const rootRevision = git(root, ['rev-parse', 'HEAD']);
  const pins = git(root, ['submodule', 'status', '--recursive'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return { path: parts[1] ?? '', revision: (parts[0] ?? '').replace(/^[-+]/, '') };
    });
  return { schemaVersion: 1, rootRevision, pins };
}

export function printPublicVersions(root = resolve(import.meta.dir, '../../..')): number {
  console.log(JSON.stringify(publicVersions(root), null, 2));
  return 0;
}
