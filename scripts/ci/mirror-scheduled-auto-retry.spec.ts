import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../..');
const workflow = readFileSync(join(root, '.github/workflows/mirror-scheduled-auto-retry.yml'), 'utf8');

describe('scheduled mirror automatic retry', () => {
  test('observes only completed mirror-multi runs on main', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [mirror-multi]');
    expect(workflow).toContain('types: [completed]');
    expect(workflow).toContain('branches: [main]');
  });

  test('retries only the first failed schedule attempt', () => {
    expect(workflow).toContain("github.event.workflow_run.event == 'schedule'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(workflow).toContain('github.event.workflow_run.run_attempt == 1');
    expect(workflow).not.toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(workflow).not.toContain("github.event.workflow_run.conclusion == 'cancelled'");
  });

  test('requests one full rerun with the minimum write permission', () => {
    expect(workflow).toContain('actions: write');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('SOURCE_RUN_ID: ${{ github.event.workflow_run.id }}');
    expect(workflow).toContain('actions/runs/${SOURCE_RUN_ID}/rerun');
    expect(workflow).not.toContain('rerun-failed-jobs');
    expect(workflow).not.toContain('git push');
    expect(workflow).not.toContain('actions/checkout');
  });
});
