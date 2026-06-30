/**
 * P5 — overlays 浮层(受控、无 useInput)单测。
 *
 * 覆盖:
 *   - 各浮层纯导航 reducer:↑↓ 环形移动 / enter 选中 / esc 关闭(空列表仅 esc)。
 *   - Permission:经 fake toolMeta 把别名 `Bash`→canonical `bash` → resolvePermissionCard 命中
 *     专用卡(≠ fallback);未命中(MCP/未知)→ fallback。这是梁①「同源 bug」的运行时证据:
 *     查表前必过 toolMeta(name).canonical,绝不按 use.name 裸键。
 */
import { test, expect, describe } from 'bun:test';
import type { Key } from '../../src/tui/contracts';
import { commandMenuReducer } from '../../src/tui/overlays/CommandMenu';
import { modelPickerReducer, modelList, KNOWN_MODELS } from '../../src/tui/overlays/ModelPicker';
import { rewindReducer } from '../../src/tui/overlays/RewindPanel';
import { resumeReducer, filterSessions, formatRelTime, initialResumeIndex } from '../../src/tui/overlays/ResumePicker';
import type { SessionSummary } from '../../src/tui/contracts';
import {
  permissionReducer,
  resolvePermissionCard,
  fallbackCard,
  PERMISSION_OPTIONS,
} from '../../src/tui/overlays/Permission';

const k = (kind: Key['kind']): Key => ({ kind });

// ── 共享:三个 list 型导航 reducer 行为一致(↑↓ 环形 / enter select / esc close)──
const listReducers: Array<[string, (i: number, n: number, key: Key) => unknown]> = [
  ['commandMenuReducer', commandMenuReducer],
  ['modelPickerReducer', modelPickerReducer],
  ['rewindReducer', rewindReducer],
  ['resumeReducer', resumeReducer],
];

describe.each(listReducers)('%s nav', (_name, reducer) => {
  test('down moves forward, wraps at end', () => {
    expect(reducer(0, 3, k('down'))).toEqual({ kind: 'move', index: 1 });
    expect(reducer(2, 3, k('down'))).toEqual({ kind: 'move', index: 0 });
  });

  test('up moves backward, wraps at start', () => {
    expect(reducer(1, 3, k('up'))).toEqual({ kind: 'move', index: 0 });
    expect(reducer(0, 3, k('up'))).toEqual({ kind: 'move', index: 2 });
  });

  test('enter selects current index', () => {
    expect(reducer(2, 3, k('enter'))).toEqual({ kind: 'select', index: 2 });
  });

  test('esc closes', () => {
    expect(reducer(1, 3, k('esc'))).toEqual({ kind: 'close' });
  });

  test('empty list: only esc acts (up/down/enter → none)', () => {
    expect(reducer(0, 0, k('esc'))).toEqual({ kind: 'close' });
    expect(reducer(0, 0, k('down'))).toEqual({ kind: 'none' });
    expect(reducer(0, 0, k('up'))).toEqual({ kind: 'none' });
    expect(reducer(0, 0, k('enter'))).toEqual({ kind: 'none' });
  });

  test('unrelated key → none', () => {
    expect(reducer(0, 3, k('char'))).toEqual({ kind: 'none' });
    expect(reducer(0, 3, k('tab'))).toEqual({ kind: 'none' });
  });
});

describe('ModelPicker.modelList', () => {
  test('current already known → unchanged known list', () => {
    expect(modelList(KNOWN_MODELS[0]!)).toEqual(KNOWN_MODELS);
  });
  test('unknown current → prepended', () => {
    const out = modelList('my-custom-model');
    expect(out[0]).toBe('my-custom-model');
    expect(out).toContain(KNOWN_MODELS[0]);
  });
});

describe('ResumePicker.filterSessions', () => {
  const ss: SessionSummary[] = [
    { id: '20260623-aaaa', file: '/w/a/events.jsonl', sizeBytes: 1024, mtimeMs: 0, title: 'Fix CLI max_turns stop error' },
    { id: '20260623-bbbb', file: '/w/b/events.jsonl', sizeBytes: 2048, mtimeMs: 0, title: 'Debug read_file ENOENT' },
    { id: '20260623-cccc', file: '/w/c/events.jsonl', sizeBytes: 512, mtimeMs: 0 }, // 无 title
  ];

  test('empty query → all sessions', () => {
    expect(filterSessions(ss, '')).toHaveLength(3);
    expect(filterSessions(ss, '   ')).toHaveLength(3);
  });

  test('matches title (case-insensitive)', () => {
    const out = filterSessions(ss, 'enoent');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('20260623-bbbb');
  });

  test('matches id substring when no title', () => {
    expect(filterSessions(ss, 'cccc')).toHaveLength(1);
  });

  test('no match → empty', () => {
    expect(filterSessions(ss, 'zzz-nope')).toHaveLength(0);
  });
});

