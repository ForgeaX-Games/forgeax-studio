import {expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

test('extension pretty output preserves JSON error fields and failure exit code', () => {
  const entry=resolve(import.meta.dir,'../src/main.ts');
  const call=(pretty:boolean)=>spawnSync(process.execPath,[entry,'asset3d','doctor','--json',...(pretty?['--pretty']:[])],{cwd:tmpdir(),encoding:'utf8'});
  const compact=call(false),pretty=call(true);
  expect(compact.status).toBe(1);expect(pretty.status).toBe(1);
  expect(JSON.parse(pretty.stdout)).toEqual(JSON.parse(compact.stdout));
  expect(pretty.stdout).toContain('\n  "schemaVersion"');
  expect(compact.stdout.trim().split('\n')).toHaveLength(1);
});
