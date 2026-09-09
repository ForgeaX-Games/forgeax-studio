#!/usr/bin/env bun
import { resolve } from 'node:path';
import { runIdeCommand, runIdeDesktopCommand } from './commands/ide.ts';
import { printPublicVersions } from './commands/versions.ts';

export const PUBLIC_WRAPPER = 'public-command-wrapper';

export function runPublicCommand(argv: readonly string[], root = resolve(import.meta.dir, '../..')): number {
  const [command = 'help', ...args] = argv;
  switch (command) {
    case 'ide':
      return runIdeCommand(root, args);
    case 'versions':
      return printPublicVersions(root);
    case 'teardown':
      console.log('[public-command-wrapper] teardown delegates to bun fx stop');
      return 0;
    default:
      console.error(`unknown public command: ${command}`);
      return 2;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'ide' && argv[1] === 'desktop') {
    process.exit(await runIdeDesktopCommand(resolve(import.meta.dir, '../..'), argv.slice(2)));
  }
  process.exit(runPublicCommand(argv));
}

if (import.meta.main) void main();
