/**
 * 状态栏耗时「墙钟平滑」回归(autobug 001-status-elapsed-jumpy)。
 *
 * 验收点 08.6:busy 期间耗时按墙钟平滑递增(~每 0.1s 一格),**与流事件无关**;
 * turn 收尾定格。本测试**不推任何 agent 事件**,只 set busy 后真实等待墙钟——
 * 若耗时仍是事件驱动(旧实现),busy 后无事件 → elapsedMs 不刷新 → 读数不增长 → 红。
 * 修好(provider 自走墙钟时钟)→ 读数平滑推进、收尾定格 → 绿。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusLineProvider, useStatusLine } from '../../src/tui/providers/status-line';
import { StatusLine } from '../../src/tui/components/StatusLine';
import type { StatusState } from '../../src/tui/contracts';

/** 小 harness:把 useStatusLine() 的句柄抛给外部(供测试驱动 set),并渲染真 StatusLine。 */
function Harness(props: { onReady: (s: StatusState) => void }): React.ReactElement {
  const s = useStatusLine();
  props.onReady(s);
  return React.createElement(StatusLine);
}

/** 解析当前渲染帧里的耗时读数(形如 `8.8s`),无则返回 null。 */
function readElapsed(frame: string): number | null {
  const m = frame.match(/(\d+\.\d)s/);
  return m ? Number(m[1]) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('status-line elapsed cadence (wall-clock driven, event-independent)', () => {
  test('busy 期间耗时按墙钟平滑推进,不依赖任何事件;收尾定格', async () => {
    let api: StatusState | null = null;
    const { lastFrame } = render(
      React.createElement(
        StatusLineProvider,
        null,
        React.createElement(Harness, { onReady: (s) => { api = s; } }),
      ),
    );

    expect(api).not.toBeNull();

    // busy 起跑:不再推任何事件 / 不再调任何 set。
    api!.set({ busy: true, model: 'm' });
    await sleep(120); // 让墙钟先走过至少一格,取首读
    const first = readElapsed(lastFrame() ?? '');
    expect(first).not.toBeNull(); // busy 后耗时段必须已渲染(旧实现可能根本不刷 → null)

    await sleep(400); // 纯等待墙钟,期间零事件
    const second = readElapsed(lastFrame() ?? '');
    expect(second).not.toBeNull();

    // 平滑递增:后读 - 前读 ≥ 0.2s(证明墙钟在自走,而非事件驱动冻结)。
    expect(second! - first!).toBeGreaterThanOrEqual(0.2);

    // 收尾:busy=false → 定格,读数不再增长。
    api!.set({ busy: false });
    await sleep(80); // 等 cleanup 定格落帧
    const frozen = readElapsed(lastFrame() ?? '');
    expect(frozen).not.toBeNull();
    await sleep(300);
    const stillFrozen = readElapsed(lastFrame() ?? '');
    expect(stillFrozen).toBe(frozen!); // 定格后不再走
  });
});
