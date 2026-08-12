import { join, resolve } from 'node:path';
import { installRuntime, listInstalledRuntimes, readInstalledRuntime, runtimeCacheRoot } from './cache';
import { runtimeEnvironment, type RuntimeEnvOverrides } from './env';
import { loadRuntimeManifest, resolveRuntimeArtifact } from './manifest';
import { DEFAULT_RUNTIME_ID, type InstalledRuntime, type RuntimeLauncher, type RuntimeMachine } from './types';

export interface ResolveRuntimeOptions {
  readonly version?: string;
  readonly runtimeId?: string;
  readonly cacheRoot?: string;
  readonly machine?: RuntimeMachine;
}

export interface EnsureRuntimeOptions extends ResolveRuntimeOptions {
  readonly platformRoot: string;
  readonly manifestPath?: string;
}

export function resolveInstalledRuntime(options: ResolveRuntimeOptions = {}): InstalledRuntime | undefined {
  const runtimeId = options.runtimeId ?? DEFAULT_RUNTIME_ID;
  const machine = options.machine ?? { platform: process.platform, arch: process.arch };
  const cacheRoot = options.cacheRoot ?? runtimeCacheRoot();
  if (options.version) return readInstalledRuntime(runtimeId, options.version, machine, cacheRoot);
  return listInstalledRuntimes(runtimeId, machine, cacheRoot)[0];
}

export async function ensureRuntime(options: EnsureRuntimeOptions): Promise<InstalledRuntime> {
  const platformRoot = resolve(options.platformRoot);
  const manifest = loadRuntimeManifest(platformRoot, options.manifestPath);
  if (!manifest) {
    const installed = resolveInstalledRuntime(options);
    if (installed) return installed;
    throw new Error(`no ForgeaX runtime manifest exists under the platform package root: ${platformRoot}`);
  }
  const runtimeId = options.runtimeId ?? manifest.runtimeId;
  const machine = options.machine ?? { platform: process.platform, arch: process.arch };
  const artifact = resolveRuntimeArtifact(manifest, options.version, machine);
  if (!artifact) {
    throw new Error(`no runtime artifact matches ${runtimeId}${options.version ? `@${options.version}` : ''} for ${machine.platform}/${machine.arch}`);
  }
  const installed = resolveInstalledRuntime({ ...options, runtimeId, version: artifact.version, machine });
  if (installed?.sha256 === artifact.sha256.toLowerCase()) return installed;
  return installRuntime(artifact, {
    runtimeId,
    cacheRoot: options.cacheRoot,
    sourceRoot: join(platformRoot, 'assets'),
    machine,
  });
}

export function launcherForRuntime(
  runtime: InstalledRuntime,
  overrides: RuntimeEnvOverrides = {},
): RuntimeLauncher {
  const command = runtime.command.includes('/') || runtime.command.includes('\\')
    ? resolve(runtime.root, runtime.command)
    : join(runtime.root, runtime.command);
  return {
    runtime,
    command,
    args: runtime.args,
    cwd: runtime.root,
    env: runtimeEnvironment({
      ...overrides,
      FORGEAX_RUNTIME_VERSION: runtime.version,
      FORGEAX_RESOURCE_ROOT: runtime.root,
      FORGEAX_STARTUP_PROFILE: overrides.FORGEAX_STARTUP_PROFILE ?? 'desktop-prod',
    }),
  };
}
