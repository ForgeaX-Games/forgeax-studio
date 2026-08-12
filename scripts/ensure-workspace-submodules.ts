#!/usr/bin/env bun
/**
 * Materialize submodule checkouts that bun workspaces require.
 *
 * `bun install` resolves workspaces BEFORE `prepare` runs. A plain
 * `git pull` that adds/renames a submodule leaves an empty dir (or a stale
 * checkout), and bun fails with `Workspace not found "packages/…"`.
 *
 * Run via `bun fx clean` (preferred) or directly:
 *   bun scripts/ensure-workspace-submodules.ts
 * Then `bun install` as usual.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type SubmoduleMaterializerPlatform = 'win32' | 'posix';
export type SubmoduleMaterializerAdapter = 'unix-shared-materializer' | 'windows-direct-git';
export type SubmoduleMaterializationReport = {
  platform: SubmoduleMaterializerPlatform;
  adapter: SubmoduleMaterializerAdapter;
  status: number;
  materializationStatus: 'ready' | 'non-ready';
  recursiveStatus: 'passed' | 'failed';
  unresolvedPaths: string[];
  windowsLiveEvidence: 'native-runner-available' | 'external-acceptance-pending';
};

type CommandResult = {
  status: number | null;
  stdout?: string | Buffer;
};

export type SubmoduleCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: 'inherit' | 'pipe'; encoding?: 'utf8' },
) => CommandResult;

function defaultRun(command: string, args: string[], options: Parameters<SubmoduleCommandRunner>[2]): CommandResult {
  const result = spawnSync(command, args, options);
  return { status: result.status, stdout: result.stdout };
}

function normalizePlatform(platform: NodeJS.Platform): SubmoduleMaterializerPlatform {
  return platform === 'win32' ? 'win32' : 'posix';
}

export function parseUnresolvedSubmoduleStatus(output: string | Buffer | undefined): string[] {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(/^[-+U][0-9a-f]{7,40}\s+(.+)$/i)?.[1]?.trim())
    .filter((path): path is string => Boolean(path));
}

function report(
  platform: SubmoduleMaterializerPlatform,
  adapter: SubmoduleMaterializerAdapter,
  status: number,
  unresolvedPaths: string[],
): SubmoduleMaterializationReport {
  const normalizedStatus = status === 0 && unresolvedPaths.length > 0 ? 1 : status;
  return {
    platform,
    adapter,
    status: normalizedStatus,
    materializationStatus: normalizedStatus === 0 ? 'ready' : 'non-ready',
    recursiveStatus: normalizedStatus === 0 ? 'passed' : 'failed',
    unresolvedPaths,
    windowsLiveEvidence: process.platform === 'win32'
      ? 'native-runner-available'
      : 'external-acceptance-pending',
  };
}

export function materializeWorkspaceSubmodules(
  root: string,
  options: {
    platform?: NodeJS.Platform;
    run?: SubmoduleCommandRunner;
  } = {},
): SubmoduleMaterializationReport {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const run = options.run ?? defaultRun;
  const materializer = join(root, 'deploy/dev/scripts/materialize-submodules.sh');

  if (platform === 'win32') {
    const sync = run('git', ['submodule', 'sync', '--recursive'], {
      cwd: root,
      stdio: 'inherit',
    });
    const update = sync.status === 0
      ? run('git', ['submodule', 'update', '--init', '--recursive'], {
        cwd: root,
        stdio: 'inherit',
      })
      : sync;
    let status = update.status ?? 1;
    let unresolvedPaths: string[] = [];
    if (status === 0) {
      const postCheck = run('git', ['submodule', 'status', '--recursive'], {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      status = postCheck.status ?? 1;
      unresolvedPaths = parseUnresolvedSubmoduleStatus(postCheck.stdout);
    }
    return report(platform, 'windows-direct-git', status, unresolvedPaths);
  }

  const update = run('sh', [materializer, root], {
    cwd: root,
    stdio: 'inherit',
  });
  return report(platform, 'unix-shared-materializer', update.status ?? 1, []);
}

export function parseGitmodulesPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

export function readWorkspaceGlobs(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as { workspaces?: string[] };
  return pkg.workspaces ?? [];
}

/** Workspace entries that look like concrete package dirs (not globs). */
export function concreteWorkspacePaths(workspaces: string[]): string[] {
  return workspaces.filter((w) => !w.includes('*'));
}

export function missingWorkspacePackageJson(
  root: string,
  workspaces: string[],
): string[] {
  return concreteWorkspacePaths(workspaces).filter(
    (w) => !existsSync(join(root, w, 'package.json')),
  );
}

export function ensureWorkspaceSubmodules(root = ROOT): {
  missingBefore: string[];
  status: number;
} {
  const gitmodules = join(root, '.gitmodules');
  const pkgJson = join(root, 'package.json');
  if (!existsSync(gitmodules) || !existsSync(pkgJson)) {
    return { missingBefore: [], status: 0 };
  }

  const workspaces = readWorkspaceGlobs(readFileSync(pkgJson, 'utf8'));
  const missingBefore = missingWorkspacePackageJson(root, workspaces);
  const paths = parseGitmodulesPaths(readFileSync(gitmodules, 'utf8'));

  if (paths.length === 0) return { missingBefore, status: 0 };

  // Align every recorded pin through the same retry/fallback policy used by
  // CI, git hooks, cloud-dev startup, and Docker image seeding. Native Windows
  // has no guaranteed POSIX shell, so use Git directly and perform the same
  // recursive post-check before reporting readiness.
  console.log('[ensure-workspaces] materializing recursive submodule graph');
  const result = materializeWorkspaceSubmodules(root);
  return { missingBefore, status: result.status };
}

function main(): void {
  const { missingBefore, status } = ensureWorkspaceSubmodules();
  if (missingBefore.length > 0) {
    console.log(
      `[ensure-workspaces] was missing package.json: ${missingBefore.join(', ')}`,
    );
  }
  if (status !== 0) {
    console.error(
      '[ensure-workspaces] submodule update failed — fix git auth / network, then retry',
    );
    process.exit(status);
  }

  const stillMissing = missingWorkspacePackageJson(
    ROOT,
    readWorkspaceGlobs(readFileSync(join(ROOT, 'package.json'), 'utf8')),
  );
  if (stillMissing.length > 0) {
    console.error(
      `[ensure-workspaces] still missing after update: ${stillMissing.join(', ')}`,
    );
    process.exit(1);
  }

  // Leftover pre-rename dir confuses humans; not a bun workspace entry anymore.
  const leftoverCore = join(ROOT, 'packages/core');
  if (existsSync(leftoverCore) && !existsSync(join(leftoverCore, '.git'))) {
    console.warn(
      '[ensure-workspaces] leftover packages/core/ detected (pre-rename). Safe to `rm -rf packages/core`.',
    );
  }

  console.log('[ensure-workspaces] ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
