import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'build-marketplace-ledger.mjs');
const CATALOG = path.join(HERE, '..', '..', 'packages', 'marketplace', 'catalog', 'extension-identities.json');

async function run(catalog) {
  const root = await mkdtemp(path.join(tmpdir(), 'marketplace-identities-'));
  const catalogFile = path.join(root, 'catalog.json');
  const outputFile = path.join(root, 'output.json');
  await writeFile(catalogFile, `${JSON.stringify(catalog)}\n`);
  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, MARKETPLACE_CATALOG: catalogFile, MARKETPLACE_DATA_OUT: outputFile },
    stdio: 'ignore',
  });
  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    data: JSON.parse(await readFile(outputFile, 'utf8')),
  };
}

test('derives public metadata from the identity ledger without implementation checkouts', async (t) => {
  const fixture = await run({
    schemaVersion: 1,
    extensions: [{
      directory: 'character',
      repository: 'forgeax-ex-character',
      sourcePath: '.',
      package: '@forgeax-extension/character',
      canonicalIdentity: '@forgeax-extension/character',
      manifestId: '@forgeax-extension/character',
      version: '1.2.3',
      owner: 'ForgeaX-Games',
      sourceVisibility: 'public',
      npmVisibility: 'public',
      hostCompatibility: 'compatible',
      disposition: 'independent',
    }, { directory: '_template', disposition: 'excluded' }],
  });
  t.after(fixture.cleanup);
  assert.deepEqual(Object.keys(fixture.data), ['character']);
  assert.equal(fixture.data.character.kind, 'authoring');
  assert.equal(fixture.data.character.id, '@forgeax-extension/character');
  assert.equal(fixture.data.character.repoUrl, 'https://github.com/ForgeaX-Games/forgeax-ex-character');
});

test('the canonical snapshot is deterministic and contains no retired identity vocabulary', async (t) => {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const first = await run(catalog);
  const second = await run(catalog);
  t.after(first.cleanup);
  t.after(second.cleanup);
  assert.deepEqual(second.data, first.data);
  assert.doesNotMatch(JSON.stringify(first.data), /workbench|(?:^|["/])wb[-_]/iu);
});
