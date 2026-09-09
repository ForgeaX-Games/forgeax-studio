#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadCiContractFiles, type CiContextDeclaration } from '../../packages/recursive-input-contract/src/ci-contract.ts';
import { createCiProducerResult, type CiProducerAttempt, type CiProducerResult } from '../../packages/recursive-input-contract/src/ci-producer-result.ts';

export type PullRequestCheck = {
  name: string;
  state: string;
  bucket?: string;
  workflow?: string;
  link?: string;
  startedAt?: string;
  completedAt?: string;
};

export type PullRequestSnapshot = {
  headSha: string;
  checks: PullRequestCheck[];
};

export type CheckEvaluation = {
  status: 'ready' | 'waiting' | 'failed' | 'stale';
  missing: string[];
  pending: string[];
  failed: Array<{ name: string; state: string; link?: string }>;
  observedHeadSha?: string;
};

const PIN_WORKFLOW = '.github/workflows/submodule-pins.yml';
const PIN_JOB = 'check';
const SUCCESS_STATE = 'SUCCESS';
const PENDING_STATES = new Set(['EXPECTED', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING', 'IN_PROGRESS']);

/**
 * Derive the checks that must finish before the pin gate from the producer
 * manifest. The pin context is the only intentional exclusion; adding another
 * hard-coded prerequisite here would create a second CI contract.
 */
export function prerequisiteContexts(
  contexts: readonly CiContextDeclaration[],
  pinWorkflow = PIN_WORKFLOW,
  pinJob = PIN_JOB,
): CiContextDeclaration[] {
  const pinContexts = contexts.filter((context) => context.source === pinWorkflow && context.job === pinJob);
  if (pinContexts.length !== 1) {
    throw new Error(`expected exactly one pin context in the CI manifest, found ${pinContexts.length}`);
  }
  return contexts.filter((context) => context !== pinContexts[0]);
}

function checkTimestamp(check: PullRequestCheck): number {
  const timestamp = check.startedAt ?? check.completedAt;
  if (!timestamp) return 0;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function latestCheck(checks: readonly PullRequestCheck[], name: string): PullRequestCheck | undefined {
  return checks
    .filter((check) => check.name === name)
    .sort((left, right) => checkTimestamp(left) - checkTimestamp(right))
    .at(-1);
}

/**
 * Evaluate one immutable PR check snapshot. A missing or non-terminal check
 * waits; any terminal non-success fails closed; only explicit SUCCESS for all
 * prerequisites releases the pin validator.
 */
export function evaluatePrerequisiteChecks(
  expectedHeadSha: string,
  snapshot: PullRequestSnapshot,
  contexts: readonly CiContextDeclaration[],
): CheckEvaluation {
  if (snapshot.headSha !== expectedHeadSha) {
    return {
      status: 'stale',
      missing: [],
      pending: [],
      failed: [],
      observedHeadSha: snapshot.headSha,
    };
  }

  const missing: string[] = [];
  const pending: string[] = [];
  const failed: Array<{ name: string; state: string; link?: string }> = [];

  for (const context of contexts) {
    const check = latestCheck(snapshot.checks, context.name);
    if (!check) {
      missing.push(context.name);
      continue;
    }

    const state = check.state.trim().toUpperCase();
    if (state === SUCCESS_STATE) continue;
    if (PENDING_STATES.has(state)) {
      pending.push(context.name);
      continue;
    }
    failed.push({ name: context.name, state, link: check.link });
  }

  if (failed.length > 0) return { status: 'failed', missing, pending, failed };
  if (missing.length > 0 || pending.length > 0) return { status: 'waiting', missing, pending, failed };
  return { status: 'ready', missing, pending, failed };
}

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function runGh(args: string[]): CommandResult {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: process.env,
    // A hung CLI process must not defeat the outer polling deadline. This is
    // especially important on a persistent self-hosted runner, where an API
    // connection can otherwise keep the pin job alive indefinitely.
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function requireGhOutput(result: CommandResult, operation: string): string {
  const output = result.stdout.trim();
  if (output) return output;
  const detail = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
  throw new Error(`${operation} failed: ${detail}`);
}

export function parseCheckRunsJson(raw: string): PullRequestCheck[] {
  const lines = raw.trim() ? raw.trim().split('\n') : [];
  return lines.map((line, index) => {
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`GitHub check-runs returned invalid JSON at index ${index}: ${String(error)}`);
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`GitHub check-runs returned an invalid check-run at index ${index}`);
    }
    const run = item as Record<string, unknown>;
    if (typeof run.name !== 'string' || typeof run.status !== 'string') {
      throw new Error(`GitHub check-runs returned an invalid check-run at index ${index}`);
    }
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion.trim().toUpperCase() : 'UNKNOWN';
    const state = run.status.trim().toLowerCase() === 'completed'
      ? conclusion
      : run.status.trim().toUpperCase();
    const suite = typeof run.check_suite === 'object' && run.check_suite !== null && !Array.isArray(run.check_suite)
      ? run.check_suite as Record<string, unknown>
      : undefined;
    return {
      name: run.name,
      state,
      workflow: typeof suite?.workflow_name === 'string' ? suite.workflow_name : undefined,
      link: typeof run.html_url === 'string' ? run.html_url : undefined,
      startedAt: typeof run.started_at === 'string' ? run.started_at : undefined,
      completedAt: typeof run.completed_at === 'string' ? run.completed_at : undefined,
    };
  });
}

export function readPullRequestSnapshot(repo: string, prNumber: number): PullRequestSnapshot {
  // Use the REST field directly: shared self-hosted runners can carry an older
  // gh CLI that does not expose newer `pr view --json` fields such as
  // `headRefOid`.
  const headResult = runGh([
    'api',
    `repos/${repo}/pulls/${prNumber}`,
    '--jq', '.head.sha',
  ]);
  const headSha = requireGhOutput(headResult, 'read pull request head SHA');

  // Read check-runs directly from the immutable head commit. The `gh pr checks`
  // rollup can lag or remain opaque on a persistent self-hosted runner even
  // after every producer check is green; the check-runs endpoint is the
  // permission-scoped source that the waiter actually needs.
  const checksResult = runGh([
    'api', '--paginate', '--jq', '.check_runs[]',
    `repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
  ]);
  if (checksResult.error || checksResult.status !== 0) {
    const detail = checksResult.error?.message ?? (checksResult.stderr.trim() || `exit ${String(checksResult.status)}`);
    throw new Error(`read pull request check-runs failed: ${detail}`);
  }
  return { headSha, checks: parseCheckRunsJson(checksResult.stdout) };
}

export async function waitForPrerequisiteChecks(options: {
  expectedHeadSha: string;
  contexts: readonly CiContextDeclaration[];
  readSnapshot: () => PullRequestSnapshot | Promise<PullRequestSnapshot>;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onReadError?: (error: unknown) => void;
  onEvaluation?: (evaluation: CheckEvaluation) => void;
}): Promise<CheckEvaluation> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  while (true) {
    try {
      const snapshot = await options.readSnapshot();
      const evaluation = evaluatePrerequisiteChecks(options.expectedHeadSha, snapshot, options.contexts);
      options.onEvaluation?.(evaluation);
      if (evaluation.status !== 'waiting') return evaluation;
    } catch (error) {
      options.onReadError?.(error);
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: 'failed',
        missing: options.contexts.map((context) => context.name),
        pending: [],
        failed: [{ name: 'prerequisite-check-observation', state: 'TIMEOUT' }],
      };
    }
    await sleep(Math.min(options.intervalMs, remaining));
  }
}

export function mapEvaluationToProducerResult(
  evaluation: CheckEvaluation,
  attempt: CiProducerAttempt,
  timing: { queuedAt?: string; startedAt?: string; completedAt?: string } = {},
): CiProducerResult {
  const startedAt = timing.startedAt ?? new Date().toISOString();
  const completedAt = timing.completedAt ?? startedAt;
  if (evaluation.status === 'ready') {
    return createCiProducerResult({
      producerId: 'submodule-pin-prerequisite-wait',
      status: 'passed',
      category: 'upstream',
      code: 'ci.prerequisite.passed',
      rootProducer: 'submodule-pin-prerequisite-wait',
      blockedBy: [],
      safeRerun: false,
      attempt,
      timing: { ...(timing.queuedAt ? { queuedAt: timing.queuedAt } : {}), startedAt, completedAt },
    });
  }
  if (evaluation.status === 'stale') {
    return createCiProducerResult({
      producerId: 'submodule-pin-prerequisite-wait',
      status: 'superseded',
      category: 'upstream',
      code: 'ci.head.superseded',
      rootProducer: 'submodule-pin-prerequisite-wait',
      blockedBy: [],
      safeRerun: false,
      attempt,
      timing: { ...(timing.queuedAt ? { queuedAt: timing.queuedAt } : {}), startedAt, completedAt },
    });
  }
  const observationFailure = evaluation.failed.find((failure) => failure.name === 'prerequisite-check-observation');
  const blockedBy = observationFailure
    ? [...evaluation.missing, ...evaluation.pending]
    : evaluation.failed.map((failure) => failure.name);
  return createCiProducerResult({
    producerId: 'submodule-pin-prerequisite-wait',
    status: 'blocked',
    category: observationFailure ? 'infrastructure' : 'upstream',
    code: observationFailure ? 'ci.prerequisite.observation-timeout' : evaluation.status === 'waiting' ? 'ci.prerequisite.pending' : 'ci.prerequisite.failed',
    rootProducer: observationFailure?.name ?? evaluation.failed[0]?.name ?? 'submodule-pin-prerequisite-wait',
    blockedBy,
    safeRerun: Boolean(observationFailure),
    attempt,
    timing: { ...(timing.queuedAt ? { queuedAt: timing.queuedAt } : {}), startedAt, completedAt },
  });
}

function publishProducerResult(result: CiProducerResult, path: string | undefined): void {
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `status=${result.status}`,
      `release=${String(result.status === 'passed')}`,
      `category=${result.category}`,
      `code=${result.code}`,
      `root-producer=${result.rootProducer}`,
      `blocked-by=${result.blockedBy.join(',')}`,
      `result-path=${path ?? ''}`,
    ].join('\n') + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '### Submodule-pin prerequisite observation',
      '',
      `- Status: **${result.status}**`,
      `- Category: \`${result.category}\``,
      `- Code: \`${result.code}\``,
      `- Root producer: \`${result.rootProducer}\``,
      `- Blocked by: ${result.blockedBy.length > 0 ? result.blockedBy.join(', ') : 'none'}`,
      `- Queue: ${result.metrics.queueDurationMs ?? 'n/a'} ms`,
      `- Producer duration: ${result.metrics.durationMs} ms`,
      `- Rerun: ${result.metrics.isRerun ? 'yes' : 'no'}`,
      '',
    ].join('\n'));
  }
}

function positiveSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`expected a positive seconds value, got ${String(value)}`);
  return parsed;
}

function formatEvaluation(evaluation: CheckEvaluation): string {
  const details = [
    evaluation.missing.length > 0 ? `missing=${evaluation.missing.join(',')}` : '',
    evaluation.pending.length > 0 ? `pending=${evaluation.pending.join(',')}` : '',
    evaluation.failed.length > 0 ? `failed=${evaluation.failed.map((item) => `${item.name}:${item.state}`).join(',')}` : '',
  ].filter(Boolean).join(' ');
  return `submodule-pin prerequisite status=${evaluation.status}${details ? ` ${details}` : ''}`;
}

async function main(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = Number(process.env.FORGEAX_PR_NUMBER);
  const expectedHeadSha = process.env.FORGEAX_PR_HEAD_SHA;
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0 || !expectedHeadSha) {
    throw new Error('GITHUB_REPOSITORY, FORGEAX_PR_NUMBER, and FORGEAX_PR_HEAD_SHA are required');
  }

  const manifest = loadCiContractFiles(process.cwd()).manifest;
  const contexts = prerequisiteContexts(manifest.requiredContexts);
  const timeoutMs = positiveSeconds(process.env.FORGEAX_PREREQUISITE_CHECK_TIMEOUT_SECONDS, 3600) * 1000;
  const intervalMs = positiveSeconds(process.env.FORGEAX_PREREQUISITE_CHECK_INTERVAL_SECONDS, 15) * 1000;

  const startedAt = new Date().toISOString();
  console.log(`Waiting for ${contexts.length} producer-owned PR checks before submodule-pin.`);
  const result = await waitForPrerequisiteChecks({
    expectedHeadSha,
    contexts,
    timeoutMs,
    intervalMs,
    readSnapshot: () => readPullRequestSnapshot(repo, prNumber),
    onReadError: (error) => console.error(`submodule-pin prerequisite observation unavailable: ${String(error)}`),
    onEvaluation: (evaluation) => console.log(formatEvaluation(evaluation)),
  });

  const producerResult = mapEvaluationToProducerResult(result, {
    repository: repo,
    revision: expectedHeadSha,
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    job: process.env.GITHUB_JOB ?? 'submodule-pin-prerequisite-wait',
  }, {
    ...(process.env.CI_JOB_QUEUED_AT ? { queuedAt: process.env.CI_JOB_QUEUED_AT } : {}),
    startedAt: process.env.CI_PRODUCER_STARTED_AT ?? startedAt,
    completedAt: new Date().toISOString(),
  });
  publishProducerResult(producerResult, process.env.FORGEAX_CI_RESULT_PATH);

  if (producerResult.status === 'passed') {
    console.log('All prerequisite CI checks passed; releasing the final submodule-pin validation.');
    return;
  }
  if (producerResult.status === 'superseded') {
    console.log(`PR head changed during prerequisite validation (observed ${result.observedHeadSha}, expected ${expectedHeadSha}); this attempt is superseded.`);
    return;
  }
  const failures = result.failed.map((item) => `${item.name}=${item.state}`).join(', ');
  console.log(`prerequisite CI blocked submodule-pin${failures ? `: ${failures}` : ''}`);
}

if (import.meta.main) {
  await main();
}
