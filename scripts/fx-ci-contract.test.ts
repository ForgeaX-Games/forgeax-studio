import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(resolve(import.meta.dir, 'fx.ts'), 'utf8');

describe('bun fx ci local gate', () => {
  test('registers and documents the local Studio CI command', () => {
    expect(source).toContain("'ci'");
    expect(source).toContain('function ci(');
    expect(source).toContain('Run the local Studio PR CI surface');
    expect(source).toContain('test:studio-smoke-contract');
    expect(source).toContain('test/game-templates.test.ts');
    expect(source).toContain('test/workbench-create-game-default.test.ts');
    expect(source).toContain('test/workbench-link-idempotency.test.ts');
    expect(source).not.toContain('test/template-catalog.test.ts');
    expect(source).toContain('games floating checkout contract');
    expect(source).toContain('FORGEAX_SKIP_GAMES');
    expect(source).toContain('[ci] PASS: local Studio PR CI');
  });
});
