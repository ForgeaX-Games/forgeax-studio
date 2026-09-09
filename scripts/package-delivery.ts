#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadArtifact } from './package-delivery/artifact-downloader.ts';
import { validatePackageManifest, type PackageProfile, type PackageSizeBaseline } from './package-delivery/package-contract.ts';
import { describePackSmoke, runPackSmoke } from './package-delivery/pack-smoke.ts';
import {
  findSourceReachIns,
  newReachIns,
  sourceReachInFingerprint,
  type SourceFile,
  type SourceReachIn,
} from './package-delivery/source-reach-ins.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = new Set<PackageProfile>(['library', 'bin', 'extension']);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) index += 1;
    else values.push(args[index]);
  }
  return values;
}

function profile(value: string | undefined): PackageProfile {
  if (!value || !PROFILES.has(value as PackageProfile)) throw new Error('profile must be library, bin, or extension');
  return value as PackageProfile;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function sourceFiles(): SourceFile[] {
  const allowed = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);
  return git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    .filter((path) => allowed.has(extname(path)))
    .filter((path) => extname(path) !== '.json' || basename(path) === 'package.json' || basename(path).startsWith('tsconfig'))
    .filter((path) => !/(?:^|\/)(?:test|tests|docs|fixtures)(?:\/|$)|\.(?:spec|test)\.[^.]+$/u.test(path))
    .filter((path) => existsSync(resolve(ROOT, path)))
    .map((path) => ({ path, content: readFileSync(resolve(ROOT, path), 'utf8') }));
}

function gitlinks(): string[] {
  return git(['ls-files', '-s']).split(/\r?\n/u)
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1));
}

interface ReachInBaseline {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly revision: string;
  readonly findingCount: number;
  readonly fingerprints: readonly string[];
}

interface ReachInReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly revision: string;
  readonly gitlinks: readonly string[];
  readonly findings: readonly SourceReachIn[];
}

function collectReachIns(): ReachInReport {
  const links = gitlinks();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision: git(['rev-parse', 'HEAD']),
    gitlinks: links,
    findings: findSourceReachIns({ gitlinks: links, files: sourceFiles() }),
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'health') {
    const [profileValue, directory = '.'] = positional(args);
    const packageDirectory = resolve(ROOT, directory);
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
    const issues = validatePackageManifest(manifest, {
      profile: profile(profileValue),
      expectedTag: option(args, '--tag'),
      extensionManifestPresent: existsSync(resolve(packageDirectory, 'forgeax-extension.json')),
    });
    console.log(JSON.stringify({ schemaVersion: 1, packageDirectory, issues }, null, 2));
    if (issues.length > 0) process.exit(1);
    return;
  }
  if (command === 'pack-smoke') {
    const [profileValue, directory = '.'] = positional(args);
    const baselinePath = option(args, '--size-baseline');
    const baselineFile = baselinePath ? JSON.parse(readFileSync(resolve(ROOT, baselinePath), 'utf8')) : undefined;
    const packageName = JSON.parse(readFileSync(resolve(ROOT, directory, 'package.json'), 'utf8')).name as string;
    const sizeBaseline = baselineFile?.packages?.[packageName] as PackageSizeBaseline | undefined;
    const report = runPackSmoke({
      packageDirectory: resolve(ROOT, directory),
      profile: profile(profileValue),
      expectedTag: option(args, '--tag'),
      smokeCommand: option(args, '--smoke-command'),
      sizeBaseline,
    });
    console.log(JSON.stringify(report, null, 2));
    console.error(`[pack-smoke] ${describePackSmoke(report)}`);
    return;
  }
  if (command === 'source-reach-ins') {
    const [verb] = positional(args);
    const baselinePath = resolve(ROOT, option(args, '--baseline') ?? 'scripts/package-delivery/source-reach-in-baseline.v1.json');
    const current = collectReachIns();
    if (verb === 'baseline') {
      const baseline: ReachInBaseline = {
        schemaVersion: 1,
        generatedAt: current.generatedAt,
        revision: current.revision,
        findingCount: current.findings.length,
        fingerprints: current.findings.map(sourceReachInFingerprint).sort(),
      };
      writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
      console.log(`wrote ${current.findings.length} source reach-ins to ${baselinePath}`);
      return;
    }
    if (verb === 'check') {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as ReachInBaseline;
      const introduced = newReachIns(current.findings, baseline.fingerprints);
      console.log(JSON.stringify({ ...current, baseline: baselinePath, introduced }, null, 2));
      if (introduced.length > 0) process.exit(1);
      return;
    }
    throw new Error('source-reach-ins requires baseline or check');
  }
  if (command === 'artifact-fetch') {
    const [manifestPath] = positional(args);
    if (!manifestPath) throw new Error('artifact-fetch requires a manifest path');
    const manifest = JSON.parse(readFileSync(resolve(ROOT, manifestPath), 'utf8'));
    const path = await downloadArtifact(manifest, {
      cacheRoot: resolve(ROOT, option(args, '--cache-root') ?? '.forgeax/artifacts'),
    });
    console.log(path);
    return;
  }
  throw new Error('usage: package-delivery.ts <health|pack-smoke|source-reach-ins|artifact-fetch> ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
