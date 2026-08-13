import { readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  deriveRecursiveInputJsonSchema,
  INPUT_CLASSES,
  isRecursiveInputResult,
  TRUST_SCOPES,
  type InputClass,
  type ProjectedGitGraph,
  type RecursiveInputFailure,
  type RecursiveInputResult,
  type TrustScope,
} from './index.ts';
import { projectGitlinkGraph, readAuthoritativeGitGraph } from './git-graph.ts';
import { createRecursiveInputResult, validateCiResult, validateRecursiveInputResult, type CiExecutionContext } from './validator.ts';
import { CI_OUTPUT_CONTRACT_VERSION, CI_REQUIRED_CONTEXTS, ciSchemaDiscovery, loadCiContractFiles, producerForConsumer } from './ci-contract.ts';
import { inspectCiSourceFiles } from './ci-source.ts';
import { probeLiveRulesetsSync } from './ci-ruleset.ts';
import { reduceCiStatus } from './ci-status.ts';

export const RECURSIVE_INPUT_EXIT_CODES = {
  ok: 0,
  usage: 2,
  nonReady: 3,
  unsupported: 4,
  internal: 1,
} as const;

const DEFAULT_INPUT_CLASSES: InputClass[] = [
  'source',
  'dependency-installation',
  'toolchain',
  'large-file-storage',
];

type RecursiveInputCommand = 'help' | 'materialize' | 'verify' | 'status' | 'schema' | 'unsupported';

export type ParsedRecursiveInputArgs = {
  command: RecursiveInputCommand;
  args: string[];
};

export type RecursiveInputCliDependencies = {
  root: string;
  readResult: () => unknown;
  readGraph: () => ProjectedGitGraph;
  writeResult?: (result: RecursiveInputResult) => void;
  readResultPath?: (path: string) => unknown;
};

export type RecursiveInputCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function recursiveInputResultPath(root: string): string {
  return join(root, '.forgeax', 'recursive-input-result.json');
}

