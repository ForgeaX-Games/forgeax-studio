import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('root desktop build exit contract', () => {
  it('does not keep a root-owned desktop assembler', () => {
    expect(existsSync(resolve(ROOT, 'scripts/build-desktop.ts'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'scripts/desktop.ts'))).toBe(false);
  });

  it('does not expose a root desktop product script', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const scripts = Object.keys(packageJson.scripts ?? {});
    expect(scripts.some((name) => /desktop|studio-smoke/i.test(name))).toBe(false);
  });

  it('keeps desktop build ownership in the independent IDE repository', () => {
    expect(existsSync(resolve(ROOT, '.github/workflows/desktop-build.yml'))).toBe(false);
    expect(existsSync(resolve(ROOT, '.github/workflows/studio-qa.yml'))).toBe(false);
  });
});
