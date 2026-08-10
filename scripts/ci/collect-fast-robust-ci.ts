#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  FAST_ROBUST_CI_EVIDENCE_VERSION,
  parseFastRobustCiEvidence,
  TransferDecisionSchema,
  type FastRobustCiEvidence,
} from './fast-robust-ci-evidence.schema';
import { readWorkflowSources } from './workflow-source-set';

type AnyRecord = Record<string, any>;

type WorkflowInput = {
  path: string;
  content: string;
};

type CollectionInput = {
  workflowFiles?: WorkflowInput[];
  ruleset?: AnyRecord;
  runRoster?: AnyRecord[];
  jobsByRun?: Record<string, AnyRecord[] | AnyRecord>;
  artifactsByRun?: Record<string, AnyRecord[] | AnyRecord>;
  submoduleStatus?: string;
  workspaceManifests?: AnyRecord[];
  source?: Partial<FastRobustCiEvidence['provenance']>;
};

type RuntimeOptions = {
  root: string;
  repo: string;
  engineEvidenceSha: string;
  engineRemoteMainSha: string | null;
  rawDir: string | null;
  maxRuns: number;
};

type RawRef = FastRobustCiEvidence['rawInputs']['files'][number];

class EvidenceError extends Error {
  code: string;
  detail: AnyRecord;

  constructor(code: string, detail: AnyRecord = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: string, detail: AnyRecord = {}): never {
  throw new EvidenceError(code, detail);
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function readJson(path: string, code: string): AnyRecord {
  if (!existsSync(path)) fail(code, { path });
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AnyRecord;
  } catch {
    fail(code, { path });
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function dateSeconds(value: unknown): number | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function ghJson(endpoint: string): AnyRecord {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }),
    ) as AnyRecord;
  } catch (error) {
    fail('ci-evidence-gh-api-failed', { endpoint, detail: String(error) });
  }
}

function ghPage(endpoint: string, key: string): { values: AnyRecord[]; page: AnyRecord } {
  try {
    const page = JSON.parse(
      execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as AnyRecord;
    const values = asArray(page?.[key]) as AnyRecord[];
    if (Number.isInteger(Number(page?.total_count)) && values.length > Number(page.total_count)) {
      fail('ci-evidence-gh-page-invalid', { endpoint, key, expected: page.total_count, actual: values.length });
    }
    return { values, page };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    fail('ci-evidence-gh-page-invalid', { endpoint, key, detail: String(error) });
  }
}

function ghPages(endpoint: string, key: string): { values: AnyRecord[]; pages: AnyRecord[] } {
  let pages: AnyRecord[];
  try {
    const parsed = JSON.parse(
      execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as unknown;
    pages = Array.isArray(parsed) ? (parsed as AnyRecord[]) : [parsed as AnyRecord];
  } catch (error) {
    fail('ci-evidence-gh-pagination-invalid', { endpoint, key, detail: String(error) });
  }
  if (pages.length === 0) fail('ci-evidence-gh-pagination-empty', { endpoint, key });
  const expected = Number(pages[0]?.total_count);
  const values = pages.flatMap((page) => asArray(page?.[key])) as AnyRecord[];
  if (Number.isInteger(expected) && values.length !== expected) {
    fail('ci-evidence-gh-pagination-incomplete', {
      endpoint,
      key,
      expected,
      actual: values.length,
    });
  }
  return { values, pages };
}

function walkFiles(root: string): string[] {
  const results: string[] = [];
  const skip = new Set(['.git', '.forgeax-harness', '.worktrees', 'node_modules', 'dist']);
  function visit(directory: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  visit(root);
  return results.sort();
}

function discoverWorkflowFiles(root: string): WorkflowInput[] {
  return readWorkflowSources(root);
}

function flattenApiInput(value: AnyRecord[] | AnyRecord | undefined, key: string): AnyRecord[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[key])) return value[key] as AnyRecord[];
  return [];
}

function rawFilePath(rawDir: string, name: string): string {
  const destination = resolve(rawDir, name);
  mkdirSync(dirname(destination), { recursive: true });
  return destination;
}

function writeRawText(
  rawDir: string | null,
  refs: RawRef[],
  name: string,
  content: string,
  kind: RawRef['kind'],
): void {
  if (!rawDir) return;
  const destination = rawFilePath(rawDir, name);
  writeFileSync(destination, content);
  refs.push({
    path: destination,
    sha256: sha256(content),
    kind,
    bytes: Buffer.byteLength(content),
  });
}

function writeRawJson(
  rawDir: string | null,
  refs: RawRef[],
  name: string,
  value: unknown,
  kind: RawRef['kind'],
): void {
  writeRawText(rawDir, refs, name, `${JSON.stringify(value, null, 2)}\n`, kind);
}

function normalizeEvents(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').sort();
  if (value && typeof value === 'object') return Object.keys(value as AnyRecord).sort();
  return [];
}

function normalizePermissions(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as AnyRecord)
    .map(([key, permission]) => `${key}:${String(permission)}`)
    .sort();
}

