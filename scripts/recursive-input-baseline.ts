#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  computeInputDigest,
  projectGitlinkGraph,
  readAuthoritativeGitGraph,
  type InputClass,
  type ProjectedGitGraph,
  type ReadinessByClass,
  type RecursiveInputResult,
  type TrustScope,
} from '../packages/recursive-input-contract/src/index.ts';
import {
  createAttemptStore,
  readCurrentReady,
  type AttemptStore,
} from '../packages/recursive-input-contract/src/attempt-store.ts';
import { verifyCurrentReady } from '../packages/recursive-input-contract/src/publisher.ts';
import {
  produceRecursiveInputResult,
  type MaterializationFacts,
} from '../packages/recursive-input-contract/src/producer.ts';

const SAMPLE_COUNT = 5;
const BASELINE_EVIDENCE = '.forgeax-harness/forgeax-loop/feat-20260808-recursive-input-materialization-contract/evidence/recursive-input-baseline.jsonl';
const DEFAULT_CLASSES = ['source'] as const satisfies readonly InputClass[];
const DEFAULT_TRUST_SCOPE = 'local-fixed-worktree' as const satisfies TrustScope;

type BaselineMode = 'cold' | 'warm-exact' | 'warm-invalidated-to-cold';

type BaselineOptions = {
  root: string;
  output: string;
  requestedInputClasses: readonly InputClass[];
  trustScope: TrustScope;
};

type BaselineSample = {
  recordType: 'sample';
  evidenceType: 'recursive-input-baseline';
  mode: BaselineMode;
  sampleIndex: number;
  rootRevision: string;
  sourceIdentity: ProjectedGitGraph['sourceIdentity'];
  trustScope: TrustScope;
  requestedInputClasses: InputClass[];
  job: string;
  attempt: string;
  status: 'ready';
  inputDigest: string;
  digestAlgorithm: 'sha256';
  readiness: ReadinessByClass;
  elapsedMs: number;
  bytes: number;
  cacheSize: number;
  identityValidated: true;
  coldFallback: boolean;
  noClaim: true;
  claim: 'no-claim';
};

type BaselineSummary = {
  recordType: 'summary';
  evidenceType: 'recursive-input-baseline';
  mode: BaselineMode;
  sampleCount: number;
  sampleIds: string[];
  rootRevision: string;
  sourceIdentity: ProjectedGitGraph['sourceIdentity'];
  trustScope: TrustScope;
  requestedInputClasses: InputClass[];
  inputDigest: string;
  digestEquivalent: true;
  readinessEquivalent: true;
  elapsedMs: { median: number; max: number };
  bytes: { median: number; max: number };
  cacheSize: { median: number; max: number };
  noClaim: true;
  claim: 'no-claim';
  observation: 'elapsedMs, bytes, and cacheSize are recorded observations only; they do not decide correctness';
};

type BaselineMetadata = {
  recordType: 'metadata';
  evidenceType: 'recursive-input-baseline';
  rootRevision: string;
  sourceIdentity: ProjectedGitGraph['sourceIdentity'];
  trustScope: TrustScope;
  requestedInputClasses: InputClass[];
  sampleCountPerMode: number;
  modes: BaselineMode[];
  noClaim: true;
  claim: 'no-claim';
  observation: 'This file records correctness-equivalence facts and raw observations; it contains no threshold or performance verdict';
};

type BaselineRecord = BaselineMetadata | BaselineSample | BaselineSummary;

type Context = {
  graph: ProjectedGitGraph;
  requestedInputClasses: readonly InputClass[];
  trustScope: TrustScope;
  job: string;
  attempt: string;
};

function usage(): string {
  return [
    'Usage: bun scripts/recursive-input-baseline.ts [options]',
    '',
    'Options:',
    '  --root <path>      Fixed worktree root (default: repository root)',
    '  --output <path>    JSONL evidence output (default: planned evidence path)',
    '  --help             Show this help',
  ].join('\n');
}

