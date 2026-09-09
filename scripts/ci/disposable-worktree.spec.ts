import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  assertDisposableTarget,
  disposableWorktreeTarget,
  isExpiredDisposableMarker,
} from './disposable-worktree';

describe('disposable CI worktree safety', () => {
  it('derives a run/attempt/job-scoped path below the runner temp root', () => {
    expect(disposableWorktreeTarget('/runner-temp', '123', '2', 'studio-qa-heavy')).toBe(
      join('/runner-temp', 'forgeax', '123', '2', 'studio-qa-heavy'),
    );
  });

  it('rejects traversal, unresolved variables, and targets outside the CI-owned root', () => {
    expect(() => disposableWorktreeTarget('/runner-temp', '../123', '1', 'job')).toThrow();
    expect(() => disposableWorktreeTarget('/runner-temp', '123', '$ATTEMPT', 'job')).toThrow();
    expect(() => assertDisposableTarget('/runner-temp', '/runner-temp/not-forgeax/job')).toThrow();
    expect(() => assertDisposableTarget('/runner-temp', '/runner-temp/forgeax/123/1/job')).not.toThrow();
  });

  it('reaps only marked worktrees older than the TTL', () => {
    const now = Date.parse('2026-08-21T00:00:00Z');
    expect(isExpiredDisposableMarker({
      schema: 'forgeax-ci-disposable-worktree/v1',
      createdAt: '2026-08-20T16:00:00Z',
      source: '/workspace',
      target: '/runner-temp/forgeax/1/1/job',
    }, now, 6 * 60 * 60 * 1000)).toBe(true);
    expect(isExpiredDisposableMarker({
      schema: 'forgeax-ci-disposable-worktree/v1',
      createdAt: '2026-08-20T20:00:00Z',
      source: '/workspace',
      target: '/runner-temp/forgeax/1/1/job',
    }, now, 6 * 60 * 60 * 1000)).toBe(false);
    expect(isExpiredDisposableMarker({
      schema: 'unknown',
      createdAt: '2026-08-01T00:00:00Z',
      source: '/workspace',
      target: '/runner-temp/forgeax/1/1/job',
    }, now, 1)).toBe(false);
  });
});
