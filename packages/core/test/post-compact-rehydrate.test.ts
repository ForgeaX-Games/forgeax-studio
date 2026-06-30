/**
 * Stream F 验收:压后重挂简化版(#13)。Cases F-U1..U6。
 * 见 docs/features/compaction-overhaul-verification.md §6。
 */
import { describe, test, expect } from 'bun:test';
import { rehydrate } from '../src/context/post-compact-rehydrate';
import { DEFAULT_REHYDRATE_TOKEN_BUDGET } from '../src/context/compaction-types';

describe('Stream F — post-compact rehydrate (#13)', () => {
  test('F-U1 重挂最近文件', async () => {
    const r = await rehydrate({
      recentReadPaths: ['/a.ts'],
      readFile: async () => 'console.log(1)',
      tokenBudget: DEFAULT_REHYDRATE_TOKEN_BUDGET,
      maxFiles: 1,
    });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].content).toContain('/a.ts');
    expect(r.attachments[0].content).toContain('console.log(1)');
  });

  test('F-U2 超预算 head 截断', async () => {
    const big = 'x'.repeat(100_000); // 25k tok
    const r = await rehydrate({
      recentReadPaths: ['/big.ts'],
      readFile: async () => big,
      tokenBudget: 1_000, // 4000 chars
      maxFiles: 1,
    });
    const content = r.attachments[0].content as string;
    expect(content).toContain('truncated for post-compact rehydration');
    expect(content.length).toBeLessThan(big.length);
  });

  test('F-U3 无最近文件 → 空', async () => {
    const r = await rehydrate({
      recentReadPaths: [],
      readFile: async () => 'x',
      tokenBudget: 10_000,
      maxFiles: 1,
    });
    expect(r.attachments).toEqual([]);
  });

  test('F-U4 读失败降级(不抛)', async () => {
    const r = await rehydrate({
      recentReadPaths: ['/missing.ts'],
      readFile: async () => {
        throw new Error('ENOENT');
      },
      tokenBudget: 10_000,
      maxFiles: 1,
    });
    expect(r.attachments).toEqual([]);
  });

  test('F-U5 只取 maxFiles=1(tracker 有多个)', async () => {
    const r = await rehydrate({
      recentReadPaths: ['/a.ts', '/b.ts', '/c.ts'],
      readFile: async (p) => `content of ${p}`,
      tokenBudget: 10_000,
      maxFiles: 1,
    });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].content).toContain('/a.ts'); // 最近(首个)
  });

  test('F-U6 attachment 携带 rehydrated marker', async () => {
    const r = await rehydrate({
      recentReadPaths: ['/a.ts'],
      readFile: async () => 'x',
      tokenBudget: 10_000,
      maxFiles: 1,
    });
    expect((r.attachments[0] as any)._rehydrated).toBe(true);
    expect((r.attachments[0] as any)._rehydratedPath).toBe('/a.ts');
  });
});
