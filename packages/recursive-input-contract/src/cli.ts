import { readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { createRecursiveInputResult, validateRecursiveInputResult } from './validator.ts';

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
  return `Recursive input contract\n\nUsage:\n  bun fx recursive-inputs <command> [options]\n\nCommands:\n  materialize  Produce and persist the current recursive input result\n  verify       Validate the current result before source-owned work\n  status       Inspect current readiness without changing state\n  schema       Print the schema identity, classes, trust scopes, and error index\n\nShortest path:\n  bun fx recursive-inputs materialize --classes source\n  bun fx recursive-inputs verify\n  bun fx recursive-inputs status\n  bun fx recursive-inputs schema\n\nMachine output is JSON on stdout; human diagnostics are on stderr.\nRead the contract: docs/contracts/recursive-inputs.md`;
}

function parseOptions(args: string[]): {
  classes: InputClass[];
  trustScope: TrustScope;
  job: string;
  attempt: string;
  error?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') continue;
    if (!arg.startsWith('--')) return { classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', error: `unexpected argument: ${arg}` };
    const equals = arg.indexOf('=');
    const key = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
    if (!value) return { classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', error: `missing value for --${key}` };
    values.set(key, value);
  }

  const rawClasses = values.get('classes')?.split(',').filter(Boolean) ?? DEFAULT_INPUT_CLASSES;
  if (rawClasses.length === 0 || rawClasses.some((inputClass) => !INPUT_CLASSES.includes(inputClass as InputClass))) {
    return { classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', error: `unsupported input class: ${rawClasses.join(',')}` };
  }
  const trustScope = values.get('trust') ?? 'local-fixed-worktree';
  if (!TRUST_SCOPES.includes(trustScope as TrustScope)) {
    return { classes: DEFAULT_INPUT_CLASSES, trustScope: 'local-fixed-worktree', job: 'recursive-inputs', attempt: 'missing', error: `unsupported trust scope: ${trustScope}` };
  }
  return {
    classes: rawClasses as InputClass[],
    trustScope: trustScope as TrustScope,
    job: values.get('job') ?? 'recursive-inputs',
    attempt: values.get('attempt') ?? `cli-${Date.now()}`,
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
    docsPath: 'docs/contracts/recursive-inputs.md',
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

export function executeRecursiveInputCli(
  argv: string[],
  dependencies: RecursiveInputCliDependencies,
): RecursiveInputCliResult {
  const parsed = parseRecursiveInputArgs(argv);
  if (parsed.command === 'help') {
    return { exitCode: RECURSIVE_INPUT_EXIT_CODES.ok, stdout: `${recursiveInputHelp()}\n`, stderr: '' };
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
  if (parsed.command === 'schema') {
    return {
      exitCode: RECURSIVE_INPUT_EXIT_CODES.ok,
      stdout: `${JSON.stringify(schemaDiscovery(), null, 2)}\n`,
      stderr: '',
    };
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
