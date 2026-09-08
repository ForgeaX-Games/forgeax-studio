import { describe, expect, test } from 'bun:test';
import {
  RELEASE_CANDIDATE_SCHEMA_ID,
  validateReleaseCandidate,
  type ReleaseCandidate,
} from './candidate.ts';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

const subject = (subjectId: string, value = 'a'): ReleaseCandidate['expectedSubjects'][number] => ({
  subjectId,
  name: `${subjectId}.dmg`,
  platform: 'macos-arm64',
  digest: digest(value),
  digestAlgorithm: 'sha256',
});

const validCandidate = (): ReleaseCandidate => ({
  schemaVersion: 1,
  candidateId: 'candidate-1',
  releaseSurface: 'desktop',
  rootRevision: 'root-revision-1',
  recursiveInputIdentity: {
    repository: 'ForgeaX-Games/forgeax-studio',
    revision: 'root-revision-1',
    inputDigest: digest('b'),
  },
  attempt: 'attempt-1',
  expectedSubjects: [subject('desktop-macos-arm64')],
  actualSubjects: [subject('desktop-macos-arm64')],
  criticalInputs: [{
    inputId: 'tauri-cli',
    kind: 'cli',
    identity: 'sha256:cli-1',
    status: 'resolved',
  }],
});

describe('release candidate identity contract', () => {
  test('accepts a complete fixed candidate and publishes the v1 schema identity', () => {
    const result = validateReleaseCandidate(validCandidate());

    expect(result.ok).toBe(true);
    expect(RELEASE_CANDIDATE_SCHEMA_ID).toBe('urn:forgeax:release-candidate:v1');
  });

  test.each([
    ['rootRevision', (candidate: Record<string, unknown>) => delete candidate.rootRevision],
    ['recursiveInputIdentity', (candidate: Record<string, unknown>) => delete candidate.recursiveInputIdentity],
    ['attempt', (candidate: Record<string, unknown>) => delete candidate.attempt],
    ['criticalInputs', (candidate: Record<string, unknown>) => delete candidate.criticalInputs],
  ])('rejects a candidate missing %s with recovery metadata', (_field, mutate) => {
    const candidate = validCandidate() as unknown as Record<string, unknown>;
    mutate(candidate);

    const result = validateReleaseCandidate(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toMatch(/^release-integrity\./);
      expect(result.error.expected).toBeTruthy();
      expect(result.error.actual).toBeTruthy();
      expect(['candidate-identity', 'critical-inputs']).toContain(result.error.gate);
      expect(result.error.recoveryActions.length).toBeGreaterThan(0);
    }
  });

  test('rejects candidate-bound identity drift and digest mismatch', () => {
    const candidate = validCandidate();
    candidate.actualSubjects[0] = subject('desktop-macos-arm64', 'c');

    const result = validateReleaseCandidate(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('release-integrity.subject-digest-mismatch');
      expect(result.error.expected).toContain('desktop-macos-arm64');
      expect(result.error.actual).toContain('desktop-macos-arm64');
      expect(result.error.recoveryActions).toContain('rebuild-candidate');
    }
  });

  test('rejects a subject whose SBOM digest is not bound to its subject digest', () => {
    const candidate = validCandidate();
    const mismatchedSubject = {
      ...candidate.expectedSubjects[0],
      sbom: { status: 'applicable' as const, subjectDigest: digest('c') },
    };
    candidate.expectedSubjects[0] = mismatchedSubject;
    candidate.actualSubjects[0] = mismatchedSubject;

    const result = validateReleaseCandidate(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('release-integrity.sbom-subject-digest-mismatch');
      expect(result.error.gate).toBe('subject-binding');
      expect(result.error.recoveryActions).toContain('recompute-sbom');
    }
  });

  test('rejects extra actual subjects before a publisher can consume the candidate', () => {
    const candidate = validCandidate();
    candidate.actualSubjects.push(subject('unexpected-subject', 'd'));

    const result = validateReleaseCandidate(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('release-integrity.subject-set-mismatch');
      expect(result.error.gate).toBe('subject-binding');
      expect(result.error.recoveryActions).toContain('remove-unexpected-subject');
    }
  });

  test('keeps unresolved critical input explicitly unverified', () => {
    const candidate = validCandidate();
    candidate.criticalInputs[0].status = 'unverified';

    const result = validateReleaseCandidate(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('release-integrity.critical-input-unverified');
      expect(result.error.actual).toBe('unverified');
      expect(result.error.recoveryActions).toContain('pin-critical-input');
    }
  });
});
