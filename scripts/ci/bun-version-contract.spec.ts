import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUN_VERSION = '1.4.2';
const PACKAGE_MANAGER = `bun@${BUN_VERSION}`;
const MANIFESTS = ['package.json'] as const;
const WORKFLOW_ROOTS = ['.github/workflows', 'scripts/mirror/ci', 'scripts/mirror/oss-assets/.github/workflows'] as const;

function workflowFiles(directory: string): string[] {
  const absolute = join(ROOT, directory);
  try {
    return readdirSync(absolute).flatMap((name) => {
      const path = join(absolute, name);
      if (statSync(path).isDirectory()) return workflowFiles(relative(ROOT, path));
      return /\.ya?ml$/.test(name) ? [path] : [];
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

describe('Bun 1.4 toolchain contract', () => {
  test('pins the root version file and every hydrated integration-owned package manager', () => {
    expect(readFileSync(join(ROOT, '.bun-version'), 'utf8').trim()).toBe(BUN_VERSION);
    for (const path of MANIFESTS) {
      const absolute = join(ROOT, path);
      if (!existsSync(absolute)) continue;
      const manifest = JSON.parse(readFileSync(absolute, 'utf8')) as { packageManager?: string };
      expect(manifest.packageManager, path).toBe(PACKAGE_MANAGER);
    }
  });

  test('requires a fixed Bun toolchain for each workflow owner', () => {
    const workflows = [...new Set(WORKFLOW_ROOTS.flatMap(workflowFiles))];
    let setupCount = 0;
    for (const path of workflows) {
      const source = readFileSync(path, 'utf8');
      const lines = source.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.includes('uses: oven-sh/setup-bun@')) continue;
        setupCount += 1;
        const configuration = lines.slice(index + 1, index + 7).join('\n');
        expect(configuration, relative(ROOT, path)).toMatch(
          /bun-version:\s*['"]?1\.4\.\d+['"]?|bun-version-file:/,
        );
      }
      expect(source, relative(ROOT, path)).not.toMatch(/bun-version:\s*['"]?(?:latest|1\.3\.14)/);
    }
    expect(setupCount).toBeGreaterThan(0);
  });
});
