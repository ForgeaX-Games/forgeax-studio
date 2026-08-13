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
    expect(source).toContain('sync-package-harness.mjs');
    expect(source).toContain('required-checks ruleset audit');
    expect(source).toContain('scripts/ci/audit-required-checks-ruleset.mjs');
    expect(source).toContain('editor engine setup');
    expect(source).toContain('function editorCiEnvironment(');
    expect(source).toContain("CI: '1'");
    expect(source).toContain('FORGEAX_E2E_ENGINE_PORT');
    expect(source).toContain('FORGEAX_E2E_BRIDGE_PORT');
    expect(source).toContain('editor PR CI projection');
    expect(source).not.toContain('test/template-catalog.test.ts');
    expect(source).toContain('games floating checkout contract');
    expect(source).toContain('sync-package-harness.mjs');
    expect(source).toContain('source Studio harness checkout is unavailable');
    expect(source).toContain("CI: process.env.CI ?? 'true'");
    expect(source).toContain('FORGEAX_E2E_PORT');
    expect(source).toContain('FORGEAX_E2E_TEMPLATE_PORT');
    expect(source).toContain('FORGEAX_E2E_TEMPLATE_BRIDGE_PORT');
    expect(source).toContain('FORGEAX_SKIP_GAMES');
    expect(source).toContain('[ci] PASS: local Studio PR CI');
  });
});
