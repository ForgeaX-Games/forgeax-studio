import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(here, 'marketplace.data.json');

test('the reviewed public extension snapshot is deterministic and uses current identities', async () => {
  const data = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const keys = Object.keys(data);

  assert.ok(keys.length > 0, 'the public extension snapshot must not be empty');
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
  for (const [slug, entry] of Object.entries(data)) {
    assert.equal(entry.slug, slug);
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.repository, 'string');
  }
  assert.doesNotMatch(JSON.stringify(data), /workbench|(?:^|["/])wb[-_]/iu);
});
