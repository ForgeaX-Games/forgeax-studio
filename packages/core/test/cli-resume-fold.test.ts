/**
 * 018 A 层 —— resume-fold 底层能力(fold→seed 抽函数 + listSessions)。
 *
 * (A) foldSessionHistory:从 store 读全量事件 → fold 出历史 messages;
 *     无 store / 无 read / 空流 → undefined(调用方据此走单轮)。
 * (B) listSessions:扫 WAL 根目录,只收真有 events.jsonl 的子目录,按 mtime 倒序;
 *     目录不存在 → 空数组(首次运行不抛)。
 * (C) foldSessionById:按 id 打开会话 WAL 并 fold;不存在 → undefined。
 *
 * 对齐 cli-resume.test.ts 风格:tmpdir 落盘 + afterEach 清理,只 import core-local。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventStore } from '../src/cli/event-store-fs';
import { foldSessionHistory, listSessions, foldSessionById, readSessionEvents } from '../src/cli/resume-fold';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';

const tmpDirs: string[] = [];
function tmpRoot(name: string): string {
  const d = join(tmpdir(), `fxc-resume-fold-${name}-${process.pid}-${tmpDirs.length}`);
  mkdirSync(d, { recursive: true });
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 在 <root>/<id>/events.jsonl 写入一轮 user+assistant 事件(模拟一个会话 WAL)。 */
async function seedSession(root: string, id: string, name: string): Promise<string> {
  const file = join(root, id, 'events.jsonl');
  const store = new JsonlFileEventStore(file);
  await store.append([
    { type: CoreEventType.UserPromptSubmit, ts: 1, payload: { prompt: `My name is ${name}`, turn: 0 } } as CoreEvent,
    { type: 'assistant.message', ts: 2, payload: { role: 'assistant', content: `Hi ${name}.` } } as unknown as CoreEvent,
  ]);
  return file;
}

describe('foldSessionHistory — store 读回 → fold 历史', () => {
  test('有历史 → 返回带上一轮内容的 messages', async () => {
    const root = tmpRoot('hist');
    const file = await seedSession(root, 'sess', 'Ruibin');
    const history = await foldSessionHistory(new JsonlFileEventStore(file));
    expect(history).toBeDefined();
    const flat = JSON.stringify(history);
    expect(flat).toContain('Ruibin');
    expect(flat).toContain('Hi Ruibin');
  });

  test('无 store → undefined(走单轮)', async () => {
    expect(await foldSessionHistory(undefined)).toBeUndefined();
  });

  test('store 无 read 能力 → undefined', async () => {
    // 故意传缺 read 的 store(防御性运行时分支),用 cast 绕过类型检查。
    const noRead = { append: async () => {} } as unknown as Parameters<typeof foldSessionHistory>[0];
    expect(await foldSessionHistory(noRead)).toBeUndefined();
  });

  test('空 WAL → undefined(没有可 fold 的历史)', async () => {
    const root = tmpRoot('empty');
    const file = join(root, 'sess', 'events.jsonl');
    new JsonlFileEventStore(file); // 建目录但不写事件
    expect(await foldSessionHistory(new JsonlFileEventStore(file))).toBeUndefined();
  });
});

describe('listSessions — 扫 WAL 根目录', () => {
  test('只收真有 events.jsonl 的子目录,按 mtime 倒序', async () => {
    const root = tmpRoot('list');
    await seedSession(root, 'alpha', 'A');
    await new Promise((r) => setTimeout(r, 10)); // 拉开 mtime
    await seedSession(root, 'beta', 'B');
    // 杂项:空子目录 + 顶层散文件,都不该被收。
    mkdirSync(join(root, 'empty-dir'), { recursive: true });
    writeFileSync(join(root, 'stray.txt'), 'noise');

    const sessions = listSessions(root);
    expect(sessions.map((s) => s.id)).toEqual(['beta', 'alpha']); // mtime 倒序:beta 最近
    expect(sessions[0].sizeBytes).toBeGreaterThan(0);
    expect(sessions[0].file).toContain('beta');
    expect(sessions[0].file).toContain('events.jsonl');
  });

  test('title = 首条用户输入(归一化)', async () => {
    const root = tmpRoot('title');
    await seedSession(root, 'sess', 'Ruibin');
    const sessions = listSessions(root);
    expect(sessions[0].title).toBe('My name is Ruibin');
  });

  test('目录不存在 → 空数组(首次运行不抛)', () => {
    expect(listSessions(join(tmpdir(), `fxc-no-such-${process.pid}-${Date.now()}`))).toEqual([]);
  });
});

describe('readSessionEvents — 读全量原始事件流', () => {
  test('存在的会话 → 原样回放全部事件(供 transcript 回灌)', async () => {
    const root = tmpRoot('raw');
    await seedSession(root, 'sess', 'Dora');
    const events = await readSessionEvents('sess', root);
    expect(events.map((e) => e.type)).toEqual(['user_prompt.submit', 'assistant.message']);
    expect((events[0].payload as { prompt: string }).prompt).toContain('Dora');
  });

  test('不存在的会话 → 空数组(fail-soft)', async () => {
    const root = tmpRoot('raw-miss');
    expect(await readSessionEvents('ghost', root)).toEqual([]);
  });
});

describe('foldSessionById — 按 id 打开会话 WAL 并 fold', () => {
  test('存在的会话 → fold 出该会话历史', async () => {
    const root = tmpRoot('byid');
    await seedSession(root, 'mysess', 'Carol');
    const history = await foldSessionById('mysess', root);
    expect(JSON.stringify(history)).toContain('Carol');
  });

  test('不存在的会话 id → undefined', async () => {
    const root = tmpRoot('byid-miss');
    expect(await foldSessionById('ghost', root)).toBeUndefined();
  });
});
