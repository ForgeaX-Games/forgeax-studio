import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('setup git configuration', () => {
  it('does not enable recursive submodule operations for later git pull commands', () => {
    const setupSource = readFileSync(join(ROOT, 'scripts/setup.ts'), 'utf8');

    expect(setupSource).not.toContain("['config', 'submodule.recurse', 'true']");
    expect(setupSource).not.toContain('submodule.recurse');
  });
});
