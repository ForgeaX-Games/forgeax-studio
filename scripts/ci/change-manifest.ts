#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const CHANGE_MANIFEST_VERSION = 'forgeax-ci-change-manifest.v1' as const;
export const RUNTIME_PLATFORMS = ['darwin-arm64', 'win32-x64', 'linux-x64'] as const;
export type RuntimePlatform = (typeof RUNTIME_PLATFORMS)[number];
export type RuntimeChangeClass =
  | 'none'
  | 'universal-js'
  | 'common'
  | 'platform-specific'
  | 'packaging-security'
  | 'full-release';

export type InputDigestFacts = {
  headSha: string;
  recursiveGitlinks: string[];
  lockfileDigest: string;
  toolchain: Record<string, string>;
  trustScope: string;
};

export type ChangeManifest = {
  specVersion: 1;
  manifestVersion: typeof CHANGE_MANIFEST_VERSION;
  identity: {
    eventName: string;
    headSha: string;
    baseSha: string;
    trustScope: string;
    inputDigest: string;
  };
  mode: 'draft-fast' | 'full';
  draft: boolean;
  changedPaths: string[];
  heavy: { run: boolean };
  studioQa: { run: boolean; deterministicSamples: 1; soakSamples: 3 };
  runtime: {
    changeClass: RuntimeChangeClass;
    run: boolean;
    runCommon: boolean;
    runUniversal: boolean;
    runNative: boolean;
    platforms: RuntimePlatform[];
    matrix: { include: Array<{ target: RuntimePlatform; runner: string | string[] }> };
  };
};

type BuildChangeManifestOptions = {
  eventName: string;
  headSha: string;
  baseSha: string;
  trustScope: string;
  draft: boolean;
  changedPaths: string[];
  inputDigest: string;
};

const SECURITY_PATH = /^(scripts\/(?:check-release-secrets|run-trufflehog-release-scan)|packages\/recursive-input-contract\/security\/)/;
const FULL_RELEASE_PATH = /^(\.github\/|scripts\/|package\.json$|bun\.lock$|\.bun-version$|\.nvmrc$|\.pnpm-version$|packages\/editor(?:\/|$))/;
const DOC_PATH = /^(?:[^/]+\.md|docs\/|\.forgeax-harness\/docs\/)/;
const STUDIO_QA_SKIP_PATH = /^(?:packages\/(?:chat|settings|dashboard|game-runtime)(?:\/|$)|deploy\/)/;

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim().replace(/^\.\//, '')).filter(Boolean))].sort();
}

function runtimeClass(paths: string[], eventName: string): { changeClass: RuntimeChangeClass; platforms: RuntimePlatform[] } {
  if (eventName !== 'pull_request') return { changeClass: 'full-release', platforms: [...RUNTIME_PLATFORMS] };
  if (paths.some((path) => SECURITY_PATH.test(path))) {
    return { changeClass: 'packaging-security', platforms: [...RUNTIME_PLATFORMS] };
  }
  if (paths.some((path) => FULL_RELEASE_PATH.test(path))) {
    return { changeClass: 'full-release', platforms: [...RUNTIME_PLATFORMS] };
  }

  const platforms = RUNTIME_PLATFORMS.filter((platform) =>
    paths.some((path) => path.startsWith(`packages/game-runtime/${platform}/`)),
  );
  if (platforms.length > 0) return { changeClass: 'platform-specific', platforms };
  if (paths.some((path) => path.startsWith('packages/game-runtime/common/'))) {
    return { changeClass: 'common', platforms: [] };
  }
  if (paths.some((path) => path.startsWith('packages/game-runtime/universal/'))) {
    return { changeClass: 'universal-js', platforms: [] };
  }
  return { changeClass: 'none', platforms: [] };
}

function platformMatrix(platforms: RuntimePlatform[]): ChangeManifest['runtime']['matrix'] {
  return {
    include: platforms.map((target) => ({
      target,
      runner: target === 'darwin-arm64'
        ? 'macos-latest'
        : target === 'win32-x64'
          ? 'windows-latest'
          : ['self-hosted', 'Linux', 'X64', 'heavy'],
    })),
  };
}

