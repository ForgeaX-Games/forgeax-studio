import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_ENTRY_OUTPUTS,
  areEnginePrepareArtifactsFresh,
  collectMissingEngineArtifacts,
  formatMissingEngineArtifacts,
  isEngineEntryDistFresh,
  isValidNodeMjsArtifact,
} from './engine-entry-freshness.ts';

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

function prepareFixture(): {
  enginePkgDir: string;
  sentinel: string;
  devkitCli: string;
  devkitSource: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-prepare-freshness-'));
  roots.push(root);
  const enginePkgDir = join(root, 'packages');
  const appDir = join(enginePkgDir, 'app');
  const devkitDir = join(enginePkgDir, 'devkit');
  const sentinel = join(root, 'engine-declarations.built');
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'src'), { recursive: true });
  mkdirSync(join(devkitDir, 'dist'), { recursive: true });
  mkdirSync(join(devkitDir, 'src'), { recursive: true });
  writeFileSync(join(appDir, 'src/index.ts'), 'export const value = 1;\n');
  writeFileSync(join(appDir, 'dist/index.mjs'), 'export const value = 1;\n');
  writeFileSync(join(appDir, 'dist/index.d.ts'), 'export declare const value: 1;\n');
  const devkitSource = join(devkitDir, 'src/cli.ts');
  const devkitCli = join(devkitDir, 'dist/cli.mjs');
  writeFileSync(devkitSource, 'console.log("Usage: forgeax");\n');
  writeFileSync(devkitCli, '#!/usr/bin/env node\nconsole.log("Usage: forgeax");\n');
  writeFileSync(sentinel, 'ok\n');
  for (const path of [join(appDir, 'dist/index.mjs'), join(appDir, 'dist/index.d.ts'), devkitCli, sentinel]) at(path, 300);
  at(join(appDir, 'src/index.ts'), 100);
  at(devkitSource, 100);
  return { enginePkgDir, sentinel, devkitCli, devkitSource };
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

  it('rejects a missing custom output even when the default entries are fresh', () => {
    const { packageDir, source } = fixture();
    at(source, 100);
    at(join(packageDir, 'dist/index.mjs'), 200);
    at(join(packageDir, 'dist/index.d.ts'), 200);

    expect(isEngineEntryDistFresh(packageDir, '', ['cli.mjs'])).toBe(false);
  });

  it('rejects a custom output older than its source', () => {
    const { packageDir, source } = fixture();
    const cli = join(packageDir, 'dist/cli.mjs');
    writeFileSync(cli, 'built\n');
    at(cli, 200);
    at(source, 300);

    expect(isEngineEntryDistFresh(packageDir, '', ['cli.mjs'])).toBe(false);
  });

  it('rejects an empty or unparsable Node output', () => {
    const { packageDir, source } = fixture();
    const cli = join(packageDir, 'dist/cli.mjs');
    writeFileSync(cli, '');
    at(source, 100);
    at(cli, 200);
    expect(isEngineEntryDistFresh(packageDir, '', ['cli.mjs'], isValidNodeMjsArtifact)).toBe(false);

    writeFileSync(cli, 'export const = ;\n');
    at(cli, 200);
    expect(isEngineEntryDistFresh(packageDir, '', ['cli.mjs'], isValidNodeMjsArtifact)).toBe(false);
  });

  it('rejects the prepare cache when DevKit CLI is missing', () => {
    const { enginePkgDir, sentinel, devkitCli } = prepareFixture();
    rmSync(devkitCli);
    expect(areEnginePrepareArtifactsFresh(enginePkgDir, ['app'], sentinel)).toBe(false);
  });

  it('rejects the prepare cache when DevKit CLI source is newer', () => {
    const { enginePkgDir, sentinel, devkitSource } = prepareFixture();
    at(devkitSource, 400);
    expect(areEnginePrepareArtifactsFresh(enginePkgDir, ['app'], sentinel)).toBe(false);
  });

  it('accepts the complete prepare cache only with a valid DevKit CLI', () => {
    const { enginePkgDir, sentinel } = prepareFixture();
    expect(areEnginePrepareArtifactsFresh(enginePkgDir, ['app'], sentinel)).toBe(true);
  });

  it('executes the complete-setup artifact boundary for invalid DevKit output', () => {
    const { devkitCli } = prepareFixture();
    const requiredPaths = [devkitCli];
    writeFileSync(devkitCli, 'export const = ;\n');

    const missing = collectMissingEngineArtifacts(requiredPaths, [devkitCli]);
    expect(missing).toEqual([devkitCli]);
    expect(formatMissingEngineArtifacts(missing, 'FORGEAX_FORCE_PREPARE=1 bun run prepare'))
      .toContain(`retry: FORGEAX_FORCE_PREPARE=1 bun run prepare`);

    writeFileSync(devkitCli, '#!/usr/bin/env node\nconsole.log("Usage: forgeax");\n');
    expect(collectMissingEngineArtifacts(requiredPaths, [devkitCli])).toEqual([]);
  });
});