function normalizeNeeds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return asArray(value).filter((item): item is string => typeof item === 'string').sort();
}

function normalizeRunner(value: unknown): {
  kind: 'labels' | 'expression' | 'missing';
  labels: string[];
  expression: string | null;
} {
  if (Array.isArray(value)) {
    const labels = value.filter((item): item is string => typeof item === 'string');
    return { kind: 'labels', labels, expression: null };
  }
  const text = nonEmptyString(value);
  if (text) return { kind: text.includes('${{') ? 'expression' : 'labels', labels: text.includes('${{') ? [] : [text], expression: text.includes('${{') ? text : null };
  return { kind: 'missing', labels: [], expression: null };
}

function trustBoundary(
  events: string[],
  path: string,
): 'pull-request' | 'trusted-base' | 'post-merge-observer' | 'base-owned' | 'unknown' {
  if (events.includes('pull_request_target') || path.includes('.trusted-base')) return 'trusted-base';
  if (events.includes('workflow_run')) return 'post-merge-observer';
  if (events.includes('pull_request')) return 'pull-request';
  if (events.some((event) => ['push', 'schedule', 'workflow_dispatch', 'repository_dispatch'].includes(event))) return 'base-owned';
  return 'unknown';
}

function secretsForBoundary(boundary: ReturnType<typeof trustBoundary>): 'unavailable' | 'available' | 'event-dependent' | 'unknown' {
  if (boundary === 'pull-request') return 'unavailable';
  if (boundary === 'trusted-base' || boundary === 'post-merge-observer') return 'available';
  if (boundary === 'base-owned') return 'event-dependent';
  return 'unknown';
}

function parseWorkflow(path: string, content: string, requiredContexts: string[]): AnyRecord {
  let document: AnyRecord;
  try {
    document = Bun.YAML.parse(content) as AnyRecord;
  } catch (error) {
    fail('ci-evidence-workflow-yaml-invalid', { path, detail: String(error) });
  }
  if (!document || typeof document !== 'object') fail('ci-evidence-workflow-document-invalid', { path });
  const events = normalizeEvents(document.on ?? document.true);
  const workflowBoundary = trustBoundary(events, path);
  const workflowPermissions = normalizePermissions(document.permissions);
  const jobsValue = document.jobs;
  if (!jobsValue || typeof jobsValue !== 'object' || Array.isArray(jobsValue)) {
    fail('ci-evidence-workflow-jobs-missing', { path });
  }
  const jobs = Object.entries(jobsValue as AnyRecord).map(([key, raw]) => {
    if (!raw || typeof raw !== 'object') fail('ci-evidence-workflow-job-invalid', { path, key });
    const job = raw as AnyRecord;
    const jobBoundary = trustBoundary(events, path);
    const permissions = normalizePermissions(job.permissions ?? document.permissions);
    const context = nonEmptyString(job.name) ?? key;
    return {
      key,
      name: context,
      needs: normalizeNeeds(job.needs),
      runner: normalizeRunner(job['runs-on']),
      timeoutMinutes: typeof job['timeout-minutes'] === 'number' && Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 ? job['timeout-minutes'] : null,
      context,
      eventNames: events,
      trustBoundary: jobBoundary,
      permissions,
      secrets: secretsForBoundary(jobBoundary),
    };
  });
  if (jobs.length === 0) fail('ci-evidence-workflow-jobs-empty', { path });
  return {
    path,
    name: nonEmptyString(document.name) ?? basename(path),
    events,
    trustBoundary: workflowBoundary,
    permissions: workflowPermissions,
    jobs,
    requiredContexts,
  };
}

