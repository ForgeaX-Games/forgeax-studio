/**
 * extensions-inspect 验证用例(023 A 层)—— listSkills / listPlugins / listHooks
 * 三个只读 getter。
 *
 * 对齐 023 任务的验收口径:「挂 1 个 skill + 1 个 plugin + 1 个 settings hook,
 * 三命令分别正确列出对应项」。这里直接验底层 getter(命令/渲染是 B 层,等 013)。
 *
 * 覆盖:
 *   - listSkills: 默认激活(active)+ conditional(有 paths,held back)两态;
 *     名称 + 来源 + 状态正确;空目录 → 空。
 *   - listPlugins: 单 plugin 名/source/enabled;detail 反映 componentKinds + hooks;
 *     跨源同名 precedence 去重(session 胜 builtin)。
 *   - listHooks: settings 形状 hooks(每条匹配组展开 + matcher 进 detail);
 *     plugin 自带 hooks(source='plugin:<name>');两来源合并。
 *
 * 用临时目录造真实 SKILL.md / plugin.json,走真 loader(与装配期同一口径)。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSkills,
  listPlugins,
  listHooks,
} from '../src/capability/extensions-inspect';
import type { PluginSource } from '../src/capability/plugin';

// ─── temp scaffolding ──────────────────────────────────────────────────────

let ROOT: string;
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fx-ext-inspect-'));
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;

/** 在一个新 skills 根目录下造 <name>/SKILL.md,返回该根目录。 */
function mkSkillsDir(skills: Record<string, string>): string {
  const dir = join(ROOT, `skills-${counter++}`);
  for (const [name, content] of Object.entries(skills)) {
    const sd = join(dir, name);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, 'SKILL.md'), content);
  }
  return dir;
}

/** 在一个新 plugin 源目录下造一个 <name>/(plugin.json + 可选文件),返回 PluginSource。 */
function mkPluginSource(
  source: PluginSource['source'],
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): PluginSource {
  const dir = join(ROOT, `plugins-${counter++}`);
  const pluginDir = join(dir, String(manifest.name ?? 'unnamed'));
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(pluginDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { source, dir };
}

// ─── listSkills ────────────────────────────────────────────────────────────

describe('listSkills', () => {
  test('默认激活 + conditional 两态都列出,名/源/状态正确', () => {
    const dir = mkSkillsDir({
      greet: '---\ndescription: 打招呼\n---\nhello',
      // 有 paths frontmatter → conditional,held back。
      ondemand: '---\ndescription: 条件激活\npaths:\n  - "src/**"\n---\nbody',
    });
    const rows = listSkills([dir]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName.greet).toBeDefined();
    expect(byName.greet.source).toBe('default');
    expect(byName.greet.status).toBe('active');
    expect(byName.greet.detail).toBe('打招呼');

    expect(byName.ondemand).toBeDefined();
    expect(byName.ondemand.source).toBe('conditional');
    expect(byName.ondemand.status).toBe('conditional');
  });

  test('空 / 不存在目录 → 空列表', () => {
    expect(listSkills([join(ROOT, 'no-such-dir')])).toEqual([]);
  });
});

// ─── listPlugins ───────────────────────────────────────────────────────────

describe('listPlugins', () => {
  test('单 plugin:名/source/enabled + detail 反映组件与 hooks', () => {
    const src = mkPluginSource(
      'marketplace',
      { name: 'demo-plugin', version: '1.0.0' },
      {
        'commands/x.md': '# cmd',
        'hooks/hooks.json': JSON.stringify({
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo hi' }] }],
        }),
      },
    );
    const rows = listPlugins([src]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.name).toBe('demo-plugin');
    expect(row.source).toBe('marketplace');
    expect(row.status).toBe('enabled');
    expect(row.detail).toContain('commands');
    expect(row.detail).toContain('hooks');
  });

  test('跨源同名 → precedence 去重(session 胜 builtin)', () => {
    const builtin = mkPluginSource('builtin', { name: 'dup', version: '1.0.0' });
    const session = mkPluginSource('session', { name: 'dup', version: '2.0.0' });
    const rows = listPlugins([builtin, session]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('dup');
    expect(rows[0].source).toBe('session'); // 高优先级胜出
  });

  test('空源 → 空列表', () => {
    expect(listPlugins([])).toEqual([]);
  });
});

// ─── listHooks ─────────────────────────────────────────────────────────────

describe('listHooks', () => {
  test('settings 形状 hooks:每条匹配组展开,matcher 进 detail', () => {
    const rows = listHooks({
      settings: {
        PreToolUse: [{ matcher: 'Bash', command: 'guard.sh' }],
        Stop: [{ command: 'notify.sh' }],
      },
    });
    const pre = rows.find((r) => r.name === 'PreToolUse');
    const stop = rows.find((r) => r.name === 'Stop');
    expect(pre).toBeDefined();
    expect(pre!.source).toBe('settings');
    expect(pre!.status).toBe('registered');
    expect(pre!.detail).toContain('[Bash]');
    expect(pre!.detail).toContain('guard.sh');
    expect(stop).toBeDefined();
    expect(stop!.detail).toBe('notify.sh'); // 无 matcher → 直接命令
  });

  test('plugin 自带 hooks:source=plugin:<name>', () => {
    const src = mkPluginSource(
      'builtin',
      { name: 'hooky', version: '1.0.0' },
      {
        'hooks/hooks.json': JSON.stringify({
          PostToolUse: [{ hooks: [{ command: 'log.sh' }] }],
        }),
      },
    );
    const rows = listHooks({ pluginSources: [src] });
    const row = rows.find((r) => r.name === 'PostToolUse');
    expect(row).toBeDefined();
    expect(row!.source).toBe('plugin:hooky');
    expect(row!.detail).toContain('log.sh');
  });

  test('settings + plugin 两来源合并', () => {
    const src = mkPluginSource(
      'builtin',
      { name: 'p2', version: '1.0.0' },
      {
        'hooks/hooks.json': JSON.stringify({
          Stop: [{ hooks: [{ command: 'p.sh' }] }],
        }),
      },
    );
    const rows = listHooks({
      settings: { PreToolUse: [{ command: 's.sh' }] },
      pluginSources: [src],
    });
    expect(rows.some((r) => r.source === 'settings')).toBe(true);
    expect(rows.some((r) => r.source === 'plugin:p2')).toBe(true);
  });

  test('无入参 → 空列表', () => {
    expect(listHooks({})).toEqual([]);
  });
});
