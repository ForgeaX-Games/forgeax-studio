#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  discoverWorkflowSourcePaths,
  WORKFLOW_PARSER_CONTRACT,
} from './workflow-source-set';

export type WorkflowAdmissionResult = {
  parser: string;
  version: string;
  sha256: string;
  root: string;
  sources: string[];
};

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function parserFailure(error: unknown, root: string, sources: string[]): Error {
  const candidate = error as {
    status?: number | null;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const output = [candidate.stdout, candidate.stderr]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join('\n');
  return new Error(
    [
      `workflow parser rejected ${sources.length} source(s) with exit ${candidate.status ?? 'unknown'}`,
      `root=${root}`,
      output,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export function validateWorkflowSources(
  root: string,
  actionlint = 'actionlint',
): WorkflowAdmissionResult {
  const resolvedRoot = resolve(root);
  const sources = discoverWorkflowSourcePaths(resolvedRoot);
  if (sources.length === 0) {
    throw new Error(`workflow parser source set is empty: ${resolvedRoot}`);
  }

  const args = [
    '-config-file',
    resolve(import.meta.dir, '../../.github/actionlint.yaml'),
    '-shellcheck=',
    ...WORKFLOW_PARSER_CONTRACT.parser.ignore.flatMap((pattern) => ['-ignore', pattern]),
    ...sources,
  ];
  try {
    execFileSync(actionlint, args, {
      cwd: resolvedRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw parserFailure(error, resolvedRoot, sources);
  }

  return {
    parser: WORKFLOW_PARSER_CONTRACT.parser.name,
    version: WORKFLOW_PARSER_CONTRACT.parser.version,
    sha256: WORKFLOW_PARSER_CONTRACT.parser.sha256,
    root: resolvedRoot,
    sources,
  };
}

export function main(): void {
  const root = option('--root') ?? process.cwd();
  const actionlint = option('--actionlint') ?? 'actionlint';
  try {
    process.stdout.write(`${JSON.stringify(validateWorkflowSources(root, actionlint))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
