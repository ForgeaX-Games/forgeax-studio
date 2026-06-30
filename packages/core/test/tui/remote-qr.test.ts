/**
 * components/Qr —— 二维码矩阵 → 逐行同色段(ASCII-safe 渲染数据)+ 窄终端降级。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Qr, qrMatrix, qrHalfRows, qrWidthChars, qrHeightChars } from '../../src/tui/components/Qr';

const QUIET = 2;

describe('qr matrix/rows', () => {
  test('qrMatrix 产出非空方阵', () => {
    const m = qrMatrix('https://wx.qq.com/x/login-demo');
    expect(m).not.toBeNull();
    expect(m!.size).toBeGreaterThan(0);
    expect(m!.data.length).toBe(m!.size * m!.size);
  });

  test('qrHalfRows: 字符行数减半(向上取整)、每行宽含静默区', () => {
    const m = qrMatrix('hello-forgeax')!;
    const rows = qrHalfRows(m);
    const full = m.size + QUIET * 2;
    // half-block 垂直两两打包 → 字符行数 = ceil(full/2),比纯空格版(full 行)小一倍
    expect(rows.length).toBe(Math.ceil(full / 2));
    expect(rows.length).toBe(qrHeightChars(m.size));
    for (const runs of rows) {
      const width = runs.reduce((s, r) => s + r.width, 0);
      expect(width).toBe(full); // 每模块 1 字符宽
    }
    expect(qrWidthChars(m.size)).toBe(full);
    // 横≈竖:宽 full、高 ceil(full/2),配合终端 ~1:2 字符高宽比 → 近正方
    expect(qrHeightChars(m.size)).toBeLessThan(qrWidthChars(m.size));
  });

  test('Qr 在窄终端降级为打印 payload 文本', () => {
    const payload = 'https://wx.qq.com/x/login-demo';
    const { lastFrame } = render(React.createElement(Qr, { payload, cols: 4 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain(payload);
    expect(frame).toContain('终端过窄');
  });

  test('Qr 在足够宽的终端渲染不抛(含静默区空格)', () => {
    const { lastFrame } = render(React.createElement(Qr, { payload: 'hi', cols: 200 }));
    expect(typeof lastFrame()).toBe('string');
  });
});
