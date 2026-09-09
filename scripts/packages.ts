#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  mergePackagesLocalConfig,
  focusPackagePaths,
  readPackageFiles,
  resolvePackageConfig,
  selectPackageEntries,
  validateBranchName,
} from './lib/package-manifest.ts';
import { packageGitEnvironment, syncPackages, type PackageSyncMode } from './lib/package-sync.ts';
import { NO_CRED_ARGV } from './lib/git-credential.ts';

type CliOptions = {
  command: 'ensure' | 'sync' | 'update' | 'list' | 'branch';
  branch?: string;
  selectors: string[];
  focus: boolean;
  dryRun: boolean;
  allowDirty: boolean;
};

function usage(): string {
  return `ForgeaX floating package manager

Usage:
  bun fx packages ensure [--only name,path] [--focus] [--dry-run]
  bun fx packages sync   [--only name,path] [--focus] [--dry-run]
  bun fx packages update [--only name,path] [--focus] [--dry-run]
  bun fx packages list   [--focus]
  bun fx packages branch <branch> [--only name,path] [--dry-run] [--allow-dirty]

.packages.local accepts a legacy array or { "replace": [...], "assign": [...] }.
--focus limits the operation to paths explicitly present in .packages.local.
`;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  const command = argv[0] as CliOptions['command'];
  if (!['ensure', 'sync', 'update', 'list', 'branch'].includes(command)) {
    throw new Error(`Unknown packages command: ${argv[0]}\n\n${usage()}`);
  }
  const options: CliOptions = {
    command,
    selectors: [],
    focus: false,
    dryRun: false,
    allowDirty: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--focus' || arg === '--local-only') options.focus = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--only' || arg === '--packages') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a comma-separated value.`);
      options.selectors.push(...value.split(',').map((part) => part.trim()).filter(Boolean));
      index += 1;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (command === 'branch' && !options.branch) options.branch = validateBranchName(arg);
    else options.selectors.push(arg);
  }
  if (command === 'branch' && !options.branch) throw new Error('packages branch requires a branch name.');
  return options;
}

function git(root: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', [...NO_CRED_ARGV, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
}

function gitSucceeds(root: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  return spawnSync('git', [...NO_CRED_ARGV, ...args], { cwd: root, stdio: 'ignore', env }).status === 0;
}

function switchBranches(root: string, options: CliOptions): number {
  const files = readPackageFiles(root);
  const gitEnv = packageGitEnvironment(root);
  const effective = resolvePackageConfig(files.base, files.local);
  const entries = selectPackageEntries(effective, options.selectors);
  const next = mergePackagesLocalConfig(files.local, effective, {
    branch: options.branch!,
    selectors: entries.map((entry) => entry.path),
  });
  if (options.dryRun) {
    process.stdout.write(`[packages] would write ${files.localPath}:\n${JSON.stringify(next, null, 2)}\n`);
  } else {
    writeFileSync(files.localPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    process.stdout.write(`[packages] updated ${files.localPath}\n`);
  }

  let failed = 0;
  for (const entry of entries) {
    const checkout = resolve(root, entry.path);
    if (!existsSync(checkout) || !gitSucceeds(root, ['-C', checkout, 'rev-parse', '--git-dir'], gitEnv)) {
      process.stdout.write(`[packages] ${entry.path}: checkout absent; local override recorded\n`);
      continue;
    }
    if (!options.allowDirty && git(root, ['-C', checkout, 'status', '--porcelain'], gitEnv)) {
      process.stderr.write(`[packages] ${entry.path}: local changes detected; branch switch refused\n`);
      failed += 1;
      continue;
    }
    if (options.dryRun) {
      process.stdout.write(`[packages] ${entry.path}: would switch to ${options.branch}\n`);
      continue;
    }
    if (gitSucceeds(root, ['-C', checkout, 'show-ref', '--verify', '--quiet', `refs/heads/${options.branch}`], gitEnv)) {
      git(root, ['-C', checkout, 'switch', options.branch!], gitEnv);
    } else if (gitSucceeds(root, ['-C', checkout, 'fetch', '--quiet', entry.url, options.branch!], gitEnv)) {
      git(root, ['-C', checkout, 'switch', '-c', options.branch!, 'FETCH_HEAD'], gitEnv);
    } else {
      git(root, ['-C', checkout, 'switch', '-c', options.branch!], gitEnv);
    }
    process.stdout.write(`[packages] ${entry.path}: switched to ${options.branch}\n`);
  }
  return failed === 0 ? 0 : 1;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(process.env.FORGEAX_WORKSPACE_ROOT ?? process.cwd());
  if (options.command === 'branch') return switchBranches(root, options);
  if (options.command === 'list') {
    const files = readPackageFiles(root);
    let entries = selectPackageEntries(resolvePackageConfig(files.base, files.local), options.selectors);
    if (options.focus) {
      const focused = new Set(focusPackagePaths(files.local));
      entries = entries.filter((entry) => focused.has(entry.path));
    }
    for (const entry of entries) process.stdout.write(`${entry.path}\t${entry.branch}\t${entry.url}\n`);
    return 0;
  }
  const result = syncPackages({
    root,
    mode: options.command as PackageSyncMode,
    focus: options.focus,
    selectors: options.selectors,
    dryRun: options.dryRun,
  });
  for (const row of result.results) {
    process.stdout.write(`[packages] ${row.path}: ${row.action}${row.detail ? ` (${row.detail})` : ''}\n`);
  }
  return result.exitCode;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`[packages] ${(error as Error).message}\n`);
  process.exit(2);
}
