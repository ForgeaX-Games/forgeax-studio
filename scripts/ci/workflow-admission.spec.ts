import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('root integration workflow admission', () => {
  it('retains the required compatibility context without product QA execution', () => {
    expect(workflow).toContain('name: Studio QA required gate');
    expect(workflow).toContain('integration-only gate');
    expect(workflow).toContain('studio-integration-standard');
    expect(workflow).toContain('studio-integration-smoke');
    expect(workflow).not.toContain('packages/studio-qa');
    expect(workflow).not.toContain('studio-qa run');
    expect(workflow).not.toContain('assembled-gateway');
    expect(workflow).not.toContain('studio-qa-port-lifecycle');
  });

  it('keeps public commands and root gates as the only integration surface', () => {
    expect(workflow).toContain('bun fx versions');
    expect(workflow).toContain('bun fx ide --help');
    expect(workflow).not.toContain('bun fx marketplace --help');
    expect(workflow).toContain('bun fx stop');
    expect(workflow).toContain('bun run lint:layers');
    expect(workflow).toContain('bun run test:layers');
    expect(workflow).not.toContain('scripts/build-desktop.ts');
    expect(workflow).not.toContain('scripts/run.ts');
  });

  it('runs the public web lifecycle through a full install in an isolated RuntimeInstance', () => {
    expect(workflow).toContain('name: Studio lifecycle smoke');
    expect(workflow).toContain('bun install --frozen-lockfile\n');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.INTERNAL_TOKEN }}');
    expect(workflow).toContain('studio-lifecycle-install.gitconfig');
    expect(workflow).toContain('export GIT_CONFIG_GLOBAL="$auth_config"');
    expect(workflow).toContain('bash scripts/ci/studio-lifecycle-smoke.sh');
    expect(workflow).toContain('studio-integration-lifecycle');
    expect(workflow).toContain('LIFECYCLE: ${{ needs.studio-integration-lifecycle.result }}');
  });
});
