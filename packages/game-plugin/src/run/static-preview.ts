import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  readWatcherState,
  runtimeLogPaths,
  updateWatcherState,
} from './log-paths';
import {
  allocatePort,
  ensureRuntime,
  installEngineSdk,
  parsePreviewBuildManifest,
  parsePreviewHealthIdentity,
  runtimeEnvironment,
  type InstalledRuntime,
  type PreviewBuildManifest,
  type PreviewHealthIdentity,
} from '@forgeax/game-runtime';

export interface StaticPreviewResult {
  readonly previewUrl: string;
  readonly health: PreviewHealthIdentity;
  readonly runtime: InstalledRuntime;
  readonly reused: boolean;
  readonly pid: number;
}

function runtimeCommand(runtime: InstalledRuntime): string {
  return isAbsolute(runtime.command) ? runtime.command : resolve(runtime.root, runtime.command);
}

function lastJsonLine(output: string): unknown {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      // Build tools may write progress before the machine-readable final line.
    }
  }
  throw new Error(`Runtime returned no JSON result:\n${output}`);
}

function buildPreview(
  runtime: InstalledRuntime,
  projectRoot: string,
  gameRoot: string,
  gameId: string,
): { manifest: PreviewBuildManifest; reused: boolean } {
  const result = spawnSync(runtimeCommand(runtime), [
    resolve(runtime.root, runtime.capabilities.build.script),
    '--project-root', projectRoot,
    '--game-root', gameRoot,
    '--game-id', gameId,
    '--runtime-version', runtime.version,
    '--engine-commit', runtime.engineCommit,
  ], {
    cwd: runtime.root,
    encoding: 'utf8',
    env: runtimeEnvironment({ FORGEAX_PROJECT_ROOT: projectRoot }),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `preview build exited ${result.status}`).trim());
  }
  const parsed = lastJsonLine(result.stdout) as { manifest?: unknown; reused?: unknown };
  return {
    manifest: parsePreviewBuildManifest(parsed.manifest),
    reused: parsed.reused === true,
  };
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<PreviewHealthIdentity> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return parsePreviewHealthIdentity(await response.json());
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`preview did not become ready: ${lastError}`);
}

export async function buildAndStartStaticPreview(
  projectRoot: string,
  gameRoot: string,
  gameId: string,
): Promise<StaticPreviewResult> {
  const runtime = await ensureRuntime();
  const sdk = installEngineSdk(projectRoot);
  if (sdk.engineCommit && sdk.engineCommit !== runtime.engineCommit) {
    throw new Error(
      `Engine SDK ${sdk.engineCommit} does not match Runtime ${runtime.engineCommit}; reinstall matching packages`,
    );
  }

  const build = buildPreview(runtime, projectRoot, gameRoot, gameId);
  const existing = readWatcherState(projectRoot);
  if (
    existing?.pid
    && existing.outputRoot === build.manifest.outputRoot
    && existing.previewUrl
  ) {
    try {
      process.kill(existing.pid, 0);
      const healthUrl = new URL('__forgeax_health', existing.previewUrl).toString();
      const health = await waitForHealth(healthUrl, 2_000);
      return {
        previewUrl: existing.previewUrl,
        health,
        runtime,
        reused: true,
        pid: existing.pid,
      };
    } catch {
      // Replace stale state below.
    }
  }

  if (existing?.pid) {
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // The previous preview already exited.
    }
  }

  const port = await allocatePort();
  const previewUrl = `http://127.0.0.1:${port}/preview/`;
  const healthUrl = `${previewUrl}__forgeax_health`;
  const paths = runtimeLogPaths(projectRoot);
  mkdirSync(paths.dir, { recursive: true });
  const logFd = openSync(paths.logFile, 'a');
  let child;
  try {
    child = spawn(runtimeCommand(runtime), [
      resolve(runtime.root, runtime.capabilities.serve.script),
      '--output-root', build.manifest.outputRoot,
      '--host', '127.0.0.1',
      '--port', String(port),
    ], {
      cwd: runtime.root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: runtimeEnvironment({ FORGEAX_PROJECT_ROOT: projectRoot }),
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error('preview server did not return a process id');

  updateWatcherState(projectRoot, {
    game: gameId,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: undefined,
    stopReason: undefined,
    previewUrl,
    outputRoot: build.manifest.outputRoot,
    buildHash: build.manifest.buildHash,
    runtimeVersion: runtime.version,
    engineCommit: runtime.engineCommit,
  });

  const health = await waitForHealth(healthUrl);
  updateWatcherState(projectRoot, { lastSuccessAt: new Date().toISOString() });
  return { previewUrl, health, runtime, reused: build.reused, pid: child.pid };
}
