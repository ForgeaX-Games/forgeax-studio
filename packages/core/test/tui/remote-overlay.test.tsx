/**
 * overlays/RemoteControl —— 远端控制面板纯渲染(ink-testing-library)。
 * 验证:添加行、账号行 + 状态标签、扫码态渲染二维码区、空列表提示。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/tui/providers/theme';
import { RemoteControl, remoteControlLength } from '../../src/tui/overlays/RemoteControl';
import type { RemoteAccount } from '../../src/tui/remote/controller';

const wrap = (node: React.ReactElement) => render(<ThemeProvider>{node}</ThemeProvider>);

describe('RemoteControl overlay', () => {
  test('空账号:显示添加行 + 暂无提示', () => {
    const { lastFrame } = wrap(<RemoteControl accounts={[]} index={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('远端控制');
    expect(frame).toContain('添加微信账号');
    expect(frame).toContain('暂无已连接账号');
    expect(remoteControlLength([])).toBe(1);
  });

  test('扫码态账号高亮 → 渲染二维码区 + 状态标签', () => {
    const accounts: RemoteAccount[] = [
      { id: 'fake-1', kind: 'fake', label: '演示账号', status: 'scan', qr: 'https://wx.qq.com/x/login-demo' },
    ];
    const { lastFrame } = wrap(<RemoteControl accounts={accounts} index={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('演示账号');
    expect(frame).toContain('待扫码');
    expect(frame).toContain('用微信扫描');
    expect(remoteControlLength(accounts)).toBe(2);
  });

  test('在线态账号高亮 → 提示可发消息控制', () => {
    const accounts: RemoteAccount[] = [
      { id: 'fake-1', kind: 'fake', label: '演示账号', status: 'online', qr: null },
    ];
    const { lastFrame } = wrap(<RemoteControl accounts={accounts} index={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('在线');
    expect(frame).toContain('可在微信里直接发消息');
  });
});
