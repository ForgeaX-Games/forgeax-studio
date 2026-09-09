#!/usr/bin/env bun

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CI_PRODUCER_RESULT_CATEGORIES,
  CI_PRODUCER_RESULT_STATUSES,
  combineCiProducerResults,
  createCiProducerResult,
  validateCiProducerResult,
  type CiProducerAttempt,
  type CiProducerResult,
  type CiProducerResultCategory,
  type CiProducerResultStatus,
} from '../../packages/recursive-input-contract/src/ci-producer-result.ts';

type Parsed = { command: string; values: Map<string, string>; inputs: string[] };

function parse(argv: string[]): Parsed {
  const [command = '', ...args] = argv;
  const values = new Map<string, string>();
  const inputs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error(`unexpected argument ${String(key)}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    index += 1;
    if (key === '--input') inputs.push(value);
    else values.set(key.slice(2), value);
  }
  return { command, values, inputs };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('boolean values must be true or false');
}

function attempt(job: string): CiProducerAttempt {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? 'local/forgeax-studio',
    revision: process.env.GITHUB_SHA ?? 'local',
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    job,
  };
}

function writeAtomic(path: string, result: CiProducerResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function publish(path: string, result: CiProducerResult): void {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `status=${result.status}`,
      `category=${result.category}`,
      `code=${result.code}`,
      `root-producer=${result.rootProducer}`,
      `safe-rerun=${String(result.safeRerun)}`,
      `result-path=${path}`,
    ].join('\n') + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### CI producer result: ${result.producerId}`,
      '',
      '| Status | Category | Code | Root producer | Queue | Duration | Prepare | Rerun |',
      '|:--|:--|:--|:--|--:|--:|--:|:--:|',
      `| ${result.status} | ${result.category} | \`${result.code}\` | ${result.rootProducer} | ${result.metrics.queueDurationMs === undefined ? 'n/a' : `${result.metrics.queueDurationMs} ms`} | ${result.metrics.durationMs} ms | ${result.metrics.prepareDurationMs === undefined ? 'n/a' : `${result.metrics.prepareDurationMs} ms`} | ${result.metrics.isRerun ? 'yes' : 'no'} |`,
      '',
    ].join('\n'));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function readResult(path: string): CiProducerResult {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const validation = validateCiProducerResult(value);
  if (!validation.ok) throw new Error(`invalid producer result ${path}: ${validation.errors.join('; ')}`);
  return value as CiProducerResult;
}

function writeCommand(values: Map<string, string>): { path: string; result: CiProducerResult } {
  const output = required(values, 'output');
  const producerId = required(values, 'producer');
  const status = oneOf(required(values, 'status'), CI_PRODUCER_RESULT_STATUSES, 'status') as CiProducerResultStatus;
  const category = oneOf(required(values, 'category'), CI_PRODUCER_RESULT_CATEGORIES, 'category') as CiProducerResultCategory;
  const result = createCiProducerResult({
    producerId,
    status,
    category,
    code: required(values, 'code'),
    rootProducer: values.get('root-producer') ?? producerId,
    blockedBy: (values.get('blocked-by') ?? '').split(',').filter(Boolean),
    safeRerun: bool(values.get('safe-rerun')),
    attempt: attempt(values.get('job') ?? process.env.GITHUB_JOB ?? producerId),
    timing: {
      ...(values.get('queued-at') || process.env.CI_JOB_QUEUED_AT
        ? { queuedAt: values.get('queued-at') ?? process.env.CI_JOB_QUEUED_AT }
        : {}),
      startedAt: values.get('started-at') ?? process.env.CI_PRODUCER_STARTED_AT ?? new Date().toISOString(),
      ...(values.get('prepare-completed-at') || process.env.CI_PREPARE_COMPLETED_AT
        ? { prepareCompletedAt: values.get('prepare-completed-at') ?? process.env.CI_PREPARE_COMPLETED_AT }
        : {}),
      completedAt: values.get('completed-at') ?? new Date().toISOString(),
    },
    evidenceProducers: (values.get('evidence-producers') ?? producerId).split(',').filter(Boolean),
  });
  return { path: output, result };
}

function combineCommand(values: Map<string, string>, inputs: string[]): { path: string; result: CiProducerResult } {
  if (inputs.length === 0) throw new Error('combine requires at least one --input');
  const output = required(values, 'output');
  const producerId = required(values, 'producer');
  const result = combineCiProducerResults({
    producerId,
    results: inputs.map(readResult),
    attempt: attempt(values.get('job') ?? process.env.GITHUB_JOB ?? producerId),
    queuedAt: values.get('queued-at') ?? process.env.CI_JOB_QUEUED_AT,
    startedAt: values.get('started-at') ?? process.env.CI_PRODUCER_STARTED_AT ?? new Date().toISOString(),
    completedAt: values.get('completed-at') ?? new Date().toISOString(),
  });
  return { path: output, result };
}

const parsed = parse(process.argv.slice(2));
const produced = parsed.command === 'write'
  ? writeCommand(parsed.values)
  : parsed.command === 'combine'
    ? combineCommand(parsed.values, parsed.inputs)
    : (() => { throw new Error('usage: ci-producer-result.ts <write|combine> --output PATH --producer ID ...'); })();
writeAtomic(produced.path, produced.result);
publish(produced.path, produced.result);
