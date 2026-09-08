import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReleaseIntegrityCliDependencies,
  executeReleaseIntegrityCli,
  parseReleaseIntegrityArgs,
  type ReleaseIntegrityCliDependencies,
} from '../cli.ts';
import type { ReleaseCandidate } from './candidate.ts';
import { createReleaseIntegrityResult, validateReleaseIntegrityResult } from './result.ts';

const dependencies = (overrides: Partial<ReleaseIntegrityCliDependencies> = {}): ReleaseIntegrityCliDependencies => ({
  root: '/tmp/release-integrity-cli-fixture',
  ...overrides,
});

const candidate = (releaseSurface: ReleaseCandidate['releaseSurface'] = 'desktop'): ReleaseCandidate => ({
  schemaVersion: 1,
  candidateId: 'candidate-1',
  releaseSurface,
  rootRevision: 'root-revision-1',
  recursiveInputIdentity: {
    repository: 'ForgeaX-Games/forgeax-studio',
    revision: 'root-revision-1',
    inputDigest: 'b'.repeat(64),
  },
  attempt: 'attempt-1',
  expectedSubjects: [{
    subjectId: 'desktop-macos-arm64',
    name: 'desktop-macos-arm64.dmg',
    platform: 'macos-arm64',
    digest: 'a'.repeat(64),
    digestAlgorithm: 'sha256',
  }],
  actualSubjects: [{
    subjectId: 'desktop-macos-arm64',
    name: 'desktop-macos-arm64.dmg',
    platform: 'macos-arm64',
    digest: 'a'.repeat(64),
    digestAlgorithm: 'sha256',
  }],
  criticalInputs: [{
    inputId: 'tauri-cli',
    kind: 'cli',
    identity: 'sha256:cli-1',
    status: 'resolved',
  }],
});

