/**
 * PERM/inspect — `/permissions` A 层只读能力测试。
 * 验证规则展示串还原、规则视图整理、模式校验适配器(fail-closed)。
 * 对齐 permission.test.ts 风格。
 */
import { test, expect, describe } from 'bun:test';
import {
  formatRule,
  getPermissionRules,
  isPermissionMode,
  coercePermissionMode,
  PERMISSION_MODES,
} from '../src/permission/inspect';
import { parseRuleString, type PermissionRuleSet } from '../src/permission/rules';

describe('formatRule — parseRuleString 的逆', () => {
  test('无 content → 裸工具名', () => {
    expect(formatRule({ toolName: 'Write', behavior: 'allow' })).toBe('Write');
  });

  test('有 content → Tool(content)', () => {
    expect(formatRule({ toolName: 'Bash', content: 'git *', behavior: 'allow' })).toBe('Bash(git *)');
  });

  test('空串 content 视作无 content', () => {
    expect(formatRule({ toolName: 'Bash', content: '', behavior: 'deny' })).toBe('Bash');
  });

  test('round-trip:parseRuleString → formatRule 还原原串', () => {
    for (const s of ['Bash(git *)', 'Write', 'mcp__server', 'mcp__server__tool']) {
      const parsed = parseRuleString(s, 'allow');
      expect(parsed).not.toBeNull();
      expect(formatRule(parsed!)).toBe(s);
    }
  });
});

describe('getPermissionRules — 规则集 + 模式视图', () => {
  test('整理三桶 + 计数 + 模式', () => {
    const rules: PermissionRuleSet = {
      allow: [
        { toolName: 'Bash', content: 'git *', behavior: 'allow' },
        { toolName: 'Read', behavior: 'allow' },
      ],
      ask: [{ toolName: 'Bash', content: 'npm publish:*', behavior: 'ask' }],
      deny: [],
    };
    const view = getPermissionRules(rules, 'plan');
    expect(view.mode).toBe('plan');
    expect(view.counts).toEqual({ allow: 2, ask: 1, deny: 0 });
    expect(view.allow.map((v) => v.display)).toEqual(['Bash(git *)', 'Read']);
    expect(view.ask.map((v) => v.display)).toEqual(['Bash(npm publish:*)']);
    expect(view.deny).toEqual([]);
    // 视图保留原始规则供调用方取字段。
    expect(view.allow[0].rule.behavior).toBe('allow');
  });

  test('null / undefined / Partial 规则 → 空桶兜底(fail-safe)', () => {
    for (const r of [null, undefined, { allow: [{ toolName: 'X', behavior: 'allow' as const }] }]) {
      const view = getPermissionRules(r, 'default');
      expect(view.mode).toBe('default');
      expect(view.ask).toEqual([]);
      expect(view.deny).toEqual([]);
    }
    expect(getPermissionRules(null, 'default').counts).toEqual({ allow: 0, ask: 0, deny: 0 });
  });
});

describe('coercePermissionMode / isPermissionMode — 模式校验适配器', () => {
  test('所有合法模式直通', () => {
    for (const m of PERMISSION_MODES) {
      expect(isPermissionMode(m)).toBe(true);
      expect(coercePermissionMode(m)).toBe(m);
    }
  });

  test('plan 模式已收录(021 已加入类型)', () => {
    expect((PERMISSION_MODES as readonly string[]).includes('plan')).toBe(true);
  });

  test('越界字符串 / 非字符串 → null(fail-closed)', () => {
    for (const bad of ['', 'bogus', 'DEFAULT', 42, null, undefined, {}, ['default']]) {
      expect(coercePermissionMode(bad)).toBeNull();
      expect(isPermissionMode(bad)).toBe(false);
    }
  });
});
