import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_RUNTIME_ID,
  RUNTIME_MANIFEST_VERSION,
  type RuntimeArtifact,
  type RuntimeMachine,
  type RuntimeManifest,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseArtifact(value: unknown): RuntimeArtifact | undefined {
  if (!isRecord(value) || typeof value.version !== 'string') return undefined;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) return undefined;
  const source = typeof value.source === 'string' ? value.source : undefined;
  if (!source) return undefined;
  if (value.format !== undefined && value.format !== 'archive' && value.format !== 'file') return undefined;
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === 'string'))) return undefined;
  return {
    runtimeId: typeof value.runtimeId === 'string' ? value.runtimeId : undefined,
    version: value.version,
    platform: typeof value.platform === 'string' ? value.platform as NodeJS.Platform | 'any' : undefined,
    arch: typeof value.arch === 'string' ? value.arch : undefined,
    source,
    sha256: value.sha256.toLowerCase(),
    format: value.format as 'file' | 'archive' | undefined,
    command: typeof value.command === 'string' ? value.command : undefined,
    args: value.args as string[] | undefined,
  };
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value) || value.schemaVersion !== RUNTIME_MANIFEST_VERSION) {
    throw new Error(`unsupported runtime manifest schema (expected ${RUNTIME_MANIFEST_VERSION})`);
  }
  const runtimeId = typeof value.runtimeId === 'string' && value.runtimeId.length > 0
    ? value.runtimeId
    : DEFAULT_RUNTIME_ID;
  if (!Array.isArray(value.artifacts)) throw new Error('runtime manifest artifacts must be an array');
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