function parseOptions(argv: readonly string[]): BaselineOptions | null {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
  let selectedRoot = root;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (arg === '--root' || arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--root') selectedRoot = resolve(value);
      else output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  return {
    root: selectedRoot,
    output: output ?? join(selectedRoot, BASELINE_EVIDENCE),
    requestedInputClasses: DEFAULT_CLASSES,
    trustScope: DEFAULT_TRUST_SCOPE,
  };
}

function contextFor(
  graph: ProjectedGitGraph,
  requestedInputClasses: readonly InputClass[],
  trustScope: TrustScope,
  attempt: string,
): Context {
  return {
    graph,
    requestedInputClasses,
    trustScope,
    job: 'recursive-input-baseline',
    attempt,
  };
}

function readyFacts(mode: 'cold' | 'warm', verified = true): MaterializationFacts {
  return {
    status: 'ready',
    credentialCleanup: { status: 'passed' },
    warm: { mode, verified },
    readiness: { source: { status: 'ready' } },
  };
}

function requireReady(
  validation: { ok: boolean; result: RecursiveInputResult },
  label: string,
): RecursiveInputResult & { status: 'ready' } {
  if (!validation.ok || validation.result.status !== 'ready') {
    const failure = validation.result.status === 'non-ready' ? validation.result.failure.code : 'unknown';
    throw new Error(`${label} did not produce ready result: ${failure}`);
  }
  return validation.result;
}

function serializedBytes(result: RecursiveInputResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const entry = statSync(path);
  if (entry.isFile()) return entry.size;
  return readdirSync(path, { withFileTypes: true })
    .reduce((total, child) => total + directoryBytes(join(path, child.name)), 0);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function sampleRecord(
  mode: BaselineMode,
  sampleIndex: number,
  options: BaselineOptions,
  graph: ProjectedGitGraph,
  attempt: string,
  result: RecursiveInputResult & { status: 'ready' },
  store: AttemptStore,
  startedAt: number,
  coldFallback: boolean,
): BaselineSample {
  const elapsedMs = Number(Math.max(0, performance.now() - startedAt).toFixed(3));
  return {
    recordType: 'sample',
    evidenceType: 'recursive-input-baseline',
    mode,
    sampleIndex,
    rootRevision: graph.sourceIdentity.revision,
    sourceIdentity: graph.sourceIdentity,
    trustScope: options.trustScope,
    requestedInputClasses: [...options.requestedInputClasses],
    job: 'recursive-input-baseline',
    attempt,
    status: result.status,
    inputDigest: result.content.inputDigest,
    digestAlgorithm: result.content.digestAlgorithm,
    readiness: result.readiness,
    elapsedMs,
    bytes: serializedBytes(result),
    cacheSize: directoryBytes(store.directory),
    identityValidated: true,
    coldFallback,
    noClaim: true,
    claim: 'no-claim',
  };
}

function runColdSample(
  sampleIndex: number,
  options: BaselineOptions,
  graph: ProjectedGitGraph,
): BaselineSample {
  const attempt = `cold-${sampleIndex}`;
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-baseline-cold-'));
  const store = createAttemptStore(root);
  try {
    const startedAt = performance.now();
    const produced = produceRecursiveInputResult({
      store,
      context: contextFor(graph, options.requestedInputClasses, options.trustScope, attempt),
      producer: 'recursive-input-baseline-cold',
      facts: readyFacts('cold'),
    });
    const result = requireReady(produced, `cold sample ${sampleIndex}`);
    const verified = requireReady(
      verifyCurrentReady({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, attempt),
      }),
      `cold verify ${sampleIndex}`,
    );
    if (verified.content.inputDigest !== result.content.inputDigest) {
      throw new Error(`cold sample ${sampleIndex} changed inputDigest during verify`);
    }
    return sampleRecord('cold', sampleIndex, options, graph, attempt, verified, store, startedAt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runWarmExactSample(
  sampleIndex: number,
  options: BaselineOptions,
  graph: ProjectedGitGraph,
): BaselineSample {
  const attempt = `warm-${sampleIndex}`;
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-baseline-warm-'));
  const store = createAttemptStore(root);
  try {
    const seeded = requireReady(
      produceRecursiveInputResult({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, attempt),
        producer: 'recursive-input-baseline-warm-seed',
        facts: readyFacts('warm'),
      }),
      `warm seed ${sampleIndex}`,
    );
    const startedAt = performance.now();
    const verified = requireReady(
      verifyCurrentReady({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, attempt),
      }),
      `warm verify ${sampleIndex}`,
    );
    if (verified.content.inputDigest !== seeded.content.inputDigest) {
      throw new Error(`warm sample ${sampleIndex} changed inputDigest during verify`);
    }
    return sampleRecord('warm-exact', sampleIndex, options, graph, attempt, verified, store, startedAt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runWarmInvalidatedToColdSample(
  sampleIndex: number,
  options: BaselineOptions,
  graph: ProjectedGitGraph,
): BaselineSample {
  const seedAttempt = `warm-seed-${sampleIndex}`;
  const invalidatedAttempt = `warm-invalidated-${sampleIndex}`;
  const coldAttempt = `cold-fallback-${sampleIndex}`;
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-baseline-fallback-'));
  const store = createAttemptStore(root);
  try {
    requireReady(
      produceRecursiveInputResult({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, seedAttempt),
        producer: 'recursive-input-baseline-warm-seed',
        facts: readyFacts('warm'),
      }),
      `warm fallback seed ${sampleIndex}`,
    );
    const startedAt = performance.now();
    const invalidated = produceRecursiveInputResult({
      store,
      context: contextFor(graph, options.requestedInputClasses, options.trustScope, invalidatedAttempt),
      producer: 'recursive-input-baseline-warm-invalidator',
      facts: readyFacts('warm', false),
    });
    if (invalidated.result.status !== 'non-ready' || readCurrentReady(store) !== null) {
      throw new Error(`warm invalidation ${sampleIndex} did not remove current ready`);
    }
    const cold = requireReady(
      produceRecursiveInputResult({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, coldAttempt),
        producer: 'recursive-input-baseline-cold-fallback',
        facts: readyFacts('cold'),
      }),
      `cold fallback ${sampleIndex}`,
    );
    const verified = requireReady(
      verifyCurrentReady({
        store,
        context: contextFor(graph, options.requestedInputClasses, options.trustScope, coldAttempt),
      }),
      `cold fallback verify ${sampleIndex}`,
    );
    if (cold.content.inputDigest !== verified.content.inputDigest) {
      throw new Error(`cold fallback ${sampleIndex} changed inputDigest during verify`);
    }
    return sampleRecord('warm-invalidated-to-cold', sampleIndex, options, graph, coldAttempt, verified, store, startedAt, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function summarize(mode: BaselineMode, samples: readonly BaselineSample[]): BaselineSummary {
  const first = samples[0];
  if (!first || samples.length !== SAMPLE_COUNT) {
    throw new Error(`${mode} requires exactly ${SAMPLE_COUNT} samples`);
  }
  const digest = first.inputDigest;
  const readiness = JSON.stringify(first.readiness);
  if (samples.some((sample) => sample.inputDigest !== digest)) {
    throw new Error(`${mode} samples do not have equivalent inputDigest`);
  }
  if (samples.some((sample) => JSON.stringify(sample.readiness) !== readiness)) {
    throw new Error(`${mode} samples do not have equivalent readiness`);
  }
  return {
    recordType: 'summary',
    evidenceType: 'recursive-input-baseline',
    mode,
    sampleCount: samples.length,
    sampleIds: samples.map((sample) => `${mode}-${sample.sampleIndex}`),
    rootRevision: first.rootRevision,
    sourceIdentity: first.sourceIdentity,
    trustScope: first.trustScope,
    requestedInputClasses: first.requestedInputClasses,
    inputDigest: digest,
    digestEquivalent: true,
    readinessEquivalent: true,
    elapsedMs: {
      median: median(samples.map((sample) => sample.elapsedMs)),
      max: Math.max(...samples.map((sample) => sample.elapsedMs)),
    },
    bytes: {
      median: median(samples.map((sample) => sample.bytes)),
      max: Math.max(...samples.map((sample) => sample.bytes)),
    },
    cacheSize: {
      median: median(samples.map((sample) => sample.cacheSize)),
      max: Math.max(...samples.map((sample) => sample.cacheSize)),
    },
    noClaim: true,
    claim: 'no-claim',
    observation: 'elapsedMs, bytes, and cacheSize are recorded observations only; they do not decide correctness',
  };
}

export function collectBaseline(options: BaselineOptions): BaselineRecord[] {
  const authoritative = readAuthoritativeGitGraph(options.root);
  const graph = projectGitlinkGraph(authoritative);
  if (graph.unreachablePaths.length > 0) {
    throw new Error(`baseline requires a materialized recursive graph: ${graph.unreachablePaths.join(', ')}`);
  }
  const modes: BaselineMode[] = ['cold', 'warm-exact', 'warm-invalidated-to-cold'];
  const metadata: BaselineMetadata = {
    recordType: 'metadata',
    evidenceType: 'recursive-input-baseline',
    rootRevision: graph.sourceIdentity.revision,
    sourceIdentity: graph.sourceIdentity,
    trustScope: options.trustScope,
    requestedInputClasses: [...options.requestedInputClasses],
    sampleCountPerMode: SAMPLE_COUNT,
    modes,
    noClaim: true,
    claim: 'no-claim',
    observation: 'This file records correctness-equivalence facts and raw observations; it contains no threshold or performance verdict',
  };
  const records: BaselineRecord[] = [metadata];
  const samplesByMode: Record<BaselineMode, BaselineSample[]> = {
    cold: [],
    'warm-exact': [],
    'warm-invalidated-to-cold': [],
  };
  for (let sampleIndex = 1; sampleIndex <= SAMPLE_COUNT; sampleIndex += 1) {
    samplesByMode.cold.push(runColdSample(sampleIndex, options, graph));
    samplesByMode['warm-exact'].push(runWarmExactSample(sampleIndex, options, graph));
    samplesByMode['warm-invalidated-to-cold'].push(runWarmInvalidatedToColdSample(sampleIndex, options, graph));
  }
  for (const mode of modes) {
    records.push(...samplesByMode[mode]);
    records.push(summarize(mode, samplesByMode[mode]));
  }
  const expectedDigest = computeInputDigest({
    sourceIdentity: graph.sourceIdentity,
    recursivePins: graph.pins,
    requestedInputClasses: options.requestedInputClasses,
  });
  if (records.some((record) => 'inputDigest' in record && record.inputDigest !== expectedDigest)) {
    throw new Error('baseline records do not match the fixed authoritative inputDigest');
  }
  return records;
}

export function writeBaseline(output: string, records: readonly BaselineRecord[]): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  renameSync(temporary, output);
}

export function runBaseline(options: BaselineOptions): BaselineRecord[] {
  const records = collectBaseline(options);
  writeBaseline(options.output, records);
  return records;
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options) {
      const records = runBaseline(options);
      process.stdout.write(`${JSON.stringify({
        evidenceType: 'recursive-input-baseline',
        output: options.output,
        samples: records.filter((record) => record.recordType === 'sample').length,
        noClaim: true,
        claim: 'no-claim',
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
