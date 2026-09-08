import { describe, expect, test } from 'bun:test';
import { selectCiJobTiming } from './capture-job-timing.ts';

describe('CI job timing capture', () => {
  test('selects the active named job and measures from workflow creation', () => {
    expect(selectCiJobTiming(
      { created_at: '2026-08-21T00:00:00Z' },
      { jobs: [
        { name: 'Studio QA heavy', status: 'completed', started_at: '2026-08-21T00:01:00Z' },
        { name: 'Studio QA heavy', status: 'in_progress', started_at: '2026-08-21T00:03:00Z' },
        { name: 'Studio QA standard', status: 'in_progress', started_at: '2026-08-21T00:02:00Z' },
      ] },
      'Studio QA heavy',
    )).toEqual({
      queuedAt: '2026-08-21T00:00:00Z',
      startedAt: '2026-08-21T00:03:00Z',
    });
  });

  test('fails closed to no metric for malformed or impossible timing', () => {
    expect(selectCiJobTiming(
      { created_at: '2026-08-21T00:03:00Z' },
      { jobs: [{ name: 'Studio QA heavy', status: 'in_progress', started_at: '2026-08-21T00:02:00Z' }] },
      'Studio QA heavy',
    )).toBeUndefined();
    expect(selectCiJobTiming({ created_at: 'invalid' }, { jobs: [] }, 'Studio QA heavy')).toBeUndefined();
  });
});