function readResult(root: string): unknown {
  try {
    return JSON.parse(readFileSync(recursiveInputResultPath(root), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function writeResult(root: string, result: RecursiveInputResult): void {
  const path = recursiveInputResultPath(root);
  mkdirSync(join(root, '.forgeax'), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

export function createRecursiveInputCliDependencies(root: string): RecursiveInputCliDependencies {
  return {
    root,
    readResult: () => readResult(root),
    readGraph: () => projectGitlinkGraph(readAuthoritativeGitGraph(root)),
    writeResult: (result) => writeResult(root, result),
    readResultPath: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  };
}

export function parseRecursiveInputArgs(argv: string[]): ParsedRecursiveInputArgs {
  const [first, ...args] = argv;
  if (!first || first === '--help' || first === '-h' || first === 'help' || first === 'recursive-inputs') {
    return { command: 'help', args: first === 'help' ? args : [] };
  }
  if (['materialize', 'verify', 'status', 'schema'].includes(first)) {
    return { command: first as Exclude<RecursiveInputCommand, 'help' | 'unsupported'>, args };
  }
  return { command: 'unsupported', args: [first, ...args] };
}

export function recursiveInputHelp(command?: string): string {
  if (command && command !== 'recursive-inputs' && command !== 'help') {
    return `Usage: bun fx recursive-inputs ${command}\n\nUnknown recursive-inputs command.`;
  }
  return `Recursive input contract\n\nUsage:\n  bun fx recursive-inputs <command> [options]\n\nCommands:\n  materialize  Produce and persist the current recursive input result\n  verify       Validate the current result before source-owned work\n  status       Inspect current readiness without changing state\n  schema       Print the schema identity, classes, trust scopes, and error index\n\nShortest path:\n  bun fx recursive-inputs materialize --classes source\n  bun fx recursive-inputs verify\n  bun fx recursive-inputs status\n  bun fx recursive-inputs schema\n\nMachine output is JSON on stdout; human diagnostics are on stderr.\nRead the contract: packages/harness/docs/contracts/recursive-inputs.md`;
}

function parseOptions(args: string[]): {
  scope: 'legacy' | 'ci';
  classes: InputClass[];
  trustScope: TrustScope;
  job: string;
  attempt: string;
  consumerId?: string;
  resultPath?: string;
  repository?: string;
  revision?: string;
  run?: string;
  inputProvenance?: string;
  liveRuleset: boolean;
  error?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') continue;
    if (arg === '--live-ruleset') {
      values.set('live-ruleset', 'true');
      continue;
    }
    if (!arg.startsWith('--')) return { scope: 'legacy', classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', liveRuleset: false, error: `unexpected argument: ${arg}` };
    const equals = arg.indexOf('=');
    const key = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
    if (!value) return { scope: 'legacy', classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', liveRuleset: false, error: `missing value for --${key}` };
    values.set(key, value);
  }

  const rawClasses = values.get('classes')?.split(',').filter(Boolean) ?? DEFAULT_INPUT_CLASSES;
  if (rawClasses.length === 0 || rawClasses.some((inputClass) => !INPUT_CLASSES.includes(inputClass as InputClass))) {
    return { scope: values.get('scope') === 'ci' ? 'ci' : 'legacy', classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', liveRuleset: values.get('live-ruleset') === 'true', error: `unsupported input class: ${rawClasses.join(',')}` };
  }
  const requestedScope = values.get('scope');
  if (requestedScope !== undefined && requestedScope !== 'ci') {
    return { scope: 'legacy', classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', liveRuleset: values.get('live-ruleset') === 'true', error: `unsupported scope: ${requestedScope}` };
  }
  const scope = requestedScope === 'ci' ? 'ci' : 'legacy';
  const trustScope = values.get('trust') ?? values.get('trust-scope') ?? process.env.FORGEAX_TRUST_SCOPE ?? process.env.CONTRACT_TRUST_SCOPE ?? 'local-fixed-worktree';
  if (!TRUST_SCOPES.includes(trustScope as TrustScope)) {
    return { scope: values.get('scope') === 'ci' ? 'ci' : 'legacy', classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', liveRuleset: values.get('live-ruleset') === 'true', error: `unsupported trust scope: ${trustScope}` };
  }
  return {
    scope,
    classes: rawClasses as InputClass[],
    trustScope: trustScope as TrustScope,
    job: values.get('job') ?? process.env.GITHUB_JOB ?? process.env.CONTRACT_JOB ?? 'recursive-inputs',
    attempt: values.get('attempt') ?? (scope === 'ci' ? process.env.GITHUB_RUN_ATTEMPT ?? process.env.CONTRACT_ATTEMPT ?? 'missing' : `cli-${Date.now()}`),
    consumerId: values.get('consumer-id') ?? process.env.FORGEAX_CONSUMER_ID ?? process.env.CONTRACT_CONSUMER_ID,
    resultPath: values.get('result-path') ?? process.env.FORGEAX_RESULT_PATH ?? process.env.CONTRACT_RESULT_PATH,
    repository: values.get('repository') ?? process.env.GITHUB_REPOSITORY,
    revision: values.get('revision') ?? process.env.GITHUB_SHA,
    run: values.get('run') ?? process.env.GITHUB_RUN_ID,
    inputProvenance: values.get('input-provenance') ?? process.env.FORGEAX_INPUT_PROVENANCE ?? process.env.CONTRACT_INPUT_PROVENANCE,
    liveRuleset: values.get('live-ruleset') === 'true',
  };
}

function failure(code: string, expected: string, actual: string, retryable = false): RecursiveInputFailure {
  return {
    code: `recursive-input.${code}`,
    hint: 'Produce and verify a complete recursive input result before consuming source.',
    expected,
    actual,
    retryable,
    recoveryActions: retryable
      ? ['discard-partial-state', 'retry-cold']
      : ['discard-result', 'produce-in-current-context'],
  };
}

function missingResult(graph: ProjectedGitGraph, options: ReturnType<typeof parseOptions>): RecursiveInputResult {
  return createRecursiveInputResult({
    graph,
    producer: 'cli-validator',
    job: options.job,
    attempt: options.attempt,
    trustScope: options.trustScope,
    requestedInputClasses: options.classes,
    readiness: { source: { status: 'unknown' } },
    failure: failure('ready-missing', 'current ready recursive input result', 'result is absent', true),
  });
}

function validateCandidate(candidate: unknown, graph: ProjectedGitGraph, options: ReturnType<typeof parseOptions>): RecursiveInputResult {
  if (!isRecursiveInputResult(candidate)) return missingResult(graph, options);
  const contextOptions = {
    graph,
    requestedInputClasses: options.classes,
    trustScope: options.trustScope,
    job: options.job,
    attempt: options.attempt,
  };
  return validateRecursiveInputResult(candidate, contextOptions).result;
}

function diagnostic(result: RecursiveInputResult): string {
  return result.status === 'non-ready' ? `${result.failure.code}: ${result.failure.hint}` : '';
}

function resultOutput(result: RecursiveInputResult): RecursiveInputCliResult {
  return {
    exitCode: result.status === 'ready' ? RECURSIVE_INPUT_EXIT_CODES.ok : RECURSIVE_INPUT_EXIT_CODES.nonReady,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: diagnostic(result) ? `${diagnostic(result)}\n` : '',
  };
}

function schemaDiscovery(): Record<string, unknown> {
  return {
    ...deriveRecursiveInputJsonSchema(),
    schemaPath: 'packages/recursive-input-contract/schema/recursive-input-result.v1.schema.json',
    trustScopes: TRUST_SCOPES,
    inputClasses: INPUT_CLASSES,
    errorCodes: [
      'recursive-input.ready-missing',
      'recursive-input.schema-invalid',
      'recursive-input.source-identity-mismatch',
      'recursive-input.graph-incomplete',
      'recursive-input.pin-mismatch',
      'recursive-input.digest-mismatch',
      'recursive-input.attempt-mismatch',
      'recursive-input.trust-scope-mismatch',
      'recursive-input.result-not-ready',
    ],
    docsPath: 'packages/harness/docs/contracts/recursive-inputs.md',
  };
}

function materializeResult(graph: ProjectedGitGraph, options: ReturnType<typeof parseOptions>): RecursiveInputResult {
  const unreachable = graph.unreachablePaths.length > 0;
  return createRecursiveInputResult({
    graph,
    producer: 'bun-fx-recursive-inputs',
    job: options.job,
    attempt: options.attempt,
    trustScope: options.trustScope,
    requestedInputClasses: options.classes,
    readiness: { source: { status: unreachable ? 'unavailable' : 'ready' } },
    failure: unreachable
      ? failure('pin-unreachable', 'all recursive pins reachable', graph.unreachablePaths.join(','), true)
      : undefined,
  });
}

function ciFailureOutput(code: string, hint: string, expected: unknown, actual: unknown, exitCode: number = RECURSIVE_INPUT_EXIT_CODES.usage): RecursiveInputCliResult {
  const envelope = {
    operation: 'verify',
    scope: 'ci',
    status: 'non-ready',
    code,
    hint,
    expected,
    actual,
    sourceWork: { status: 'suppressed' },
    suppressionCode: 'recursive-input.consumer-work-suppressed',
    recoveryActions: [{ actionId: 'provide-explicit-current-identity', argv: ['bun', 'fx', 'recursive-inputs', 'verify', '--scope', 'ci', '--consumer-id=<id>', '--result-path=<path>'] }],
  };
  return { exitCode, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: `${code}: ${hint}\n` };
}

function isCiInputProvenance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.producerId === 'string'
    && typeof candidate.outputContractVersion === 'string'
    && typeof candidate.repository === 'string'
    && typeof candidate.revision === 'string'
    && typeof candidate.inputDigest === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.inputDigest);
}

function ciStatusCli(options: ReturnType<typeof parseOptions>, dependencies: RecursiveInputCliDependencies): RecursiveInputCliResult {
  let files;
  try {
    files = loadCiContractFiles(dependencies.root);
  } catch (error) {
    const envelope = {
      operation: 'status',
      scope: 'ci',
      status: 'non-ready',
      localStatic: 'non-ready',
      externalRuleset: 'not-checked',
      overall: 'non-ready',
      expectedContexts: [...CI_REQUIRED_CONTEXTS],
      code: 'recursive-input.ci.manifest-invalid',
      hint: 'Validate the canonical CI manifest and closed schema before source discovery.',
      expected: 'canonical manifest/schema pair',
      actual: error instanceof Error ? error.message : String(error),
      recoveryActions: [{ actionId: 'validate-canonical-contract', argv: ['bun', 'fx', 'recursive-inputs', 'schema', '--scope', 'ci'] }],
    };
    return { exitCode: RECURSIVE_INPUT_EXIT_CODES.nonReady, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: `${envelope.code}: ${envelope.hint}\n` };
  }
  const inspection = inspectCiSourceFiles(dependencies.root, files.manifest);
  const localStatic = inspection.errors.length === 0 ? 'aligned' : 'non-ready';
  let externalRuleset: 'aligned' | 'misaligned' | 'unverified' | 'not-checked' = 'not-checked';
  let live: unknown;
  if (options.liveRuleset) {
    let token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) {
      try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { token = undefined; }
    }
    if (!token) {
      externalRuleset = 'unverified';
      live = {
        status: 'unverified',
        code: 'recursive-input.ci.live-ruleset-auth-required',
        expected: { readPermission: true },
        actual: { token: 'absent' },
        recoveryActions: [{ actionId: 'obtain-live-read-permission', argv: ['gh', 'auth', 'login', '--scopes', 'repo'] }],
      };
    } else {
      const probe = probeLiveRulesetsSync({
        repository: files.manifest.governance.repository,
        ref: files.manifest.governance.ref,
        token,
        expected: files.manifest.governance,
      });
      externalRuleset = probe.status;
      live = probe;
    }
  }
    const projection = reduceCiStatus(localStatic, externalRuleset, files.manifest);
  const output = { ...projection, manifestDigest: files.manifestDigest, schemaDigest: files.schemaDigest, localStaticEvidence: inspection, live };
  return {
    exitCode: projection.exitCode,
    stdout: `${JSON.stringify(output, null, 2)}\n`,
    stderr: projection.status === 'ready' ? '' : `${projection.status}: externalRuleset=${externalRuleset}\n`,
  };
}

function ciVerifyCli(options: ReturnType<typeof parseOptions>, dependencies: RecursiveInputCliDependencies): RecursiveInputCliResult {
  const missing: string[] = [];
  if (!options.consumerId) missing.push('--consumer-id');
  if (!options.resultPath) missing.push('--result-path');
  if (!options.repository) missing.push('--repository or GITHUB_REPOSITORY');
  if (!options.revision) missing.push('--revision or GITHUB_SHA');
  if (!options.run) missing.push('--run or GITHUB_RUN_ID');
  if (options.attempt === 'missing') missing.push('--attempt or GITHUB_RUN_ATTEMPT');
  if (options.job === 'recursive-inputs' && !process.env.GITHUB_JOB && !process.env.CONTRACT_JOB) missing.push('--job or GITHUB_JOB/CONTRACT_JOB');
  if (options.trustScope === 'local-fixed-worktree') missing.push('--trust-scope/--trust');
  if (!options.inputProvenance) missing.push('--input-provenance');
  if (missing.length > 0) return ciFailureOutput('recursive-input.ci.usage-missing-current-identity', 'CI verify requires explicit current execution identity and input provenance.', missing, {});
  let inputProvenance: unknown;
  try { inputProvenance = JSON.parse(options.inputProvenance!); } catch { return ciFailureOutput('recursive-input.ci.usage-invalid-input-provenance', 'input provenance must be JSON.', 'JSON object', options.inputProvenance); }
  if (!isCiInputProvenance(inputProvenance)) return ciFailureOutput('recursive-input.ci.usage-invalid-input-provenance', 'input provenance must contain producer, contract, repository, revision, and a sha256 input digest.', 'CI input provenance object', inputProvenance);
  let candidate: unknown;
  try {
    const path = options.resultPath!.startsWith('/') ? options.resultPath! : join(dependencies.root, options.resultPath!);
    candidate = dependencies.readResultPath?.(path) ?? JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return ciFailureOutput('recursive-input.ci.result-unreadable', 'The explicit result path could not be read.', options.resultPath, error instanceof Error ? error.message : String(error), RECURSIVE_INPUT_EXIT_CODES.nonReady);
  }
  let files;
  try {
    files = loadCiContractFiles(dependencies.root);
  } catch (error) {
    return ciFailureOutput(
      'recursive-input.ci.manifest-invalid',
      'Validate the canonical CI manifest and closed schema before consumer work.',
      'canonical manifest/schema pair',
      error instanceof Error ? error.message : String(error),
      RECURSIVE_INPUT_EXIT_CODES.nonReady,
    );
  }
  const declared = producerForConsumer(files.manifest, options.consumerId!);
  const producerId = declared?.producer.producerId ?? 'unknown-producer';
  const outputContractVersion = declared?.producer.outputContractVersion ?? CI_OUTPUT_CONTRACT_VERSION;
  const graph = dependencies.readGraph();
  const resultClasses = isRecursiveInputResult(candidate) ? candidate.content.requestedInputClasses : options.classes;
  const context: CiExecutionContext = {
    consumerId: options.consumerId!,
    graph,
    requestedInputClasses: resultClasses,
    producerId,
    outputContractVersion,
    repository: options.repository!,
    revision: options.revision!,
    run: options.run!,
    attempt: options.attempt,
    job: options.job === 'recursive-inputs' ? process.env.GITHUB_JOB! : options.job,
    trustScope: options.trustScope as 'ordinary-ci' | 'trusted-base-ci',
    inputProvenance: inputProvenance as CiExecutionContext['inputProvenance'],
  };
  const validation = validateCiResult(candidate, context, files.manifest);
  const output = { ...validation.envelope, manifestDigest: files.manifestDigest, schemaDigest: files.schemaDigest, result: validation.result };
  return {
    exitCode: validation.ok ? RECURSIVE_INPUT_EXIT_CODES.ok : RECURSIVE_INPUT_EXIT_CODES.nonReady,
    stdout: `${JSON.stringify(output, null, 2)}\n`,
    stderr: validation.ok ? '' : `${validation.envelope.code}: ${validation.envelope.hint}\n`,
  };
}

export function executeRecursiveInputCli(
  argv: string[],
  dependencies: RecursiveInputCliDependencies,
): RecursiveInputCliResult {
  const parsed = parseRecursiveInputArgs(argv);
  if (parsed.command === 'help') {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.ok,
      stdout: `${recursiveInputHelp()}\n\nCI projection:\n  schema/status/verify --scope ci\n  CI verify requires consumer, result path, repository, revision, run, attempt,\n  job, trust scope, and input provenance from flags or named CI env vars.\n`,
      stderr: '',
    };
  }
  if (parsed.command === 'unsupported') {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.unsupported,
      stdout: '',
      stderr: `unsupported recursive-inputs command: ${parsed.args[0]}\n${recursiveInputHelp()}\n`,
    };
  }

  const options = parseOptions(parsed.args);
  if (options.error) return { exitCode: RECURSIVE_INPUT_EXIT_CODES.usage, stdout: '', stderr: `${options.error}\n` };
  if (options.scope === 'ci' && parsed.command === 'materialize') {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.unsupported,
      stdout: `${JSON.stringify({ operation: 'materialize', scope: 'ci', status: 'unsupported', code: 'recursive-input.ci.materialize-unsupported' }, null, 2)}\n`,
      stderr: 'CI scope exposes schema, status, and verify; producers materialize through their declared workflow action.\n',
    };
  }
  if (parsed.command === 'schema') {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.ok,
      stdout: `${JSON.stringify(options.scope === 'ci' ? ciSchemaDiscovery(dependencies.root) : schemaDiscovery(), null, 2)}\n`,
      stderr: '',
    };
  }

  if (options.scope === 'ci' && parsed.command === 'status') {
    try { return ciStatusCli(options, dependencies); } catch (error) {
      return { exitCode: RECURSIVE_INPUT_EXIT_CODES.internal, stdout: '', stderr: `recursive-input.internal-error: ${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (options.scope === 'ci' && parsed.command === 'verify') {
    try {
      return ciVerifyCli(options, dependencies);
    } catch (error) {
      return {
        exitCode: RECURSIVE_INPUT_EXIT_CODES.internal,
        stdout: '',
        stderr: `recursive-input.internal-error: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  try {
    const graph = dependencies.readGraph();
    const result = parsed.command === 'materialize'
      ? materializeResult(graph, options)
      : validateCandidate(dependencies.readResult(), graph, options);
    if (parsed.command === 'materialize') dependencies.writeResult?.(result);
    return resultOutput(result);
  } catch (error) {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.internal,
      stdout: '',
      stderr: `recursive-input.internal-error: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
