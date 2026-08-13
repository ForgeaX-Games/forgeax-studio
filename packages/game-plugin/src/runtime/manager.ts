import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { installRuntime, listInstalledRuntimes, readInstalledRuntime, runtimeCacheRoot } from './cache';
import { loadRuntimeManifest, resolveRuntimeArtifact, runtimeManifestRoot } from './manifest';
import { runtimeEnvironment } from './env';
import type { InstalledRuntime, RuntimeLauncher } from './types';

export interface ResolveRuntimeOptions {
  readonly version?: string;
  readonly runtimeId?: string;
  readonly pluginRoot?: string;
  readonly cacheRoot?: string;
}

/** Resolve an already-installed runtime; this path never needs a Studio checkout. */
export function resolveInstalledRuntime(options: ResolveRuntimeOptions = {}): InstalledRuntime | undefined {
  const runtimeId = options.runtimeId ?? 'forgeax-game-runtime';
  if (options.version) return readInstalledRuntime(runtimeId, options.version, { platform: platform(), arch: arch() }, options.cacheRoot ?? runtimeCacheRoot());
  const installed = listInstalledRuntimes(runtimeId, options.cacheRoot ?? runtimeCacheRoot());
  return installed[0];
}

export async function ensureRuntime(options: ResolveRuntimeOptions = {}): Promise<InstalledRuntime> {
  const pluginRoot = runtimeManifestRoot(options.pluginRoot);
  const manifest = loadRuntimeManifest(pluginRoot);
  if (!manifest) {
    const installed = resolveInstalledRuntime(options);
    if (installed) return installed;
    throw new Error('no ForgeaX runtime manifest is installed; install a runtime artifact first');
  }
  const runtimeId = options.runtimeId ?? manifest.runtimeId;
  const artifact = resolveRuntimeArtifact(manifest, options.version);
  if (!artifact) throw new Error(`no runtime artifact matches ${runtimeId}${options.version ? `@${options.version}` : ''} for ${platform()}/${arch()}`);
  const installed = resolveInstalledRuntime({
    ...options,
    runtimeId,
    version: artifact.version,
  });
  if (installed) return installed;
  return installRuntime(artifact, {
    runtimeId,
    cacheRoot: options.cacheRoot,
    sourceRoot: join(pluginRoot, 'assets'),
  });
}

export function launcherForRuntime(runtime: InstalledRuntime, overrides: Record<string, string | undefined> = {}): RuntimeLauncher {
  const command = runtime.command.includes('/') || runtime.command.includes('\\') ? runtime.command : join(runtime.root, runtime.command);
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