function controlPlane(workflowFiles: WorkflowInput[], requiredContexts: string[]): FastRobustCiEvidence['controlPlane'] {
  const workflows = workflowFiles.map(({ path, content }) => parseWorkflow(path, content, requiredContexts));
  const normalizedWorkflows = workflows.map(({ requiredContexts: _ignored, ...workflow }) => workflow);
  const jobs = normalizedWorkflows.flatMap((workflow) => workflow.jobs.map((job: AnyRecord) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    context: job.context,
  })));
  const needs = normalizedWorkflows.flatMap((workflow) => workflow.jobs.flatMap((job: AnyRecord) => job.needs.map((fromJob: string) => ({
    workflowPath: workflow.path,
    fromJob,
    toJob: job.key,
  }))));
  const runners = normalizedWorkflows.flatMap((workflow) => workflow.jobs.map((job: AnyRecord) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    runnerKind: job.runner.kind,
    labels: job.runner.labels,
    expression: job.runner.expression,
  })));
  const timeouts = normalizedWorkflows.flatMap((workflow) => workflow.jobs.map((job: AnyRecord) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    timeoutMinutes: job.timeoutMinutes,
  })));
  const contexts = normalizedWorkflows.flatMap((workflow) => workflow.jobs.map((job: AnyRecord) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    context: job.context,
    required: requiredContexts.includes(job.context),
  })));
  const events = normalizedWorkflows.flatMap((workflow) => workflow.jobs.flatMap((job: AnyRecord) => workflow.events.map((event: string) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    event,
  }))));
  const trust = normalizedWorkflows.flatMap((workflow) => workflow.jobs.map((job: AnyRecord) => ({
    workflowPath: workflow.path,
    jobKey: job.key,
    boundary: job.trustBoundary,
    secrets: job.secrets,
    permissions: job.permissions,
  })));
  return {
    workflows: normalizedWorkflows,
    requiredContexts: [...requiredContexts].sort(),
    edges: { jobs, needs, runners, timeouts, contexts, events, trust },
  } as FastRobustCiEvidence['controlPlane'];
}

function parseSubmodules(status: string, root: string): FastRobustCiEvidence['census']['recursivePins'] {
  const entries: FastRobustCiEvidence['census']['recursivePins']['entries'] = [];
  for (const line of status.split('\n')) {
    const match = line.match(/^([ +\-U]?)([0-9a-f]{40})\s+(\S+)/);
    if (!match) continue;
    const marker = match[1] || ' ';
    const path = match[3];
    const materialized = existsSync(join(root, path, '.git')) || existsSync(join(root, path, 'HEAD'));
    const manifestStatus = existsSync(join(root, path, 'package.json')) ? 'available' : 'unavailable';
    entries.push({
      path,
      sha: match[2],
      marker: marker === '+' ? 'modified' : marker === '-' ? 'uninitialized' : marker === 'U' ? 'conflicted' : 'clean',
      materialized,
      ownerManifestStatus: manifestStatus,
    });
  }
  return {
    declaredCount: entries.length,
    materializedCount: entries.filter((entry) => entry.materialized).length,
    entries,
  };
}

function pathPatternRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/]+')
    .replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function ownerForPath(path: string, submodulePaths: string[]): string {
  const match = [...submodulePaths]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  return match ? `submodule:${match}` : 'studio-root';
}

function workspaceCensus(root: string, submodulePaths: string[], inputManifests?: AnyRecord[]): FastRobustCiEvidence['census']['workspaceOwners'] {
  const manifests = inputManifests ?? walkFiles(root)
    .filter((path) => path.endsWith('/package.json') || path.endsWith('package.json'))
    .map((path) => {
      try {
        return { path: relative(root, path), data: JSON.parse(readFileSync(path, 'utf8')) as AnyRecord };
      } catch {
        return null;
      }
    })
    .filter((value): value is { path: string; data: AnyRecord } => value !== null);
  const rootManifest = manifests.find((manifest: AnyRecord) => manifest.path === 'package.json');
  const rawWorkspaces = rootManifest?.data?.workspaces;
  const declarations = Array.isArray(rawWorkspaces)
    ? rawWorkspaces.filter((value): value is string => typeof value === 'string')
    : Array.isArray(rawWorkspaces?.packages)
      ? rawWorkspaces.packages.filter((value: unknown): value is string => typeof value === 'string')
      : [];
  const manifestPaths = manifests.map((manifest: AnyRecord) => manifest.path);
  const entries: FastRobustCiEvidence['census']['workspaceOwners']['entries'] = [];
  for (const pattern of declarations) {
    const matches = manifestPaths.filter((path) => {
      if (path === 'package.json') return false;
      const directory = path.replace(/\/package\.json$/, '');
      return pathPatternRegex(pattern).test(directory);
    });
    if (matches.length === 0) {
      entries.push({
        workspacePattern: pattern,
        manifestPath: null,
        packageName: null,
        owner: ownerForPath(pattern.replace(/\/\*.*$/, ''), submodulePaths),
        status: 'unavailable',
      });
      continue;
    }
    for (const manifestPath of matches) {
      const manifest = manifests.find((candidate: AnyRecord) => candidate.path === manifestPath) as AnyRecord;
      entries.push({
        workspacePattern: pattern,
        manifestPath,
        packageName: nonEmptyString(manifest?.data?.name),
        owner: ownerForPath(manifestPath, submodulePaths),
        status: 'resolved',
      });
    }
  }
  const ownerCounts = Object.fromEntries(
    [...new Set(entries.map((entry) => entry.owner))].sort().map((owner) => [owner, entries.filter((entry) => entry.owner === owner).length]),
  );
  return { declarationCount: declarations.length, entries, ownerCounts };
}

