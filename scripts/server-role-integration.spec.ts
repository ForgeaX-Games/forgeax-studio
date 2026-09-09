import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('root service wrapper contract', () => {
  it('keeps only a public service command wrapper in the root', () => {
    const run = read('scripts/run.ts');
    const stop = read('scripts/stop.ts');
    expect(run).toContain('Public');
    expect(stop).toContain('Public');
    expect(run).not.toMatch(/packages\/(studio|interface)\/src|packages\/server\/src/);
    expect(stop).not.toMatch(/packages\/(studio|interface)\/src|packages\/server\/src/);
  });

  it('does not make the root a server implementation host', () => {
    expect(existsSync(resolve(ROOT, 'packages/server/src'))).toBe(true);
    expect(read('scripts/run.ts')).not.toContain('activeServer.packageDir');
    expect(read('scripts/stop.ts')).not.toContain('activeServer.packageDir');
  });
});