export function buildChangeManifest(options: BuildChangeManifestOptions): ChangeManifest {
  const changedPaths = uniqueSorted(options.changedPaths);
  const draft = options.eventName === 'pull_request' && options.draft;
  const classified = runtimeClass(changedPaths, options.eventName);
  const fullNative = classified.changeClass === 'full-release' || classified.changeClass === 'packaging-security';
  const runCommon = fullNative || classified.changeClass === 'common' || classified.changeClass === 'platform-specific';
  const runUniversal = fullNative || classified.changeClass === 'universal-js'
    || classified.changeClass === 'common' || classified.changeClass === 'platform-specific';
  const platforms = fullNative ? [...RUNTIME_PLATFORMS] : classified.platforms;
  const runNative = platforms.length > 0;
  const runtimeRun = classified.changeClass !== 'none' && !draft;
  const studioQaRelevant = options.eventName !== 'pull_request' || changedPaths.some((path) =>
    !DOC_PATH.test(path) && !STUDIO_QA_SKIP_PATH.test(path),
  );

  return {
    specVersion: 1,
    manifestVersion: CHANGE_MANIFEST_VERSION,
    identity: {
      eventName: options.eventName,
      headSha: options.headSha,
      baseSha: options.baseSha,
      trustScope: options.trustScope,
      inputDigest: options.inputDigest,
    },
    mode: draft ? 'draft-fast' : 'full',
    draft,
    changedPaths,
    heavy: { run: !draft },
    studioQa: { run: !draft && studioQaRelevant, deterministicSamples: 1, soakSamples: 3 },
    runtime: {
      changeClass: classified.changeClass,
      run: runtimeRun,
      runCommon: runtimeRun && runCommon,
      runUniversal: runtimeRun && runUniversal,
      runNative: runtimeRun && runNative,
      platforms: runtimeRun ? platforms : [],
      matrix: platformMatrix(runtimeRun ? platforms : []),
    },
  };
}

export function computeInputDigest(facts: InputDigestFacts): string {
  const canonical = JSON.stringify({
    headSha: facts.headSha,
    recursiveGitlinks: [...facts.recursiveGitlinks].sort(),
    lockfileDigest: facts.lockfileDigest,
    toolchain: Object.fromEntries(Object.entries(facts.toolchain).sort(([left], [right]) => left.localeCompare(right))),
    trustScope: facts.trustScope,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function collectInputDigestFacts(root: string, headSha: string, trustScope: string): InputDigestFacts {
  const gitlinks = execFileSync('git', ['ls-tree', '-r', headSha], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.match(/^160000 commit ([a-f0-9]{40})\t(.+)$/)?.slice(1))
    .filter((entry): entry is [string, string] => Array.isArray(entry))
    .map(([sha, path]) => `${path} ${sha}`)
    .sort();
  const toolchain = Object.fromEntries([
    ['bun', '.bun-version'],
    ['node', '.nvmrc'],
    ['pnpm', '.pnpm-version'],
  ].map(([name, path]) => [name, readFileSync(resolve(root, path), 'utf8').trim()]));
  return {
    headSha,
    recursiveGitlinks: gitlinks,
    lockfileDigest: sha256File(resolve(root, 'bun.lock')),
    toolchain,
    trustScope,
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${String(key)}`);
    values.set(key.slice(2), value);
  }
  return values;
}

function requireValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function appendOutputs(manifest: ChangeManifest, outputPath: string): void {
  appendFileSync(outputPath, [
    `mode=${manifest.mode}`,
    `input-digest=${manifest.identity.inputDigest}`,
    `studio-qa-run=${String(manifest.studioQa.run)}`,
    `heavy-run=${String(manifest.heavy.run)}`,
    `runtime-run=${String(manifest.runtime.run)}`,
    `runtime-class=${manifest.runtime.changeClass}`,
    `runtime-run-common=${String(manifest.runtime.runCommon)}`,
    `runtime-run-universal=${String(manifest.runtime.runUniversal)}`,
    `runtime-run-native=${String(manifest.runtime.runNative)}`,
    `runtime-platforms=${JSON.stringify(manifest.runtime.platforms)}`,
    `runtime-matrix=${JSON.stringify(manifest.runtime.matrix)}`,
  ].join('\n') + '\n');
}

function main(): void {
  const values = parseArgs(process.argv.slice(2));
  const root = resolve(values.get('root') ?? '.');
  const headSha = requireValue(values, 'head');
  const trustScope = requireValue(values, 'trust-scope');
  const output = resolve(requireValue(values, 'output'));
  const pathsFile = values.get('paths-file');
  const changedPaths = pathsFile ? readFileSync(resolve(pathsFile), 'utf8').split(/\r?\n/) : [];
  const inputDigest = computeInputDigest(collectInputDigestFacts(root, headSha, trustScope));
  const manifest = buildChangeManifest({
    eventName: requireValue(values, 'event'),
    headSha,
    baseSha: requireValue(values, 'base'),
    trustScope,
    draft: values.get('draft') === 'true',
    changedPaths,
    inputDigest,
  });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, output);
  if (process.env.GITHUB_OUTPUT) appendOutputs(manifest, process.env.GITHUB_OUTPUT);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '### Tier 0 immutable change manifest',
      '',
      `- Mode: **${manifest.mode}**`,
      `- Input digest: \`${manifest.identity.inputDigest}\``,
      `- Runtime class: **${manifest.runtime.changeClass}**`,
      `- Native platforms: ${manifest.runtime.platforms.join(', ') || 'none'}`,
      `- Deterministic Studio QA samples: ${manifest.studioQa.deterministicSamples}`,
      '',
    ].join('\n'));
  }
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

if (import.meta.main) main();
