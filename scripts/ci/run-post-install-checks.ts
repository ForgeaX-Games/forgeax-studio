#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapConcurrent,
  positiveConcurrency,
  runCommandBuffered,
} from '../lib/process-pool.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type CommandTask = {
  name: string;
  args: string[];
  cwd?: string;
};

export const STATIC_GATES: readonly CommandTask[] = [
  { name: 'Test @forgeax/agent-runtime', args: ['-F', '@forgeax/agent-runtime', 'test'] },
  { name: 'Game engine-import resolution gate', args: ['scripts/check-game-engine-imports.ts'] },
  { name: 'Game input-contract gate', args: ['scripts/check-game-input-contract.ts'] },
  { name: 'Typecheck @forgeax/platform-io', args: ['-F', '@forgeax/platform-io', 'typecheck'] },
  { name: 'interface package-boundary guard', args: ['run', '--cwd', 'packages/interface', 'lint:dep'] },
  { name: 'interface app-agnostic import guard', args: ['run', '--cwd', 'packages/interface', 'lint:agnostic'] },
  {
    name: 'Editor-core barrel-export contract',
    args: ['test', 'src/__tests__/barrel-export-contract.test.ts'],
    cwd: 'packages/editor/packages/core',
  },
  {
    name: 'New-game Play import-resolution contract',
    args: ['test', 'src/viewport/runtime-vite-preset.test.ts'],
    cwd: 'packages/editor/packages/edit-runtime',
  },
  {
    name: 'New-game preview import-resolution contract',
    args: ['test', 'src/__tests__/game-template-imports.test.ts'],
    cwd: 'packages/editor/packages/play-runtime',
  },
];

export const VITE_BUILDS: readonly CommandTask[] = [
  {
    name: 'Vite build packages/interface',
    args: ['run', 'vite', 'build'],
    cwd: 'packages/interface',
  },
  {
    name: 'Vite build packages/studio',
    args: ['run', 'vite', 'build'],
    cwd: 'packages/studio',
  },
];

async function runStage(
  label: string,
  tasks: readonly CommandTask[],
  concurrency: number,
): Promise<boolean> {
  console.log(`[ci-stage] ${label}: ${tasks.length} task(s), concurrency=${concurrency}`);
  const results = await mapConcurrent(tasks, concurrency, async (task) => ({
    task,
    result: await runCommandBuffered(process.execPath, task.args, {
      cwd: task.cwd ? resolve(ROOT, task.cwd) : ROOT,
    }),
  }));
  let failed = false;
  for (const { task, result } of results) {
    console.log(`::group::${task.name}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stdout.write(result.stderr);
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) {
      failed = true;
      console.error(
        `[ci-stage] ${task.name} failed (${result.status === null ? 'spawn error' : `exit ${result.status}`})`,
      );
    }
    console.log('::endgroup::');
  }
  return !failed;
}

export async function runPostInstallChecks(): Promise<number> {
  const staticConcurrency = positiveConcurrency(
    process.env.FORGEAX_STATIC_GATE_CONCURRENCY,
    3,
    'FORGEAX_STATIC_GATE_CONCURRENCY',
  );
  if (!await runStage('static gates', STATIC_GATES, staticConcurrency)) return 1;

  const buildConcurrency = positiveConcurrency(
    process.env.FORGEAX_VITE_BUILD_CONCURRENCY,
    2,
    'FORGEAX_VITE_BUILD_CONCURRENCY',
  );
  return await runStage('Vite builds', VITE_BUILDS, buildConcurrency) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await runPostInstallChecks());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
