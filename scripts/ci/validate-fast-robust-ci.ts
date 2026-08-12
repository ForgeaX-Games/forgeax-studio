#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFastRobustCiEvidence } from './fast-robust-ci-evidence.schema';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

export function main(): void {
  const input = arg('--input');
  if (!input) {
    process.stdout.write(`${JSON.stringify({ status: 'invalid', code: 'ci-evidence-input-required' })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const evidence = parseFastRobustCiEvidence(JSON.parse(readFileSync(resolve(input), 'utf8')));
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      input: resolve(input),
      comparableSamples: evidence.history.population.sampleCount,
      rawRunCount: evidence.history.rawRunCount,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'invalid', code: 'ci-evidence-schema-invalid', detail: String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
