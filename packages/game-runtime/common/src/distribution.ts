import { resolve } from 'node:path';
import { runtimeCacheRoot as defaultRuntimeCacheRoot } from './cache';
import { engineSdkRoot, installEngineSdkFrom } from './engine-sdk';
import { runtimeEnvironment } from './env';
import { loadRuntimeManifest } from './manifest';
import { ensureRuntime, launcherForRuntime, resolveInstalledRuntime } from './manager';
import { allocatePort, allocateRuntimePorts } from './ports';
import type { EngineSdkInstall, InstalledRuntime, RuntimeLauncher, RuntimeMachine } from './types';

export interface RuntimeDistributionOptions {
  readonly platformRoot: string;
  readonly commonRoot: string;
  readonly machine?: RuntimeMachine;
  readonly cacheRoot?: string;
  readonly manifestPath?: string;
}

export interface GameRuntimeDistribution {
  readonly platformRoot: string;
  readonly commonRoot: string;
  readonly machine: RuntimeMachine;
  ensureRuntime(options?: { version?: string; runtimeId?: string }): Promise<InstalledRuntime>;
  resolveInstalledRuntime(options?: { version?: string; runtimeId?: string }): InstalledRuntime | undefined;
  runtimeCacheRoot(): string;
  launcherForRuntime(runtime: InstalledRuntime, overrides?: Record<string, string | undefined>): RuntimeLauncher;
  runtimeEnvironment: typeof runtimeEnvironment;
  allocatePort: typeof allocatePort;
  allocateRuntimePorts: typeof allocateRuntimePorts;
  loadRuntimeManifest(): ReturnType<typeof loadRuntimeManifest>;
  engineSdkRoot(): string;
  installEngineSdk(projectRoot: string): EngineSdkInstall;
}

export function createRuntimeDistribution(options: RuntimeDistributionOptions): GameRuntimeDistribution {
  const platformRoot = resolve(options.platformRoot);
  const commonRoot = resolve(options.commonRoot);
  const machine = options.machine ?? { platform: process.platform, arch: process.arch };
  const base = { cacheRoot: options.cacheRoot, machine };
  return {
    platformRoot,
    commonRoot,
    machine,
    ensureRuntime: (overrides = {}) => ensureRuntime({
      ...base,
      ...overrides,
      platformRoot,
      manifestPath: options.manifestPath,
    }),
    resolveInstalledRuntime: (overrides = {}) => resolveInstalledRuntime({ ...base, ...overrides }),
    runtimeCacheRoot: () => resolve(options.cacheRoot ?? defaultRuntimeCacheRoot()),
    launcherForRuntime,
    runtimeEnvironment,
    allocatePort,
    allocateRuntimePorts,
    loadRuntimeManifest: () => loadRuntimeManifest(platformRoot, options.manifestPath),
    engineSdkRoot: () => engineSdkRoot(commonRoot),
    installEngineSdk: (projectRoot) => installEngineSdkFrom(commonRoot, projectRoot),
  };
}
