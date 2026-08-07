#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapConcurrent,
  positiveConcurrency,
  runCommandBuffered,
} from '../lib/process-pool.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type TypecheckTask = {
  path: string;
  name: string;
};

export const TYPECHECK_TASKS: readonly TypecheckTask[] = [
  // Start the heaviest composite project immediately so the second worker can
  // drain smaller packages while editor's graph is still running.
  { path: 'editor', name: '@forgeax/editor' },
  { path: 'contracts/agent-runtime', name: '@forgeax/agent-runtime' },
  { path: 'interface/packages/design', name: '@forgeax/design' },
  { path: 'host-sdk', name: '@forgeax/host-sdk' },
  { path: 'contracts/types', name: '@forgeax/types' },
  { path: 'server', name: '@forgeax/server' },
  { path: 'interface', name: '@forgeax/interface' },
  { path: 'chat', name: '@forgeax/chat' },
  { path: 'workbench', name: '@forgeax/workbench' },
  { path: 'settings', name: '@forgeax/settings' },
  { path: 'dashboard', name: '@forgeax/dashboard' },
  { path: 'studio', name: '@forgeax/studio' },
];

type TypecheckResult = {
  task: TypecheckTask;
  script?: 'typecheck' | 'lint';
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  skipped?: boolean;
};

function taskScript(task: TypecheckTask): 'typecheck' | 'lint' | undefined {
  const packageJson = join(ROOT, 'packages', task.path, 'package.json');
  if (!existsSync(packageJson)) return undefined;
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.typecheck ? 'typecheck' : 'lint';
}

async function runTask(task: TypecheckTask): Promise<TypecheckResult> {
  const script = taskScript(task);
  if (!script) {
    return { task, status: 0, stdout: '', stderr: '', skipped: true };
  }
  const result = await runCommandBuffered(process.execPath, ['run', script], {
    cwd: join(ROOT, 'packages', task.path),
  });
  return { task, script, ...result };
}

export async function runPackageTypechecks(
  tasks: readonly TypecheckTask[] = TYPECHECK_TASKS,
  concurrency = positiveConcurrency(
    process.env.FORGEAX_TYPECHECK_CONCURRENCY,
    2,
    'FORGEAX_TYPECHECK_CONCURRENCY',
  ),
): Promise<number> {
  console.log(`[typecheck] ${tasks.length} packages, concurrency=${concurrency}`);
  const results = await mapConcurrent(tasks, concurrency, runTask);
  let failed = 0;
  for (const result of results) {
    console.log(`::group::typecheck ${result.task.name}`);
    if (result.skipped) {
      console.log(`skip: packages/${result.task.path} has no package.json`);
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      // Replay both buffered streams through stdout so GitHub group markers
      // remain ordered; failures still emit an explicit stderr summary below.
      if (result.stderr) process.stdout.write(result.stderr);
      if (result.error) console.error(result.error.message);
      if (result.status !== 0) {
        failed++;
        console.error(
          `[typecheck] ${result.task.name} failed (${result.status === null ? 'spawn error' : `exit ${result.status}`})`,
        );
      }
    }
    console.log('::endgroup::');
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await runPackageTypechecks());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
