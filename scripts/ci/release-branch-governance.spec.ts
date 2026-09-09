import { describe, expect, test } from 'bun:test';
import {
  issueNumbersFromMessage,
  isReleaseBranch,
  releaseOnlyCommitRange,
  validateCommitIssueLinks,
  type CommitRecord,
} from './release-branch-governance.ts';

describe('release branch governance', () => {
  test('accepts slash and non-slash release branch names', () => {
    expect(isReleaseBranch('release/v1.2.3')).toBe(true);
    expect(isReleaseBranch('release20260901')).toBe(true);
    expect(isReleaseBranch('feature/release-notes')).toBe(false);
  });

  test('extracts #number references and ignores URLs that the ruleset cannot admit', () => {
    expect(issueNumbersFromMessage('fix: audio race (#42)\nIssue: https://github.com/ForgeaX-Games/forgeax-studio/issues/71')).toEqual([42]);
    expect(issueNumbersFromMessage('https://github.com/other/repo/issues/99')).toEqual([]);
    expect(issueNumbersFromMessage('Fix #99; related context: https://github.com/other/repo/issues/99')).toEqual([99]);
  });

  test('uses every release-only commit instead of trusting a truncated push payload', () => {
    expect(releaseOnlyCommitRange('abc123')).toEqual(['rev-list', '--reverse', 'origin/main..abc123']);
  });

  test('fails every commit independently when its issue is missing or invalid', async () => {
    const commits: CommitRecord[] = [
      { sha: 'a'.repeat(40), message: 'feat: shipped without ticket' },
      { sha: 'b'.repeat(40), message: 'fix: tracked by #7' },
      { sha: 'c'.repeat(40), message: 'fix: tracked by #8' },
    ];
    const result = await validateCommitIssueLinks(commits, async (number) =>
      number === 7 ? { kind: 'issue' } : { kind: 'pull-request' });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { sha: 'a'.repeat(40), code: 'issue-reference-missing', issueNumbers: [] },
      { sha: 'c'.repeat(40), code: 'issue-reference-invalid', issueNumbers: [8] },
    ]);
  });

  test('accepts closed or open repository issues because both remain traceable records', async () => {
    const result = await validateCommitIssueLinks(
      [{ sha: 'd'.repeat(40), message: 'release: repair #12' }],
      async () => ({ kind: 'issue' }),
    );
    expect(result).toEqual({ ok: true, failures: [] });
  });
});
