import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  hasOnlyKeys,
  isEngineCommit,
  isNonEmptyString,
  isRecord,
  isSha256,
  isStableRelativePath,
} from './contract-validation';
import {
  RUNTIME_MANIFEST_VERSION,
  type RuntimeArtifact,
  type RuntimeMachine,
  type RuntimeManifest,
} from './types';

function parseCapability(value: unknown): { script: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['script']) || !isStableRelativePath(value.script)) {
    return undefined;
  }
  return { script: value.script };
}

function parseArtifact(value: unknown): RuntimeArtifact | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'runtimeId',
    'version',
    'platform',
    'arch',
    'source',
    'sha256',
    'engineCommit',
    'capabilities',
    'format',
    'command',
    'args',
  ])) return undefined;
  if (!isNonEmptyString(value.version) || !isNonEmptyString(value.source) || !isSha256(value.sha256)) return undefined;
  if (!isEngineCommit(value.engineCommit) || !isRecord(value.capabilities)) return undefined;
  if (!hasOnlyKeys(value.capabilities, ['build', 'serve'])) return undefined;
  const build = parseCapability(value.capabilities.build);
  const serve = parseCapability(value.capabilities.serve);
  if (!build || !serve) return undefined;
  if (value.format !== undefined && value.format !== 'archive' && value.format !== 'file') return undefined;
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === 'string'))) return undefined;
  if (value.command !== undefined && !isNonEmptyString(value.command)) return undefined;
  return {
    runtimeId: isNonEmptyString(value.runtimeId) ? value.runtimeId : undefined,
    version: value.version,
    platform: typeof value.platform === 'string' ? value.platform as NodeJS.Platform | 'any' : undefined,
    arch: typeof value.arch === 'string' ? value.arch : undefined,
    source: value.source,
    sha256: value.sha256.toLowerCase(),
    engineCommit: value.engineCommit,
    capabilities: { build, serve },
    format: value.format as 'file' | 'archive' | undefined,
    command: value.command as string | undefined,
    args: value.args as string[] | undefined,
  };
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'runtimeId', 'artifacts'])
    || value.schemaVersion !== RUNTIME_MANIFEST_VERSION
  ) {
    throw new Error(`unsupported runtime manifest schema (expected ${RUNTIME_MANIFEST_VERSION})`);
  }
  if (!isNonEmptyString(value.runtimeId)) throw new Error('runtime manifest runtimeId is required');
  const runtimeId = value.runtimeId;
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error('runtime manifest artifacts must be a non-empty array');
  }
  const artifacts = value.artifacts.map(parseArtifact);
  if (artifacts.some((item) => item === undefined)) {
    throw new Error('runtime manifest contains an invalid artifact');
  }
  return { schemaVersion: RUNTIME_MANIFEST_VERSION, runtimeId, artifacts: artifacts as RuntimeArtifact[] };
}

export function readRuntimeManifest(file: string): RuntimeManifest {
  return parseRuntimeManifest(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

/** The package root is mandatory; the environment override is the sole external provisioning hook. */
export function runtimeManifestCandidates(platformRoot: string, override = process.env.FORGEAX_RUNTIME_MANIFEST): string[] {
  return [override ? resolve(override) : undefined, join(resolve(platformRoot), 'assets', 'runtime-manifest.json')]
    .filter((item): item is string => Boolean(item));
}

export function loadRuntimeManifest(platformRoot: string, override?: string): RuntimeManifest | undefined {
  for (const candidate of runtimeManifestCandidates(platformRoot, override)) {
    if (!existsSync(candidate)) continue;
    try {
      return readRuntimeManifest(candidate);
    } catch (error) {
      throw new Error(`invalid ForgeaX runtime manifest at ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

function versionSort(leftValue: string, rightValue: string): number {
  const parts = (value: string): number[] => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(leftValue);
  const right = parts(rightValue);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((right[index] ?? 0) !== (left[index] ?? 0)) return (right[index] ?? 0) - (left[index] ?? 0);
  }
  return 0;
}

export function resolveRuntimeArtifact(
  manifest: RuntimeManifest,
  version?: string,
  machine: RuntimeMachine = { platform: process.platform, arch: process.arch },
): RuntimeArtifact | undefined {
  return manifest.artifacts
    .filter((item) => item.runtimeId === undefined || item.runtimeId === manifest.runtimeId)
    .filter((item) => version === undefined || item.version === version)
    .filter((item) => item.platform === undefined || item.platform === 'any' || item.platform === machine.platform)
    .filter((item) => item.arch === undefined || item.arch === 'any' || item.arch === machine.arch)
    .sort((left, right) => {
      const score = (item: RuntimeArtifact): number =>
        (item.platform === machine.platform ? 4 : 2)
        + (item.arch === machine.arch ? 2 : 1);
      return score(right) - score(left) || versionSort(left.version, right.version);
    })[0];
}
