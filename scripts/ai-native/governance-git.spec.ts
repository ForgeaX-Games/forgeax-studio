import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BASELINE_APPROVALS_PATH,
  RUNTIME_PROFILE_TERMINALS_PATH,
  assertAppendOnlyBytes,
  verifyCommittedAncestorPrefix,
  verifyGovernanceArtifact,
  type GitRunner,
} from './governance-git.ts';

function result(ok: boolean, stdout: string = '', stderr: string = '') {
  return { ok, stdout: new TextEncoder().encode(stdout), stderr };
}

describe('git-owned governance trust root', () => {
  it('returns only unverified-diagnostic when git is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-no-git-governance-'));
    const path = join(root, BASELINE_APPROVALS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
    const unavailable: GitRunner = () => result(false, '', 'git not found');
    expect(verifyGovernanceArtifact(root, BASELINE_APPROVALS_PATH, unavailable)).toMatchObject({
      status: 'unverified-diagnostic',
      committed_sha: null,
    });
  });

  it('does not verify a dirty or untracked governance path even when HEAD bytes are replayed', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-dirty-governance-'));
    const path = join(root, BASELINE_APPROVALS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'forged-and-resigned\n');
    const dirty: GitRunner = (args) => args[0] === 'status'
      ? result(true, ` M ${BASELINE_APPROVALS_PATH}\n`)
      : result(true, 'forged-and-resigned\n');
    expect(verifyGovernanceArtifact(root, BASELINE_APPROVALS_PATH, dirty)).toMatchObject({
      status: 'unverified-diagnostic',
      reasons: ['worktree-path-is-dirty-or-untracked'],
    });
  });

  it('verifies only a clean path whose bytes equal the committed HEAD copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-clean-governance-'));
    const path = join(root, BASELINE_APPROVALS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'committed\n');
    const clean: GitRunner = (args) => args[0] === 'status'
      ? result(true)
      : result(true, 'committed\n');
    expect(verifyGovernanceArtifact(root, BASELINE_APPROVALS_PATH, clean)).toMatchObject({
      status: 'verified',
      committed_sha: 'HEAD',
    });
  });

  it('rejects a rewritten first terminal record even after the internal chain is recomputed', () => {
    const ancestor = new TextEncoder().encode('{"schema_version":1}\n{"sequence":1,"record_sha256":"old"}\n');
    const rewritten = new TextEncoder().encode('{"schema_version":1}\n{"sequence":1,"record_sha256":"recomputed"}\n');
    expect(() => assertAppendOnlyBytes(ancestor, rewritten)).toThrow(/ancestor prefix/);
  });

  it('accepts a legal byte append to the terminal registry', () => {
    const ancestor = new TextEncoder().encode('{"schema_version":1}\n');
    const appended = new TextEncoder().encode('{"schema_version":1}\n{"sequence":1}\n');
    expect(() => assertAppendOnlyBytes(ancestor, appended)).not.toThrow();
  });

  it('executes the CI ancestor path and rejects a re-signed first-record rewrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-prefix-ci-'));
    const path = join(root, RUNTIME_PROFILE_TERMINALS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const ancestor = '{"schema_version":1}\n{"sequence":1,"record_sha256":"old"}\n';
    writeFileSync(path, '{"schema_version":1}\n{"sequence":1,"record_sha256":"recomputed"}\n');
    const runner: GitRunner = (args) => {
      if (args[0] === 'merge-base') return result(true, `${'a'.repeat(40)}\n`);
      if (args[0] === 'show') return result(true, ancestor);
      return result(false, '', `unexpected git command: ${args.join(' ')}`);
    };
    expect(() => verifyCommittedAncestorPrefix(root, RUNTIME_PROFILE_TERMINALS_PATH, runner)).toThrow(
      /ancestor prefix/,
    );
  });
});
