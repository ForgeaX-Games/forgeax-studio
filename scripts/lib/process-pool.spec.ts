import { describe, expect, it } from 'bun:test';
import { mapConcurrent, positiveConcurrency, runCommandBuffered } from './process-pool.ts';

describe('process pool', () => {
  it('preserves input ordering while respecting the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapConcurrent([40, 5, 20, 10], 2, async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(delay);
      active--;
      return `result-${index}`;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
  });

  it('validates explicit concurrency values', () => {
    expect(positiveConcurrency(undefined, 2, 'TEST_CONCURRENCY')).toBe(2);
    expect(positiveConcurrency('4', 2, 'TEST_CONCURRENCY')).toBe(4);
    expect(() => positiveConcurrency('0', 2, 'TEST_CONCURRENCY'))
      .toThrow('TEST_CONCURRENCY must be a positive integer');
    expect(() => positiveConcurrency('many', 2, 'TEST_CONCURRENCY'))
      .toThrow('TEST_CONCURRENCY must be a positive integer');
  });

  it('reports child exit status even when Bun test intercepts child output', async () => {
    const result = await runCommandBuffered(process.execPath, ['-e', 'process.exit(7)']);
    expect(result.status).toBe(7);
  });
});