describe('release integrity CLI contract', () => {
  test('parses the versioned discovery verbs', () => {
    expect(['schema', 'status', 'verify', 'route-back'].map((verb) => parseReleaseIntegrityArgs([verb]))).toEqual([
      { command: 'schema', args: [] },
      { command: 'status', args: [] },
      { command: 'verify', args: [] },
      { command: 'route-back', args: [] },
    ]);
    expect(parseReleaseIntegrityArgs([])).toEqual({ command: 'help', args: [] });
    expect(parseReleaseIntegrityArgs(['unknown'])).toEqual({ command: 'unsupported', args: ['unknown'] });
  });

  test('keeps help discoverable without reading external services', () => {
    const result = executeReleaseIntegrityCli(['help'], dependencies({
      readCandidate: () => { throw new Error('help must not read a candidate'); },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('release-integrity-result.v1');
    expect(result.stdout).toContain('trust DAG');
    expect(result.stdout).toContain('recoveryActions');
    expect(result.stdout).toContain('route-back');
    expect(result.stdout).toContain('status       Read the last local result without changing state [--result <path>]');
    expect(result.stdout).toContain('Omitted --result reads .forgeax/release-integrity-result.json');
    expect(result.stdout).toContain('.forgeax-harness/docs/contracts/release-integrity.md');
  });

  test('registers one read-only route-back adapter in schema discovery', () => {
    const result = executeReleaseIntegrityCli(['schema'], dependencies());
    const output = JSON.parse(result.stdout) as Record<string, any>;
    expect(output.routeBackAdapter).toEqual({
      command: 'route-back',
      input: ['--candidate <route-back-candidate.json>', '--permission <observed-permission.json>'],
      output: 'release-integrity-result.v1',
      implementation: 'scripts/mirror/route-back-contract.ts',
      mutation: 'read-only',
      incompleteExternalOutcome: ['not-observed', 'unknown', 'read-only-reconcile'],
    });
  });

  test('dispatches route-back through the registered adapter runner', () => {
    const result = executeReleaseIntegrityCli(['route-back', '--candidate', 'candidate.json'], dependencies({
      runRouteBackAdapter: (args) => ({ exitCode: 3, stdout: JSON.stringify({ args, status: 'unverified' }), stderr: 'handoff\n' }),
    }));
    expect(result).toEqual({
      exitCode: 3,
      stdout: JSON.stringify({ args: ['--candidate', 'candidate.json'], status: 'unverified' }),
      stderr: 'handoff\n',
    });
  });

  test('returns versioned JSON on stdout and human diagnostics on stderr', () => {
    const result = executeReleaseIntegrityCli(['verify', '--candidate', 'missing.json'], dependencies({
      readCandidate: () => null,
    }));
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const validation = validateReleaseIntegrityResult(output);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(output.status).toBe('unverified');
    expect(validation.ok).toBe(true);
    expect(output.sourceAdmission).toEqual(expect.objectContaining({ code: 'release-integrity.candidate-unreadable' }));
    expect(output.recoveryActions).toEqual(expect.any(Array));
    expect(result.stderr).toContain('release-integrity.candidate-unreadable');
    expect(result.stderr).not.toContain('{');
  });

  test('reads an explicitly supplied archived result for status', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-integrity-cli-'));
    try {
      const archivedResult = createReleaseIntegrityResult(candidate(), {
        sourceAdmission: { status: 'passed' },
        contentIntegrity: { status: 'passed' },
        platformTrust: { status: 'passed' },
      });
      writeFileSync(join(root, 'archived-result.json'), `${JSON.stringify(archivedResult)}\n`);

      const result = executeReleaseIntegrityCli(
        ['status', '--result', 'archived-result.json'],
        createReleaseIntegrityCliDependencies(root),
      );
      const output = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(result.exitCode).toBe(0);
      expect(output.candidateId).toBe('candidate-1');
      expect(output.status).toBe('fully-verified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the default result path when --result is omitted', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-integrity-cli-'));
    try {
      const defaultResult = createReleaseIntegrityResult(candidate(), {
        sourceAdmission: { status: 'passed' },
        contentIntegrity: { status: 'passed' },
        platformTrust: { status: 'passed' },
      });
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(join(root, '.forgeax', 'release-integrity-result.json'), JSON.stringify(defaultResult));

      const result = executeReleaseIntegrityCli(['status'], createReleaseIntegrityCliDependencies(root));

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(defaultResult);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a missing result option value without reading a sibling token or default', () => {
    let defaultRead = false;
    const result = executeReleaseIntegrityCli(['status', '--result', '--surface', 'desktop'], dependencies({
      readResult: () => {
        defaultRead = true;
        return null;
      },
    }));
    const output = JSON.parse(result.stdout) as Record<string, any>;

    expect(result.exitCode).toBe(3);
    expect(defaultRead).toBe(false);
    expect(output.sourceAdmission).toEqual(expect.objectContaining({ code: 'release-integrity.result-path-missing' }));
    expect(output.recoveryActions).toContain('provide-result-path');
  });

  test('does not read an explicit result outside the root', () => {
    const result = executeReleaseIntegrityCli(['status', '--result', '../archived-result.json'], createReleaseIntegrityCliDependencies('/tmp/release-integrity-cli-fixture'));
    const output = JSON.parse(result.stdout) as Record<string, any>;

    expect(result.exitCode).toBe(3);
    expect(output.sourceAdmission).toEqual(expect.objectContaining({ code: 'release-integrity.result-unreadable' }));
  });

  test('rejects an unknown surface before reading the candidate', () => {
    let candidateRead = false;
    const result = executeReleaseIntegrityCli(['verify', '--surface', 'mobile', '--candidate', 'candidate.json'], dependencies({
      readCandidate: () => {
        candidateRead = true;
        return candidate();
      },
    }));
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const validation = validateReleaseIntegrityResult(output);

    expect(result.exitCode).toBe(3);
    expect(candidateRead).toBe(false);
    expect(validation.ok).toBe(true);
    expect(output.sourceAdmission).toEqual(expect.objectContaining({
      code: 'release-integrity.surface-invalid',
      expected: expect.stringContaining('desktop'),
      actual: 'mobile',
    }));
    expect(output.sourceWork).toEqual({ status: 'suppressed' });
    expect(output.recoveryActions).toContain('select-declared-release-surface');
  });

  test('rejects a surface that does not match the candidate releaseSurface', () => {
    const result = executeReleaseIntegrityCli(['verify', '--surface', 'route-back', '--candidate', 'candidate.json'], dependencies({
      readCandidate: () => candidate('desktop'),
    }));
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const validation = validateReleaseIntegrityResult(output);

    expect(result.exitCode).toBe(3);
    expect(validation.ok).toBe(true);
    expect(output.sourceAdmission).toEqual(expect.objectContaining({
      code: 'release-integrity.surface-mismatch',
      expected: 'desktop',
      actual: 'route-back',
    }));
    expect(output.candidateId).toBe('candidate-1');
    expect(output.sourceWork).toEqual({ status: 'suppressed' });
  });

  test('binds a known surface to the candidate result', () => {
    const result = executeReleaseIntegrityCli(['verify', '--surface', 'desktop', '--candidate', 'candidate.json'], dependencies({
      readCandidate: () => candidate('desktop'),
    }));
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const validation = validateReleaseIntegrityResult(output);

    expect(result.exitCode).toBe(3);
    expect(validation.ok).toBe(true);
    expect(output.releaseSurface).toBe('desktop');
    expect(output.status).toBe('unverified');
    expect(output).not.toHaveProperty('code');
    expect(output).not.toHaveProperty('expected');
    expect(output).not.toHaveProperty('actual');
    expect(output.sourceAdmission).toEqual(expect.objectContaining({
      code: 'release-integrity.source-admission-unverified',
    }));
    expect(output.platformTrust).toEqual(expect.objectContaining({
      code: 'release-integrity.platform-trust-unverified',
    }));
    expect(output.sourceWork).toEqual({ status: 'suppressed' });
  });
});
