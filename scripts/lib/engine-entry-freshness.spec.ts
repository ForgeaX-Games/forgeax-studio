import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_ENTRY_OUTPUTS, isEngineEntryDistFresh } from './engine-entry-freshness.ts';

const roots: string[] = [];
const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);

function fixture(): { packageDir: string; sentinel: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-freshness-'));
  roots.push(root);
  const packageDir = join(root, 'app');
  const distDir = join(packageDir, 'dist');
  const sourceDir = join(packageDir, 'src');
  const sentinel = join(root, 'engine-declarations.built');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, 'index.ts');
  writeFileSync(source, 'export const value = 1;\n');
  for (const output of ENGINE_ENTRY_OUTPUTS) writeFileSync(join(distDir, output), 'built\n');
  return { packageDir, sentinel, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine entry freshness', () => {
  it('accepts an unchanged declaration validated by a successful incremental build', () => {
    const { packageDir, sentinel, source } = fixture();
    at(join(packageDir, 'dist/index.d.ts'), 100);
    at(source, 200);
    at(join(packageDir, 'dist/index.mjs'), 300);
    writeFileSync(sentinel, 'ok\n');
    at(sentinel, 300);

    expect(isEngineEntryDistFresh(packageDir, sentinel)).toBe(true);
  });

  it('rejects the same timestamps without a successful declaration-build sentinel', () => {
    const { packageDir, sentinel, source } = fixture();
    at(join(packageDir, 'dist/index.d.ts'), 100);
    at(source, 200);
    at(join(packageDir, 'dist/index.mjs'), 300);

    expect(isEngineEntryDistFresh(packageDir, sentinel)).toBe(false);
  });

  it('rejects source changes made after either build proof', () => {
    const { packageDir, sentinel, source } = fixture();
    at(join(packageDir, 'dist/index.d.ts'), 100);
    at(join(packageDir, 'dist/index.mjs'), 300);
    writeFileSync(sentinel, 'ok\n');
    at(sentinel, 300);
    at(source, 400);

    expect(isEngineEntryDistFresh(packageDir, sentinel)).toBe(false);
  });
});
