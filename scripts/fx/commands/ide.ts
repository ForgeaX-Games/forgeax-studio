import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const IDE_MOUNT_NOT_FOUND = 'IDE_MOUNT_NOT_FOUND';
export const PUBLIC_TEARDOWN_COMMANDS = new Set(['stop', 'teardown']);
const IDE_HELP_FLAGS = new Set(['', 'help', '--help', '-h']);

function printIdeHelp(): void {
  console.log('ForgeaX IDE public commands: start, desktop, build, ci, stop');
  console.log('  start  start the IDE web development server');
  console.log('  desktop  start the IDE desktop development client');
  console.log('  build  build the IDE desktop application');
  console.log('  ci     install and run the Studio-integrated IDE checks');
  console.log('  stop   complete the root-owned teardown contract');
}

export function ideProcessEnv(
  root: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    FORGEAX_INTEGRATION_ROOT: resolve(root),
  };
}

export type IdeCommandDependencies = {
  existsSync: typeof existsSync;
  spawnSync: typeof spawnSync;
};

const DEFAULT_DEPENDENCIES: IdeCommandDependencies = { existsSync, spawnSync };

function runProcess(
  root: string,
  cwd: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: IdeCommandDependencies,
): number {
  const result = dependencies.spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env,
    windowsHide: true,
  });
  return result.status ?? 1;
}

function runBun(
  root: string,
  cwd: string,
  args: readonly string[],
  dependencies: IdeCommandDependencies,
  env: NodeJS.ProcessEnv = ideProcessEnv(root),
): number {
  return runProcess(root, cwd, process.execPath, args, env, dependencies);
}

function ensureDependencies(
  root: string,
  cwd: string,
  dependencies: IdeCommandDependencies = DEFAULT_DEPENDENCIES,
): number {
  if (dependencies.existsSync(join(cwd, 'node_modules'))) return 0;
  return runBun(root, cwd, ['install', '--frozen-lockfile', '--ignore-scripts'], dependencies);
}

async function runBunWithSignals(root: string, cwd: string, args: readonly string[]): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: ideProcessEnv(root),
    windowsHide: true,
  });
  let forwardedSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const status = await new Promise<number>((resolveStatus) => {
    child.once('error', () => resolveStatus(1));
    child.once('exit', (code) => {
      if (code !== null) return resolveStatus(code);
      resolveStatus(forwardedSignal === 'SIGINT' ? 130 : 143);
    });
  });
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  return status;
}

export function ideDesktopInvocation(args: readonly string[]): readonly string[] {
  return ['run', 'dev:desktop', ...args];
}

export function ideMount(root: string): string {
  return resolve(root, 'packages', 'ide');
}

export function runIdeCommand(
  root: string,
  args: readonly string[],
  dependencies: IdeCommandDependencies = DEFAULT_DEPENDENCIES,
): number {
  const cwd = ideMount(root);
  if (!dependencies.existsSync(cwd)) {
    console.error(`${IDE_MOUNT_NOT_FOUND}: packages/ide is not mounted; run bun fx packages ensure --only ide`);
    return 2;
  }
  if (IDE_HELP_FLAGS.has(args[0] ?? '')) {
    printIdeHelp();
    return 0;
  }
  if (PUBLIC_TEARDOWN_COMMANDS.has(args[0] ?? '')) {
    console.log('[ide] public teardown complete (the root owns no product runtime)');
    return 0;
  }
  const [command = '', ...commandArgs] = args;
  if (command === 'start') {
    const installed = ensureDependencies(root, cwd, dependencies);
    if (installed !== 0) return installed;
    return runBun(root, cwd, ['run', 'dev:web', ...commandArgs], dependencies);
  }
  if (command === 'desktop') {
    const installed = ensureDependencies(root, cwd, dependencies);
    if (installed !== 0) return installed;
    return runBun(root, cwd, ideDesktopInvocation(commandArgs), dependencies);
  }
  if (command === 'build') {
    const installed = ensureDependencies(root, cwd, dependencies);
    if (installed !== 0) return installed;
    return runBun(root, cwd, ['run', 'build:desktop', ...commandArgs], dependencies);
  }
  if (command === 'ci') {
    const installed = runBun(root, cwd, ['install', '--frozen-lockfile', '--ignore-scripts'], dependencies);
    if (installed !== 0) return installed;
    for (const script of ['lint', 'test', 'build:web']) {
      const status = runBun(root, cwd, ['run', script, ...commandArgs], dependencies);
      if (status !== 0) return status;
    }
    return 0;
  }
  console.error(`unknown IDE public command: ${command}`);
  printIdeHelp();
  return 2;
}

export async function runIdeDesktopCommand(root: string, args: readonly string[]): Promise<number> {
  const cwd = ideMount(root);
  if (!existsSync(cwd)) {
    console.error(`${IDE_MOUNT_NOT_FOUND}: packages/ide is not mounted; run bun fx packages ensure --only ide`);
    return 2;
  }
  const installed = ensureDependencies(root, cwd);
  if (installed !== 0) return installed;
  return runBunWithSignals(root, cwd, ideDesktopInvocation(args));
}
