#!/usr/bin/env bun
import { resolve } from 'node:path';
import { runIdeCommand } from './fx/commands/ide.ts';

export function runPublicRelease(args: readonly string[] = [], root = resolve(import.meta.dir, '..')): number {
  const [owner = 'ide', ...rest] = args;
  if (owner !== 'ide') {
    console.error(`unknown release owner: ${owner}`);
    return 2;
  }
  return runIdeCommand(root, ['release', ...rest]);
}

if (import.meta.main) process.exit(runPublicRelease(process.argv.slice(2)));
