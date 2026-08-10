import { existsSync, readFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_ID, RUNTIME_MANIFEST_VERSION, type RuntimeArtifact, type RuntimeManifest } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function artifact(value: unknown): RuntimeArtifact | undefined {
  if (!isRecord(value) || typeof value.version !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) return undefined;
  const source = typeof value.source === 'string' ? value.source : typeof value.url === 'string' ? value.url : undefined;
  if (!source) return undefined;
  return {
    runtimeId: typeof value.runtimeId === 'string' ? value.runtimeId : undefined,
    version: value.version,
    platform: typeof value.platform === 'string' ? (value.platform as NodeJS.Platform | 'any') : undefined,
    arch: typeof value.arch === 'string' ? value.arch : undefined,
    source,
    sha256: value.sha256.toLowerCase(),
    format: value.format === 'archive' ? 'archive' : 'file',
    command: typeof value.command === 'string' ? value.command : undefined,
    args: Array.isArray(value.args) && value.args.every((item) => typeof item === 'string') ? value.args : undefined,
  };
}

/** Parse and validate a distribution manifest before it can influence a launch. */
export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value) || value.schemaVersion !== RUNTIME_MANIFEST_VERSION) {
    throw new Error(`unsupported runtime manifest schema (expected ${RUNTIME_MANIFEST_VERSION})`);
  }
  const runtimeId = typeof value.runtimeId === 'string' && value.runtimeId.length > 0 ? value.runtimeId : DEFAULT_RUNTIME_ID;
  if (!Array.isArray(value.artifacts)) throw new Error('runtime manifest artifacts must be an array');
  const artifacts = value.artifacts.map(artifact).filter((item): item is RuntimeArtifact => item !== undefined);
  if (artifacts.length !== value.artifacts.length) throw new Error('runtime manifest contains an invalid artifact');
  return { schemaVersion: RUNTIME_MANIFEST_VERSION, runtimeId, artifacts };
}

export function readRuntimeManifest(file: string): RuntimeManifest {
  return parseRuntimeManifest(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

/** Locate a manifest without requiring a Studio checkout. */
function bundledPluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith('/runtime') || here.endsWith('\\runtime') ? resolve(here, '../..') : resolve(here, '..');
}

export function runtimeManifestCandidates(pluginRoot = bundledPluginRoot()): string[] {
  return [
    process.env.FORGEAX_RUNTIME_MANIFEST,
    join(pluginRoot, 'assets', 'runtime-manifest.json'),
    join(homedir(), '.forgeax', 'runtime-manifest.json'),
  ].filter((item): item is string => Boolean(item));
}

export function runtimeManifestRoot(pluginRoot = bundledPluginRoot()): string {
  return resolve(pluginRoot);
}

export function loadRuntimeManifest(pluginRoot?: string): RuntimeManifest | undefined {
  for (const candidate of runtimeManifestCandidates(pluginRoot)) {
    if (!existsSync(candidate)) continue;
    try {
      return readRuntimeManifest(candidate);
    } catch (error) {
      throw new Error(`invalid ForgeaX runtime manifest at ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

function versionSort(a: RuntimeArtifact, b: RuntimeArtifact): number {
  const parse = (value: string): number[] => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a.version);
  const right = parse(b.version);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((right[i] ?? 0) !== (left[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0);
  }
  return 0;
}

/** Select an artifact for this machine, preferring exact platform/arch matches. */
export function resolveRuntimeArtifact(
  manifest: RuntimeManifest,
  version?: string,
  machine = { platform: platform(), arch: arch() },
): RuntimeArtifact | undefined {
  return manifest.artifacts
    .filter((item) => item.runtimeId === undefined || item.runtimeId === manifest.runtimeId)
    .filter((item) => version === undefined || item.version === version)
    .filter((item) => item.platform === undefined || item.platform === 'any' || item.platform === machine.platform)
    .filter((item) => item.arch === undefined || item.arch === 'any' || item.arch === machine.arch)
    .sort((a, b) => {
      const platformScore = (b.platform === machine.platform ? 2 : b.platform === undefined || b.platform === 'any' ? 1 : 0) - (a.platform === machine.platform ? 2 : a.platform === undefined || a.platform === 'any' ? 1 : 0);
      if (platformScore) return platformScore;
      return versionSort(a, b);
    })[0];
}
