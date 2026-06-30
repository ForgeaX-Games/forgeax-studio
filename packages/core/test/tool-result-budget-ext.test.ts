/**
 * tool-result-budget WS5 扩展单测:classifyContentKinds + persist 落盘缝。
 * (现存 2-arg 行为的零回归由 test/tool-result-budget.test.ts 守。)
 */
import { test, expect, describe } from 'bun:test';
import {
  applyResultBudget,
  classifyContentKinds,
  type ContentKind,
} from '../src/context/tool-result-budget';

describe('classifyContentKinds — 无 parts(纯文本判定)', () => {
  test('有正文 → [text]', () => {
    expect(classifyContentKinds('hello')).toEqual(['text']);
  });
  test('空串 → []', () => {
    expect(classifyContentKinds('')).toEqual([]);
  });
});

describe('classifyContentKinds — 带 parts(content block)', () => {
  test('显式 type 归类', () => {
    const parts = [
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'b64' },
      { type: 'audio', data: 'b64' },
      { type: 'video', data: 'b64' },
    ];
    expect(classifyContentKinds('', parts)).toEqual(['text', 'image', 'audio', 'video']);
  });

  test('去重 + 保持首见顺序', () => {
    const parts = [
      { type: 'image' },
      { type: 'text' },
      { type: 'image' },
      { type: 'text' },
    ];
    expect(classifyContentKinds('', parts)).toEqual(['image', 'text']);
  });

  test('字符串块 → text', () => {
    expect(classifyContentKinds('', ['raw string'])).toEqual(['text']);
  });

  test('mimeType 兜底(resource 块)', () => {
    const parts = [
      { type: 'resource', mimeType: 'image/png' },
      { type: 'resource', mimeType: 'audio/mp3' },
      { type: 'resource', mimeType: 'video/mp4' },
      { type: 'resource', mimeType: 'text/plain' },
    ];
    expect(classifyContentKinds('', parts)).toEqual(['image', 'audio', 'video', 'text']);
  });

  test('无类型但有 text 字段 → text', () => {
    expect(classifyContentKinds('', [{ text: 'x' }])).toEqual(['text']);
  });

  test('无法判别 → binary(fail-safe)', () => {
    expect(classifyContentKinds('', [{ blob: 'xx' }, null, 42])).toEqual(['binary']);
  });

  test('空 parts 数组 → []', () => {
    expect(classifyContentKinds('anything', [])).toEqual([]);
  });

  test('返回类型可赋给 ContentKind[]', () => {
    const k: ContentKind[] = classifyContentKinds('x');
    expect(k).toEqual(['text']);
  });
});

describe('applyResultBudget — persist 落盘缝', () => {
  const big = 'A'.repeat(60_000);
  const max = 50_000;

  test('截断 + persist 返回路径 → marker 含 full result at <path>, persistedPath 置位', () => {
    const r = applyResultBudget(big, max, { persist: () => '/tmp/result-123.txt' });
    expect(r.truncated).toBe(true);
    expect(r.persistedPath).toBe('/tmp/result-123.txt');
    expect(r.output).toContain('full result at /tmp/result-123.txt');
    expect(r.output).toContain('truncated');
    expect(r.output.length).toBeLessThanOrEqual(max);
  });

  test('persist 返回 undefined → 不追加 path, 无 persistedPath, 与无 opts 逐字一致', () => {
    const withUndef = applyResultBudget(big, max, { persist: () => undefined });
    const withoutOpts = applyResultBudget(big, max);
    expect(withUndef.persistedPath).toBeUndefined();
    expect(withUndef.output).not.toContain('full result at');
    expect(withUndef.output).toBe(withoutOpts.output);
  });

  test('未超阈值 → persist 不被调用, truncated=false', () => {
    let called = false;
    const r = applyResultBudget('short', 100, {
      persist: () => {
        called = true;
        return '/tmp/x';
      },
    });
    expect(called).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.persistedPath).toBeUndefined();
  });

  test('persist 全量 raw 入参为原始内容(可落盘全文)', () => {
    let seen = '';
    applyResultBudget(big, max, {
      persist: (raw) => {
        seen = raw;
        return '/tmp/p';
      },
    });
    expect(seen).toBe(big);
    expect(seen.length).toBe(60_000);
  });

  test('Infinity maxChars → 不裁 → persist 不调用', () => {
    let called = false;
    const r = applyResultBudget(big, Infinity, {
      persist: () => {
        called = true;
        return '/tmp/x';
      },
    });
    expect(called).toBe(false);
    expect(r.truncated).toBe(false);
  });
});
