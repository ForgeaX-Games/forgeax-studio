import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(resolve(import.meta.dir, 'fx.ts'), 'utf8');

describe('bun fx ci local gate', () => {
  test('registers and documents the local Studio CI command', () => {
    expect(source).toContain("'ci'");
    expect(source).toContain('function ci(');
    expect(source).toContain('integration workspace');
    expect(source).toContain('root frozen Bun install + integration prepare');
    expect(source).toContain('root layer gate');
    expect(source).toContain('root integration tests');
    expect(source).toContain('required-checks ruleset audit');
    expect(source).toContain('scripts/ci/audit-required-checks-ruleset.mjs');
    expect(source).toContain('root cutover contract');
    expect(source).toContain('public wrapper discovery');
    expect(source).toContain("[script('fx.ts'), 'ide', 'ci']");
    expect(source).toContain('FORGEAX_ROOT_INTEGRATION_ONLY');
    expect(source).toContain('FORGEAX_SKIP_SUBMODULE_INIT');
    expect(source).toContain("CI: process.env.CI ?? 'true'");
    expect(source).toContain('[ci] PASS: local Studio integration CI');
    expect(source).not.toContain('packages/server');
    expect(source).not.toContain('packages/editor');
  });

  test('registers the release integrity command family without external mutation', () => {
    expect(source).toContain('release-integrity');
    expect(source).toContain('executeReleaseIntegrityCli');
    expect(source).toContain('schema/status/verify');
  });
});
