import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourcePath = resolve('scripts/ci/delete-workflow-artifacts.mjs');

function runFixture({ listFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-studio-delete-artifacts-'));
  const binDir = join(root, 'bin');
  const logPath = join(root, 'gh.log');
  const fakeGh = join(binDir, 'gh');
  mkdirSync(binDir);
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--paginate')) {
  if (process.env.GH_TEST_LIST_FAIL === '1') process.exit(1);
  process.stdout.write('101\\n102\\n');
  process.exit(0);
}
if (args.includes('--method') && args.includes('DELETE')) {
  require('node:fs').appendFileSync(process.env.GH_TEST_LOG, args.at(-1) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(fakeGh, 0o755);
  const result = spawnSync(process.execPath, [sourcePath, '--run-id', '123'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '999',
      GH_TOKEN: 'fixture-token',
      GH_TEST_LIST_FAIL: listFails ? '1' : '0',
      GH_TEST_LOG: logPath,
    },
  });
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  rmSync(root, { recursive: true, force: true });
  return { ...result, log };
}

test('deletes every artifact from the specified source run', () => {
  const fixture = runFixture();
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /transient artifacts deleted: 2; failed deletions: 0/);
  assert.deepEqual(fixture.log.trim().split('\n'), [
    'repos/owner/repo/actions/artifacts/101',
    'repos/owner/repo/actions/artifacts/102',
  ]);
});

test('does not fail the cleanup backstop when listing is unavailable', () => {
  const fixture = runFixture({ listFails: true });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /could not list transient artifacts/);
});
