#!/usr/bin/env bun

import { appendFileSync } from 'node:fs';

type WorkflowRun = { created_at?: unknown };
type WorkflowJob = { name?: unknown; status?: unknown; started_at?: unknown };
type WorkflowJobs = { jobs?: unknown };

export type CiJobTiming = {
  queuedAt: string;
  startedAt: string;
};

function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * GitHub does not expose a distinct dependency-release timestamp. Phase A's
 * queue metric therefore uses workflow-run creation through job start. This
 * deliberately includes both DAG wait and runner scheduling delay.
 */
export function selectCiJobTiming(run: WorkflowRun, payload: WorkflowJobs, displayName: string): CiJobTiming | undefined {
  if (!isoTimestamp(run.created_at) || !Array.isArray(payload.jobs)) return undefined;
  const candidates = (payload.jobs as WorkflowJob[])
    .filter((job) => job.name === displayName && isoTimestamp(job.started_at))
    .sort((left, right) => Date.parse(String(left.started_at)) - Date.parse(String(right.started_at)));
  const running = candidates.filter((job) => job.status === 'in_progress').at(-1);
  const selected = running ?? candidates.at(-1);
  if (!selected || !isoTimestamp(selected.started_at)) return undefined;
  if (Date.parse(selected.started_at) < Date.parse(run.created_at)) return undefined;
  return { queuedAt: run.created_at, startedAt: selected.started_at };
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'forgeax-studio-ci-timing',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}

async function capture(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const displayName = process.env.CI_JOB_DISPLAY_NAME;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const environmentPath = process.env.GITHUB_ENV;
  if (!repository || !runId || !runAttempt || !displayName || !token || !environmentPath) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, CI_JOB_DISPLAY_NAME, GH_TOKEN, and GITHUB_ENV are required');
  }

  const [run, jobs] = await Promise.all([
    githubJson(`repos/${repository}/actions/runs/${runId}`, token),
    githubJson(`repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`, token),
  ]);
  const timing = selectCiJobTiming(run as WorkflowRun, jobs as WorkflowJobs, displayName);
  if (!timing) throw new Error(`current workflow job ${displayName} was not observable`);
  appendFileSync(environmentPath, `CI_JOB_QUEUED_AT=${timing.queuedAt}\nCI_PRODUCER_STARTED_AT=${timing.startedAt}\n`);
  console.log(`Captured queue timing for ${displayName}: ${Date.parse(timing.startedAt) - Date.parse(timing.queuedAt)} ms`);
}

if (import.meta.main) {
  try {
    await capture();
  } catch (error) {
    // Observability must never replace the producer's actual verdict. The
    // first-step fallback still records execution duration if GitHub's API is
    // temporarily unavailable; queueDurationMs is simply omitted.
    console.warn(`::warning title=CI queue timing unavailable::${String(error)}`);
  }
}
