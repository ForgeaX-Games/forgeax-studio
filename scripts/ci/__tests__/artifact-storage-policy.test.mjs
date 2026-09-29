import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const submodulePins = readFileSync(resolve('.github/workflows/submodule-pins.yml'), 'utf8');
const cleanup = readFileSync(resolve('.github/workflows/actions-artifact-cleanup.yml'), 'utf8');

test('submodule prerequisite observations are transient', () => {
  assert.match(submodulePins, /name: submodule-pin-prerequisite-\$\{\{ github\.run_id \}\}/);
  assert.match(submodulePins, /retention-days: 1/);
  assert.doesNotMatch(submodulePins, /retention-days: 14/);
});

test('failed and cancelled producer runs have an artifact cleanup backstop', () => {
  assert.match(cleanup, /workflow_run:/);
  assert.match(cleanup, /- Publish Game Runtime npm packages\n\s+- nightly-e2e\n\s+- submodule-pins/);
  assert.match(cleanup, /if: github\.event\.workflow_run\.conclusion != 'success'/);
  assert.match(cleanup, /actions: write/);
  assert.match(cleanup, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(cleanup, /--run-id "\$SOURCE_RUN_ID"/);
});
