import { describe, expect, test } from 'bun:test';
import {
  executeRecursiveInputCli,
  parseRecursiveInputArgs,
  type RecursiveInputCliDependencies,
} from './cli.ts';

const dependencies = (overrides: Partial<RecursiveInputCliDependencies> = {}): RecursiveInputCliDependencies => ({
  root: '/tmp/recursive-input-cli-fixture',
  readResult: () => null,
  readGraph: () => ({
    sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
    pins: [],
    unreachablePaths: [],
  }),
  ...overrides,
});

describe('recursive input CLI discovery contract', () => {
  test('parses the four verbs and keeps the top-level entry singular', () => {
    expect(['materialize', 'verify', 'status', 'schema'].map((verb) => parseRecursiveInputArgs([verb]))).toEqual([
      { command: 'materialize', args: [] },
      { command: 'verify', args: [] },
      { command: 'status', args: [] },
      { command: 'schema', args: [] },
    ]);
    expect(parseRecursiveInputArgs([])).toEqual({ command: 'help', args: [] });
    expect(parseRecursiveInputArgs(['recursive-inputs'])).toEqual({ command: 'help', args: [] });
  });

  test('help is a pure discovery path and does not read nested repository state', () => {
    let graphReads = 0;
    let resultReads = 0;
    const result = executeRecursiveInputCli(['--help'], dependencies({
      readGraph: () => {
        graphReads++;
        throw new Error('help must not scan nested repositories');
      },
      readResult: () => {
        resultReads++;
        throw new Error('help must not read a manifest');
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('bun fx recursive-inputs materialize');
    expect(result.stdout).toContain('bun fx recursive-inputs schema');
    expect(result.stdout).toContain('schema/status/verify --scope ci');
    expect(result.stdout).toContain('docs/contracts/recursive-inputs.md');
    expect(graphReads).toBe(0);
    expect(resultReads).toBe(0);
  });

  test('non-ready output remains schema-valid JSON while diagnostics stay on stderr', () => {
    const result = executeRecursiveInputCli(['status'], dependencies());
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain('recursive-input.');
    expect(parsed.status).toBe('non-ready');
    expect(parsed.failure).toEqual(expect.objectContaining({
      code: expect.any(String),
      hint: expect.any(String),
      expected: expect.any(String),
      actual: expect.any(String),
      retryable: expect.any(Boolean),
      recoveryActions: expect.any(Array),
    }));
  });
});
