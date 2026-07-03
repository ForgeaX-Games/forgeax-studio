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

  it('updates submodules one by one and reports failures at the end', () => {
    const setupSource = readFileSync(join(ROOT, 'scripts/setup.ts'), 'utf8');

    expect(setupSource).toContain('formatSetupReport(setupResults)');
    expect(setupSource).toContain("['submodule', 'update', '--init', '--recursive', ...depth, '--', path]");
    expect(setupSource).not.toContain("fail('git submodule update failed.')");
  });

  it('does not checkout submodule branches during setup', () => {
    const setupSource = readFileSync(join(ROOT, 'scripts/setup.ts'), 'utf8');

    expect(setupSource).not.toContain("submodule', 'foreach");
    expect(setupSource).not.toContain('git checkout main');
    expect(setupSource).not.toContain('git branch -f main');
    expect(setupSource).not.toContain('aligned to local main');
  });
});
