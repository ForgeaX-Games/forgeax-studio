import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

describe('release branch governance workflow', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release-branch-governance.yml'), 'utf8');
  const contract = JSON.parse(readFileSync(join(root, '.github/release-branch-ruleset.json'), 'utf8'));

  test('runs trusted reconciliation and can create the main PR', () => {
    expect(workflow).toContain("cron: '*/5 * * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('matching-refs/heads/release');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('issues: read');
    expect(workflow).toContain('bun scripts/ci/release-branch-governance.ts');
  });

  test('declares a no-bypass commit-message gate for release branches', () => {
    expect(contract.target).toBe('branch');
    expect(contract.enforcement).toBe('active');
    expect(contract.bypass_actors).toEqual([]);
    expect(contract.conditions.ref_name.include).toEqual(['refs/heads/release*', 'refs/heads/release*/*', 'refs/heads/release*/**/*']);
    expect(contract.rules).toContainEqual(expect.objectContaining({ type: 'commit_message_pattern' }));
  });
});
