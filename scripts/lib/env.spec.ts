import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDotenv } from './env.ts';

const directories: string[] = [];
const originalTestSecret = process.env.FORGEAX_TEST_SECRET;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalTestSecret === undefined) delete process.env.FORGEAX_TEST_SECRET;
  else process.env.FORGEAX_TEST_SECRET = originalTestSecret;
});

describe('readDotenv', () => {
  test('reads dotenv without changing process.env', () => {
    const directory = join(tmpdir(), `forgeax-dotenv-${crypto.randomUUID()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, '.env');
    writeFileSync(file, 'FORGEAX_TEST_SECRET=pure-read\n');
    delete process.env.FORGEAX_TEST_SECRET;

    expect(readDotenv(file)).toEqual({ FORGEAX_TEST_SECRET: 'pure-read' });
    expect(process.env.FORGEAX_TEST_SECRET).toBeUndefined();
  });
});