function normalizeJob(job: AnyRecord, index: number): AnyRecord {
  const steps = asArray(job.steps).map((step) => ({
    name: nonEmptyString(step?.name) ?? `step-${index + 1}`,
    conclusion: nonEmptyString(step?.conclusion),
    completedAt: nonEmptyString(step?.completed_at),
  }));
  return {
    id: Number(job.id) > 0 ? Number(job.id) : index + 1,
    name: nonEmptyString(job.name) ?? `job-${index + 1}`,
    status: nonEmptyString(job.status),
    conclusion: nonEmptyString(job.conclusion),
    runnerName: nonEmptyString(job.runner_name),
    runnerGroup: nonEmptyString(job.runner_group_name),
    labels: asArray(job.labels).filter((label): label is string => typeof label === 'string').sort(),
    createdAt: nonEmptyString(job.created_at),
    startedAt: nonEmptyString(job.started_at),
    completedAt: nonEmptyString(job.completed_at),
    steps,
    failureOwnership: job.failureOwnership ?? null,
  };
}

function normalizeArtifact(artifact: AnyRecord, index: number): AnyRecord {
  return {
    id: Number(artifact.id) > 0 ? Number(artifact.id) : index + 1,
    name: nonEmptyString(artifact.name) ?? `artifact-${index + 1}`,
    sizeBytes: Number.isFinite(Number(artifact.size_in_bytes)) && Number(artifact.size_in_bytes) >= 0 ? Number(artifact.size_in_bytes) : 0,
    createdAt: nonEmptyString(artifact.created_at),
    expired: artifact.expired === true,
    workflowRunId: Number(artifact.workflow_run?.id ?? artifact.workflowRunId) > 0 ? Number(artifact.workflow_run?.id ?? artifact.workflowRunId) : null,
  };
}

function rosterKey(jobs: AnyRecord[]): string | null {
  return jobs.length === 0 ? null : jobs.map((job) => job.name).sort().join('|');
}

function runnerClassKey(jobs: AnyRecord[]): string | null {
  if (jobs.length === 0) return null;
  return jobs.map((job) => `${job.name}:${job.labels.length === 0 ? 'missing' : job.labels.join(',')}`).sort().join('|');
}

