import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAttemptStore } from './attempt-store.ts';
import {
  projectGitlinkGraph,
  readAuthoritativeGitGraph,
  type ProjectedGitGraph,
} from './git-graph.ts';
import type {
  CredentialCleanup,
  InputClass,
  InputReadiness,
  ReadinessByClass,
  RecursiveInputFailure,
  RecursiveInputResult,
} from './schema.ts';
import { publishRecursiveInputResult } from './publisher.ts';
import {
  createRecursiveInputResult,
  validateRecursiveInputResult,
  type RecursiveInputValidation,
  type RecursiveInputValidationContext,
} from './validator.ts';

const TRUST_SCOPE = 'trusted-base-ci' as const;
const PRODUCER = 'trusted-base-adapter' as const;

export type TrustedBaseInputOptions = {
  graph: ProjectedGitGraph;
  requestedInputClasses: readonly InputClass[];
  job: string;
  attempt: string;
  sourceAsDataRoot: string;
  readiness?: Partial<ReadinessByClass>;
  credentialCleanup?: CredentialCleanup;
  materializationStatus?: 'ready' | 'non-ready' | 'partial' | 'cancelled';
};

export type TrustedBaseInputValidationContext = RecursiveInputValidationContext;

function failure(
  code: string,
  expected: string,
  actual: string,
  retryable = true,
): RecursiveInputFailure {
  return {
    code: `recursive-input.${code}`,
    hint: 'Recreate the trusted-base recursive input result before consuming source.',
    expected,
    actual,
    retryable,
    recoveryActions: retryable
      ? ['discard-partial-state', 'retry-cold']
      : ['discard-result', 'produce-in-current-context'],
  };
}

function trustedFailure(options: TrustedBaseInputOptions, cleanup: CredentialCleanup): RecursiveInputFailure | undefined {
  if (cleanup.status !== 'passed') {
    return failure('credential-cleanup-failed', 'passed', cleanup.status);
  }
  if (options.materializationStatus && options.materializationStatus !== 'ready') {
    return failure('materialization-incomplete', 'ready', options.materializationStatus);
  }
  if (!options.sourceAsDataRoot.trim()) {
    return failure('source-data-root-missing', 'non-empty PR source-as-data root', 'empty', false);
  }
  return undefined;
}

export function createTrustedBaseInputResult(
  options: TrustedBaseInputOptions,
): RecursiveInputValidation {
  const credentialCleanup = options.credentialCleanup ?? { status: 'passed' as const };
  const result = createRecursiveInputResult({
    graph: options.graph,
    requestedInputClasses: options.requestedInputClasses,
    trustScope: TRUST_SCOPE,
    job: options.job,
    attempt: options.attempt,
    producer: PRODUCER,
    readiness: options.readiness,
    credentialCleanup,
    failure: trustedFailure(options, credentialCleanup),
  });
  return { ok: result.status === 'ready', result };
}

export function validateTrustedBaseInputResult(
  candidate: unknown,
  context: TrustedBaseInputValidationContext,
): RecursiveInputValidation {
  return validateRecursiveInputResult(candidate, context);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requestedClasses(): InputClass[] {
  const values = requiredEnv('CONTRACT_CLASSES').split(',').filter(Boolean);
  const known = new Set<InputClass>([
    'source',
    'dependency-installation',
    'toolchain',
    'large-file-storage',
    'build-output',
  ]);
  if (values.some((value) => !known.has(value as InputClass))) {
    throw new Error(`unsupported input class: ${values.join(',')}`);
  }
  return values as InputClass[];
}

function writeResult(path: string, result: RecursiveInputResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

export function runTrustedBaseInputCli(): void {
  const workspace = requiredEnv('GITHUB_WORKSPACE');
  const manifestPath = requiredEnv('CONTRACT_MANIFEST_PATH');
  const factsPath = requiredEnv('FORGEAX_SUBMODULE_FACTS_FILE');
  const job = requiredEnv('CONTRACT_JOB');
  const attempt = requiredEnv('CONTRACT_ATTEMPT');
  const classes = requestedClasses();
  const graph = projectGitlinkGraph(readAuthoritativeGitGraph(workspace));
  const facts = new Map(
    readFileSync(factsPath, 'utf8')
      .split('\n')
      .map((line) => line.split('='))
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [key, value] as const),
  );
  const materializationStatus = facts.get('materialization_status');
  const cleanupStatus = facts.get('credential_cleanup');
  const readiness = Object.fromEntries(
    classes.map((inputClass) => [inputClass, {
      status: materializationStatus === 'ready' ? 'ready' : 'partial',
    } satisfies InputReadiness]),
  ) as Partial<ReadinessByClass>;
  const produced = createTrustedBaseInputResult({
    graph,
    requestedInputClasses: classes,
    job,
    attempt,
    sourceAsDataRoot: workspace,
    readiness,
    materializationStatus: materializationStatus as TrustedBaseInputOptions['materializationStatus'],
    credentialCleanup: {
      status: cleanupStatus === 'passed' || cleanupStatus === 'failed' ? cleanupStatus : 'unknown',
    },
  });
  const context = {
    graph,
    requestedInputClasses: classes,
    trustScope: TRUST_SCOPE,
    job,
    attempt,
  } satisfies RecursiveInputValidationContext;
  const store = createAttemptStore(`${manifestPath}.store`);
  const validation = publishRecursiveInputResult({ store, context, result: produced.result });
  writeResult(manifestPath, validation.result);
  const resultFailure = validation.result.status === 'non-ready' ? validation.result.failure : undefined;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `status=${validation.result.status}`,
      `manifest-path=${manifestPath}`,
      `failure-code=${resultFailure?.code ?? ''}`,
      `recovery-actions=${JSON.stringify(resultFailure?.recoveryActions ?? [])}`,
    ].join('\n') + '\n');
  }
  process.stdout.write(`${JSON.stringify(validation.result)}\n`);
  if (!validation.ok) process.exitCode = 3;
}

if (import.meta.main) runTrustedBaseInputCli();