describe('ResumePicker.initialResumeIndex (默认高亮当前激活会话)', () => {
  const ss: SessionSummary[] = [
    { id: 'a', file: '/w/a/events.jsonl', sizeBytes: 1, mtimeMs: 0 },
    { id: 'b', file: '/w/b/events.jsonl', sizeBytes: 1, mtimeMs: 0 },
    { id: 'c', file: '/w/c/events.jsonl', sizeBytes: 1, mtimeMs: 0 },
  ];
  test('激活会话在列表 → 其下标', () => {
    expect(initialResumeIndex(ss, 'b')).toBe(1);
    expect(initialResumeIndex(ss, 'c')).toBe(2);
  });
  test('激活会话不在列表 / 未设 → 回退第一条(0)', () => {
    expect(initialResumeIndex(ss, 'ghost')).toBe(0);
    expect(initialResumeIndex(ss, undefined)).toBe(0);
  });
});

describe('ResumePicker.formatRelTime', () => {
  const now = 1_000_000_000_000;
  test('seconds → just now', () => {
    expect(formatRelTime(now - 5_000, now)).toBe('just now');
  });
  test('minutes (singular/plural)', () => {
    expect(formatRelTime(now - 60_000, now)).toBe('1 minute ago');
    expect(formatRelTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
  });
  test('hours and days', () => {
    expect(formatRelTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatRelTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
  test('future / clock skew → just now (clamped)', () => {
    expect(formatRelTime(now + 10_000, now)).toBe('just now');
  });
});

describe('permissionReducer', () => {
  const N = PERMISSION_OPTIONS.length;

  test('down/up wrap over the 3 options', () => {
    expect(permissionReducer(0, k('down'))).toEqual({ kind: 'move', index: 1 });
    expect(permissionReducer(N - 1, k('down'))).toEqual({ kind: 'move', index: 0 });
    expect(permissionReducer(0, k('up'))).toEqual({ kind: 'move', index: N - 1 });
  });

  test('enter decides with the current option value', () => {
    expect(permissionReducer(0, k('enter'))).toEqual({
      kind: 'decide',
      decision: 'allow-once',
    });
    expect(permissionReducer(1, k('enter'))).toEqual({
      kind: 'decide',
      decision: 'allow-always',
    });
    expect(permissionReducer(2, k('enter'))).toEqual({ kind: 'decide', decision: 'deny' });
  });

  test('esc cancels (router should resolve(false))', () => {
    expect(permissionReducer(1, k('esc'))).toEqual({ kind: 'cancel' });
  });

  test('unrelated key → none', () => {
    expect(permissionReducer(0, k('char'))).toEqual({ kind: 'none' });
  });
});

describe('Permission card resolution via toolMeta(name).canonical (梁① 同源 bug)', () => {
  // fake driver.toolMeta:别名 → canonical(模型可能发别名 `Bash`/`Write`/`Edit`)。
  const fakeToolMeta = (name: string): { canonical: string } => {
    const alias: Record<string, string> = {
      Bash: 'bash',
      Write: 'write_file',
      Edit: 'edit_file',
    };
    return { canonical: alias[name] ?? name };
  };

  test('alias `Bash` → canonical `bash` resolves dedicated card (≠ fallback)', () => {
    const { canonical } = fakeToolMeta('Bash');
    expect(canonical).toBe('bash');
    const card = resolvePermissionCard(canonical);
    expect(card).not.toBe(fallbackCard);
  });

  test('alias `Write`/`Edit` → canonical write_file/edit_file resolve dedicated card', () => {
    expect(resolvePermissionCard(fakeToolMeta('Write').canonical)).not.toBe(fallbackCard);
    expect(resolvePermissionCard(fakeToolMeta('Edit').canonical)).not.toBe(fallbackCard);
  });

  test('raw alias key (NOT via toolMeta) would MISS dedicated card → proves解析必要性', () => {
    // 直接用模型裸名 `Bash` 查表 = 旧 bug:落 fallback。
    expect(resolvePermissionCard('Bash')).toBe(fallbackCard);
  });

  test('unknown / MCP tool → fallback card', () => {
    const { canonical } = fakeToolMeta('mcp__foo__bar');
    expect(canonical).toBe('mcp__foo__bar');
    expect(resolvePermissionCard(canonical)).toBe(fallbackCard);
  });

  test('canonical card renders a body (title present, no throw)', () => {
    const card = resolvePermissionCard('bash');
    const body = card({
      use: { name: 'Bash', input: { command: 'ls -la' } } as never,
      perm: { behavior: 'ask', message: 'allow?' } as never,
      theme: { accent: 'cyan', dim: 'gray', warning: 'yellow', text: 'white' } as never,
    });
    expect(body.title).toBeTruthy();
  });
});