function outcomeKey(jobs: AnyRecord[]): string | null {
  if (jobs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const result = job.conclusion ?? 'null';
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}:${count}`).join('|');
}

function firstFailure(jobs: AnyRecord[], createdAt: string | null): AnyRecord {
  const candidates: AnyRecord[] = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.conclusion !== 'failure') continue;
      candidates.push({
        at: step.completedAt ?? job.completedAt,
        jobName: job.name,
        stepName: step.name,
        ownership: job.failureOwnership ?? 'unknown',
      });
    }
    if (job.conclusion === 'failure' && job.steps.every((step: AnyRecord) => step.conclusion !== 'failure')) {
      candidates.push({ at: job.completedAt, jobName: job.name, stepName: null, ownership: job.failureOwnership ?? 'unknown' });
    }
  }
  candidates.sort((left, right) => (dateSeconds(left.at) ?? Number.POSITIVE_INFINITY) - (dateSeconds(right.at) ?? Number.POSITIVE_INFINITY));
  const candidate = candidates[0];
  if (!candidate || !candidate.at || !createdAt) {
    return {
      status: 'not-observed',
      occurredAt: null,
      secondsFromAdmission: null,
      jobName: null,
      stepName: null,
      ownership: 'unknown',
      noClaimReason: 'no-failed-step-fact',
    };
  }
  const seconds = (dateSeconds(candidate.at) ?? 0) - (dateSeconds(createdAt) ?? 0);
  if (candidate.ownership === 'repository') {
    return {
      status: 'claimed',
      occurredAt: candidate.at,
      secondsFromAdmission: Math.max(0, seconds),
      jobName: candidate.jobName,
      stepName: candidate.stepName,
      ownership: 'repository',
      noClaimReason: null,
    };
  }
  return {
    status: 'candidate-no-claim',
    occurredAt: candidate.at,
    secondsFromAdmission: Math.max(0, seconds),
    jobName: candidate.jobName,
    stepName: candidate.stepName,
    ownership: candidate.ownership === 'transport' || candidate.ownership === 'external' ? candidate.ownership : 'unknown',
    noClaimReason: candidate.ownership === 'transport' ? 'failure-ownership-transport' : 'failure-owner-not-proven',
  };
}

function runFact(run: AnyRecord, rawJobs: AnyRecord[], rawArtifacts: AnyRecord[]): AnyRecord {
  const jobs = rawJobs.map(normalizeJob);
  const artifacts = rawArtifacts.map(normalizeArtifact);
  const createdAt = nonEmptyString(run.created_at ?? run.createdAt);
  const startedAt = nonEmptyString(run.run_started_at ?? run.startedAt);
  const jobStarts = jobs.map((job) => dateSeconds(job.startedAt)).filter((value): value is number => value !== null);
  const jobEnds = jobs.map((job) => dateSeconds(job.completedAt)).filter((value): value is number => value !== null);
  const artifactReady = artifacts.map((artifact) => dateSeconds(artifact.createdAt)).filter((value): value is number => value !== null).sort((left, right) => right - left)[0] ?? null;
  const createdSeconds = dateSeconds(createdAt);
  const timing = {
    admissionSeconds: createdSeconds !== null && dateSeconds(startedAt) !== null ? Math.max(0, (dateSeconds(startedAt) as number) - createdSeconds) : null,
    queueProxySeconds: createdSeconds !== null && jobStarts.length > 0 ? Math.max(0, Math.min(...jobStarts) - createdSeconds) : null,
    activeDurationSeconds: jobStarts.length > 0 && jobEnds.length > 0 ? Math.max(0, Math.max(...jobEnds) - Math.min(...jobStarts)) : null,
    artifactReadySeconds: createdSeconds !== null && artifactReady !== null ? Math.max(0, artifactReady - createdSeconds) : null,
    firstDecisiveFailure: firstFailure(jobs, createdAt),
  };
  const jobsTerminal = jobs.length > 0 && jobs.every((job) => job.status === 'completed' || job.conclusion !== null);
  return {
    runId: Number(run.id),
    runAttempt: Number(run.run_attempt ?? run.runAttempt) > 0 ? Number(run.run_attempt ?? run.runAttempt) : null,
    event: nonEmptyString(run.event),
    status: nonEmptyString(run.status),
    conclusion: nonEmptyString(run.conclusion),
    headSha: nonEmptyString(run.head_sha ?? run.headSha),
    headBranch: nonEmptyString(run.head_branch ?? run.headBranch),
    createdAt,
    startedAt,
    updatedAt: nonEmptyString(run.updated_at ?? run.updatedAt),
    rosterKey: rosterKey(jobs),
    runnerClassKey: runnerClassKey(jobs),
    outcomeKey: outcomeKey(jobs),
    jobsTerminal,
    jobs,
    artifacts,
    timing,
    eligibility: { comparable: false, reasons: [] },
  };
}

function mode(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function assignComparability(runs: AnyRecord[]): { canonical: AnyRecord; samples: AnyRecord[]; reasons: AnyRecord[] } {
  const base = runs.filter((run) => run.jobs.length > 0 && run.jobsTerminal && run.status === 'completed' && run.event === 'pull_request' && run.runAttempt === 1 && run.rosterKey && run.runnerClassKey);
  const canonicalRoster = mode(base.map((run) => run.rosterKey));
  const canonicalRunner = mode(base.filter((run) => run.rosterKey === canonicalRoster).map((run) => run.runnerClassKey));
  const samples: AnyRecord[] = [];
  const reasonMap = new Map<string, { count: number; runIds: number[]; detail: string }>();
  const addReason = (code: string, runId: number, detail: string) => {
    const current = reasonMap.get(code) ?? { count: 0, runIds: [], detail };
    current.count += 1;
    if (current.runIds.length < 50) current.runIds.push(runId);
    reasonMap.set(code, current);
  };
  for (const run of runs) {
    const reasons: string[] = [];
    if (run.jobs.length === 0) reasons.push('zero-job');
    if (run.status !== 'completed' || !run.jobsTerminal) reasons.push('nonterminal');
    if (run.event !== 'pull_request') reasons.push('event-not-pull-request');
    if (run.runAttempt !== 1) reasons.push('attempt-not-one');
    if (canonicalRoster && run.rosterKey !== canonicalRoster && run.jobs.length > 0) reasons.push('mixed-roster');
    if (canonicalRunner && run.runnerClassKey !== canonicalRunner && run.jobs.length > 0) reasons.push('mixed-runner-class');
    const comparable = reasons.length === 0 && run.rosterKey === canonicalRoster && run.runnerClassKey === canonicalRunner;
    run.eligibility = { comparable, reasons };
    if (comparable) {
      const noClaimReasons: string[] = [];
      if (run.timing.admissionSeconds === null) noClaimReasons.push('admission-timestamp-missing');
      if (run.timing.queueProxySeconds === null) noClaimReasons.push('queue-proxy-missing');
      if (run.timing.activeDurationSeconds === null) noClaimReasons.push('active-duration-missing');
      if (run.timing.artifactReadySeconds === null) noClaimReasons.push('artifact-ready-not-observed');
      if (run.timing.firstDecisiveFailure.status !== 'claimed') noClaimReasons.push(run.timing.firstDecisiveFailure.noClaimReason ?? 'first-failure-no-claim');
      for (const reason of noClaimReasons) addReason(reason, run.runId, `Comparable run ${run.runId} cannot claim this fact without a complete owner/timestamp/artifact input.`);
      samples.push({
        runId: run.runId,
        event: run.event,
        runAttempt: run.runAttempt,
        rosterKey: run.rosterKey,
        runnerClassKey: run.runnerClassKey,
        admissionSeconds: run.timing.admissionSeconds,
        queueProxySeconds: run.timing.queueProxySeconds,
        activeDurationSeconds: run.timing.activeDurationSeconds,
        artifactReadySeconds: run.timing.artifactReadySeconds,
        firstDecisiveFailure: run.timing.firstDecisiveFailure,
        noClaimReasons,
      });
    } else {
      for (const reason of reasons) addReason(reason, run.runId, `Run ${run.runId} is excluded from same-topology comparable admission.`);
    }
  }
  if (samples.length < 20) addReason('insufficient-comparable-samples', -1, 'At least 20 same-roster, same-runner-class, pull_request attempt-one terminal samples are required before timing claims are admitted.');
  const reasons = [...reasonMap.entries()].map(([code, value]) => ({ code, ...value, runIds: value.runIds.filter((runId) => runId > 0) }));
  return {
    canonical: {
      rosterKey: canonicalRoster,
      runnerClassKey: canonicalRunner,
      event: canonicalRoster ? 'pull_request' : null,
      runAttempt: canonicalRoster ? 1 : null,
    },
    samples,
    reasons,
  };
}

function requiredContextsFromRuleset(ruleset: AnyRecord | undefined): string[] {
  if (Array.isArray(ruleset?.requiredContexts)) return ruleset.requiredContexts.filter((value: unknown): value is string => typeof value === 'string').sort();
  return asArray(ruleset?.rules)
    .filter((rule) => rule?.type === 'required_status_checks')
    .flatMap((rule) => asArray(rule?.parameters?.required_status_checks))
    .map((entry) => nonEmptyString(entry?.context))
    .filter((value): value is string => value !== null)
    .sort();
}

function transferDecisions(): FastRobustCiEvidence['transferDecisions'] {
  const url = new URL('./fast-robust-ci-transfer-decisions.json', import.meta.url);
  const raw = JSON.parse(readFileSync(url, 'utf8')) as unknown;
  if (!Array.isArray(raw)) fail('ci-evidence-transfer-decisions-invalid');
  const parsed = raw.map((value) => TransferDecisionSchema.parse(value));
  if (parsed.length < 18) fail('ci-evidence-transfer-decisions-incomplete', { count: parsed.length });
  return parsed;
}

function gatherLiveInput(options: RuntimeOptions, rawRefs: RawRef[]): CollectionInput {
  const workflowFiles = discoverWorkflowFiles(options.root);
  if (workflowFiles.length === 0) fail('ci-evidence-workflows-missing', { root: options.root });
  for (const workflow of workflowFiles) writeRawText(options.rawDir, rawRefs, `workflows/${workflow.path.replaceAll('/', '__')}`, workflow.content, 'workflow');
  const ruleset = ghJson(`repos/${options.repo}/rulesets/16532229`);
  writeRawJson(options.rawDir, rawRefs, 'ruleset-16532229.json', ruleset, 'ruleset');
  const runPage = ghPage(`repos/${options.repo}/actions/workflows/ci.yml/runs?per_page=${options.maxRuns}`, 'workflow_runs');
  const runs = { values: runPage.values.slice(0, options.maxRuns), pages: [runPage.page] };
  writeRawJson(options.rawDir, rawRefs, 'ci-run-roster.json', { pages: runs.pages, workflowRuns: runs.values }, 'runs');
  const jobsByRun: Record<string, AnyRecord[]> = {};
  const artifactsByRun: Record<string, AnyRecord[]> = {};
  for (const [index, run] of runs.values.entries()) {
    const runId = Number(run.id);
    if (!Number.isInteger(runId) || runId <= 0) continue;
    if (index % 10 === 0) process.stderr.write(`[fast-robust-ci] collecting run ${index + 1}/${runs.values.length}\n`);
    const jobs = ghPages(`repos/${options.repo}/actions/runs/${runId}/jobs?per_page=100`, 'jobs');
    const artifacts = ghPages(`repos/${options.repo}/actions/runs/${runId}/artifacts?per_page=100`, 'artifacts');
    jobsByRun[String(runId)] = jobs.values;
    artifactsByRun[String(runId)] = artifacts.values;
    writeRawJson(options.rawDir, rawRefs, `jobs/${runId}.json`, { pages: jobs.pages, jobs: jobs.values }, 'jobs');
    writeRawJson(options.rawDir, rawRefs, `artifacts/${runId}.json`, { pages: artifacts.pages, artifacts: artifacts.values }, 'artifacts');
  }
  const submoduleStatus = git(options.root, ['submodule', 'status', '--recursive']) ?? '';
  writeRawText(options.rawDir, rawRefs, 'submodule-status.txt', submoduleStatus, 'submodules');
  const workspaceManifests = walkFiles(options.root)
    .filter((path) => path.endsWith('/package.json') || path.endsWith('package.json'))
    .map((path) => {
      try {
        return { path: relative(options.root, path), data: JSON.parse(readFileSync(path, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter((value): value is { path: string; data: AnyRecord } => value !== null);
  writeRawJson(options.rawDir, rawRefs, 'workspace-manifests.json', workspaceManifests, 'workspace');
  return { workflowFiles, ruleset, runRoster: runs.values, jobsByRun, artifactsByRun, submoduleStatus, workspaceManifests };
}

function collectEvidence(input: CollectionInput, options: RuntimeOptions, rawRefs: RawRef[]): FastRobustCiEvidence {
  const source = input.source ?? {};
  const studioSha = source.studioSha ?? git(options.root, ['rev-parse', 'HEAD']);
  const studioOriginMainSha = source.studioOriginMainSha ?? git(options.root, ['rev-parse', 'origin/main']);
  const studioRemoteMainSha = source.studioRemoteMainSha ?? (git(options.root, ['ls-remote', 'origin', 'refs/heads/main'])?.split(/\s+/)[0] ?? null);
  if (!studioSha || !studioOriginMainSha) fail('ci-evidence-studio-sha-missing');
  const workflowFiles = input.workflowFiles ?? [];
  const requiredContexts = requiredContextsFromRuleset(input.ruleset);
  const plane = controlPlane(workflowFiles, requiredContexts);
  const submoduleStatus = input.submoduleStatus ?? git(options.root, ['submodule', 'status', '--recursive']) ?? '';
  const submodulePaths = submoduleStatus.split('\n').map((line) => line.match(/^([ +\-U]?)[0-9a-f]{40}\s+(\S+)/)?.[2]).filter((value): value is string => value !== undefined);
  const pins = parseSubmodules(submoduleStatus, options.root);
  const census = {
    recursivePins: pins,
    workspaceOwners: workspaceCensus(options.root, submodulePaths, input.workspaceManifests),
  };
  const runRoster = input.runRoster ?? [];
  const runs = runRoster.map((run) => {
    const runId = String(run.id);
    return runFact(run, flattenApiInput(input.jobsByRun?.[runId], 'jobs'), flattenApiInput(input.artifactsByRun?.[runId], 'artifacts'));
  });
  if (runs.some((run) => run.jobs.length === 0) && runRoster.length === 1) fail('ci-evidence-zero-job', { runId: runs.find((run) => run.jobs.length === 0)?.runId });
  const admission = assignComparability(runs);
  const history = {
    workflow: '.github/workflows/ci.yml' as const,
    rawRunCount: runRoster.length,
    rawJobRunCount: Object.keys(input.jobsByRun ?? {}).length,
    rawArtifactRunCount: Object.keys(input.artifactsByRun ?? {}).length,
    canonicalTopology: admission.canonical,
    runs,
    comparableSamples: admission.samples,
    population: {
      requiredMinimum: 20 as const,
      sampleCount: admission.samples.length,
      status: admission.samples.length >= 20 ? 'pass' as const : 'no-claim' as const,
      noClaimReasons: admission.reasons,
    },
  };
  const dirty = (git(options.root, ['status', '--porcelain']) ?? '') !== '';
  const evidence = {
    schemaVersion: FAST_ROBUST_CI_EVIDENCE_VERSION,
    collector: 'forgeax-studio-fast-robust-ci' as const,
    provenance: {
      studioSha,
      studioOriginMainSha,
      studioRemoteMainSha,
      engineEvidenceSha: options.engineEvidenceSha,
      engineRemoteMainSha: options.engineRemoteMainSha,
      collectedAt: new Date().toISOString(),
      worktreeDirty: dirty,
    },
    controlPlane: plane,
    census,
    history,
    transferDecisions: transferDecisions(),
    rawInputs: { directory: options.rawDir, files: rawRefs },
  };
  return parseFastRobustCiEvidence(evidence);
}

export function collectFromFixture(input: CollectionInput, options: RuntimeOptions = {
  root: process.cwd(),
  repo: 'ForgeaX-Games/forgeax-studio',
  engineEvidenceSha: '6c06e414a7f5c5c2dab9facd5919c04513b102ce',
  engineRemoteMainSha: null,
  rawDir: null,
  maxRuns: 100,
}): FastRobustCiEvidence {
  const refs: RawRef[] = [];
  return collectEvidence(input, options, refs);
}

export function main(): void {
  const root = resolve(arg('--root') ?? process.cwd());
  const inputPath = arg('--input');
  const outPath = resolve(arg('--out') ?? join(root, 'ci-fast-robust-ci-evidence.json'));
  const rawDirArg = arg('--raw-dir');
  const rawDir = rawDirArg ? resolve(rawDirArg) : null;
  if (rawDir) mkdirSync(rawDir, { recursive: true });
  const engineEvidenceSha = arg('--engine-evidence-sha') ?? '6c06e414a7f5c5c2dab9facd5919c04513b102ce';
  const engineRemoteMainSha = arg('--engine-remote-main-sha');
  const maxRuns = Number(arg('--max-runs') ?? 100);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) {
    process.stdout.write(`${JSON.stringify({ status: 'invalid', code: 'ci-evidence-max-runs-invalid', maxRuns })}\n`);
    process.exitCode = 1;
    return;
  }
  const options: RuntimeOptions = {
    root,
    repo: arg('--repo') ?? 'ForgeaX-Games/forgeax-studio',
    engineEvidenceSha,
    engineRemoteMainSha,
    rawDir,
    maxRuns,
  };
  try {
    const refs: RawRef[] = [];
    const input = inputPath ? readJson(resolve(inputPath), 'ci-evidence-input-invalid') as CollectionInput : gatherLiveInput(options, refs);
    if (inputPath) {
      for (const workflow of input.workflowFiles ?? []) writeRawText(rawDir, refs, `workflows/${workflow.path.replaceAll('/', '__')}`, workflow.content, 'workflow');
      writeRawJson(rawDir, refs, 'ruleset.json', input.ruleset ?? {}, 'ruleset');
      writeRawJson(rawDir, refs, 'ci-run-roster.json', input.runRoster ?? [], 'runs');
      writeRawText(rawDir, refs, 'submodule-status.txt', input.submoduleStatus ?? '', 'submodules');
      writeRawJson(rawDir, refs, 'workspace-manifests.json', input.workspaceManifests ?? [], 'workspace');
      for (const [runId, jobs] of Object.entries(input.jobsByRun ?? {})) writeRawJson(rawDir, refs, `jobs/${runId}.json`, jobs, 'jobs');
      for (const [runId, artifacts] of Object.entries(input.artifactsByRun ?? {})) writeRawJson(rawDir, refs, `artifacts/${runId}.json`, artifacts, 'artifacts');
    }
    const evidence = collectEvidence(input, options, refs);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'ok', out: outPath, comparableSamples: evidence.history.population.sampleCount, rawRunCount: evidence.history.rawRunCount })}\n`);
  } catch (error) {
    if (error instanceof EvidenceError) {
      process.stdout.write(`${JSON.stringify({ status: 'invalid', code: error.code, ...error.detail })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ status: 'invalid', code: 'ci-evidence-schema-invalid', detail: String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
