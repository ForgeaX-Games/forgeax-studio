import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CI_PRODUCER_RESULT_VERSION,
  combineCiProducerResults,
  createCiProducerResult,
  validateCiProducerResult,
} from './ci-producer-result.ts';

const attempt = {
  repository: 'ForgeaX-Games/forgeax-studio',
  revision: 'a'.repeat(40),
  runId: '123',
  runAttempt: '2',
  job: 'studio-qa-standard',
};

describe('CI producer result contract', () => {
  test('creates a closed, versioned result with timing and rerun metrics', () => {
    const result = createCiProducerResult({
      producerId: 'studio-qa-standard',
      status: 'failed',
      category: 'product',
      code: 'studio-qa.standard.profile-failed',
      rootProducer: 'studio-qa-standard',
      blockedBy: [],
      safeRerun: false,
      attempt,
      timing: {
        queuedAt: '2026-08-20T23:59:30.000Z',
        startedAt: '2026-08-21T00:00:00.000Z',
        prepareCompletedAt: '2026-08-21T00:02:00.000Z',
        completedAt: '2026-08-21T00:03:00.000Z',
      },
    });

    expect(result.resultVersion).toBe(CI_PRODUCER_RESULT_VERSION);
    expect(result.metrics).toEqual({
      queueDurationMs: 30_000,
      durationMs: 180_000,
      prepareDurationMs: 120_000,
      runAttempt: 2,
      isRerun: true,
    });
    expect(validateCiProducerResult(result)).toEqual({ ok: true, errors: [] });
    expect(validateCiProducerResult({ ...result, accidental: true }).ok).toBe(false);
    expect(validateCiProducerResult({
      ...result,
      metrics: { ...result.metrics, queueDurationMs: 1 },
    }).errors).toContain('metrics.queueDurationMs must match timing');
  });

  test('combines evidence without turning the aggregator into a second test producer', () => {
    const passed = createCiProducerResult({
      producerId: 'studio-qa-standard',
      status: 'passed',
      category: 'product',
      code: 'studio-qa.standard.passed',
      rootProducer: 'studio-qa-standard',
      blockedBy: [],
      safeRerun: false,
      attempt: { ...attempt, job: 'studio-qa-standard' },
      timing: {
        startedAt: '2026-08-21T00:00:00.000Z',
        completedAt: '2026-08-21T00:02:00.000Z',
      },
    });
    const failed = createCiProducerResult({
      producerId: 'studio-qa-heavy',
      status: 'failed',
      category: 'stochastic',
      code: 'studio-qa.heavy.route-timeout',
      rootProducer: 'studio-qa-heavy',
      blockedBy: [],
      safeRerun: true,
      attempt: { ...attempt, job: 'studio-qa-heavy' },
      timing: {
        startedAt: '2026-08-21T00:00:00.000Z',
        completedAt: '2026-08-21T00:20:00.000Z',
      },
    });

    const combined = combineCiProducerResults({
      producerId: 'studio-qa-aggregate',
      results: [passed, failed],
      attempt: { ...attempt, job: 'studio-qa-aggregate' },
      startedAt: '2026-08-21T00:20:00.000Z',
      completedAt: '2026-08-21T00:20:10.000Z',
    });

    expect(combined.status).toBe('failed');
    expect(combined.category).toBe('stochastic');
    expect(combined.code).toBe('studio-qa.heavy.route-timeout');
    expect(combined.rootProducer).toBe('studio-qa-heavy');
    expect(combined.safeRerun).toBe(true);
    expect(combined.evidence.producers).toEqual(['studio-qa-standard', 'studio-qa-heavy']);
  });

  test('ships a closed JSON schema with the same status and category vocabulary', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, '../schema/ci-producer-result.v1.schema.json'), 'utf8')) as {
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[] }>;
    };

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.status?.enum).toEqual(['passed', 'failed', 'blocked', 'superseded']);
    expect(schema.properties.category?.enum).toEqual(['product', 'contract', 'infrastructure', 'stochastic', 'upstream']);
  });
});
