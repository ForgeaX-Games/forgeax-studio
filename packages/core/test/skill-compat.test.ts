/**
 * SKILL.md 兼容性 test。
 *
 * 用一份**真实风格的 SKILL.md**(含全部已知字段 + 嵌套 hooks + 一个
 * 未来未知字段 `foobar`)落临时目录,断言:
 *   - 全部已知字段正确解析 (含新增 effort / agent / shell / hooks)；
 *   - 未知字段被忽略且 skill 仍成功加载 (不报错、不丢整个 skill)；
 *   - `<name>/SKILL.md` 目录形态发现正常；
 *   - user-invocable 默认 true；
 *   - model: inherit → undefined。
 *
 * 参考: parseSkillFrontmatterFields。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  toSkillMeta,
} from '../src/capability/skill/frontmatter';
import { loadSkillsDir } from '../src/capability/skill/loader';

// 一份贴近真实写法的 SKILL.md：覆盖所有已知字段 + 嵌套 hooks + 未知 foobar。
const bc_SKILL_MD = [
  '---',
  'name: Code Review',
  'description: Review the current diff for correctness bugs',
  'when_to_use: when the user asks to review a PR or diff',
  'version: 2.1.0',
  'model: inherit',
  'allowed-tools: [Bash, Read, Grep]',
  'argument-hint: "[pr-number]"',
  'arguments:',
  '  - target',
  '  - 0', // 纯数字命名参数应被过滤
  'user-invocable: true',
  'disable-model-invocation: false',
  'context: fork',
  'agent: code-reviewer',
  'effort: high',
  'shell: bash',
  'paths:',
  '  - "src/**"',
  '  - "lib/foo.ts"',
  'hooks:',
  '  PreToolUse:',
  '    - matcher: Bash',
  'foobar: some-future-field-value', // 未来未知字段 —— 必须被容忍
  '---',
  '# Code Review',
  '',
  'Do the review of $target now.',
].join('\n');

describe('SKILL.md compat — frontmatter 字段解析', () => {
  test('parses every known field from a SKILL.md', () => {
    const { frontmatter, body } = parseFrontmatter(bc_SKILL_MD);
    const meta = toSkillMeta(frontmatter, body, 'code-review');

    expect(meta.displayName).toBe('Code Review');
    expect(meta.description).toBe(
      'Review the current diff for correctness bugs',
    );
    expect(meta.whenToUse).toBe('when the user asks to review a PR or diff');
    expect(meta.version).toBe('2.1.0');
    // model: inherit → undefined
    expect(meta.model).toBeUndefined();
    expect(meta.allowedTools).toEqual(['Bash', 'Read', 'Grep']);
    expect(meta.argumentHint).toBe('[pr-number]');
    // 纯数字命名参数 (`0`) 被过滤,只留 `target`
    expect(meta.argumentNames).toEqual(['target']);
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
    expect(meta.context).toBe('fork');
    expect(meta.paths).toEqual(['src', 'lib/foo.ts']); // /** 后缀剥离

    // ── 新增字段 ──
    expect(meta.agent).toBe('code-reviewer');
    expect(meta.effort).toBe('high');
    expect(meta.shell).toBe('bash');
    // hooks 原样保留嵌套对象 (loader 不解释,执行由 host)
    expect(meta.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash' }] });
  });

  test('unknown field (foobar) is tolerated: skill still loads, field ignored', () => {
    const { frontmatter } = parseFrontmatter(bc_SKILL_MD);
    // 未知字段进入原始 map 但不出现在强类型 meta 上。
    expect(frontmatter.foobar).toBe('some-future-field-value');
    const meta = toSkillMeta(frontmatter, '', 'code-review');
    expect((meta as unknown as Record<string, unknown>).foobar).toBeUndefined();
    // meta 仍完整可用 (没有因未知字段丢失)。
    expect(meta.description).toBe(
      'Review the current diff for correctness bugs',
    );
  });

  test('effort numeric + invalid degrade to expected values', () => {
    expect(toSkillMeta({ effort: '4' }, '', 'x').effort).toBe(4);
    expect(toSkillMeta({ effort: 'max' }, '', 'x').effort).toBe('max');
    // 非法 effort → undefined (degrade,不报错)
    expect(toSkillMeta({ effort: 'bogus' }, '', 'x').effort).toBeUndefined();
    // 非法 shell → undefined (host 缺省 bash)
    expect(toSkillMeta({ shell: 'fish' }, '', 'x').shell).toBeUndefined();
    expect(toSkillMeta({ shell: 'powershell' }, '', 'x').shell).toBe(
      'powershell',
    );
  });

  test('user-invocable defaults to true when absent', () => {
    const meta = toSkillMeta({ description: 'x' }, '', 'x');
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
  });
});

describe('SKILL.md compat — <name>/SKILL.md 目录发现', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fx-skill-compat-'));
    const dir = join(root, 'code-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), bc_SKILL_MD);
    // 一个非 skill 目录 (无 SKILL.md) —— 应被忽略,不致命。
    mkdirSync(join(root, 'not-a-skill'), { recursive: true });
    // 一个裸 .md 文件 (非目录形态) —— 不当作 skill。
    writeFileSync(join(root, 'loose.md'), '# loose');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('discovers <name>/SKILL.md, ignores non-skill dirs and loose .md', () => {
    const { skills, conditional } = loadSkillsDir([root]);
    // 该 skill 有 paths frontmatter → held back 到 conditional。
    const all = [...skills, ...conditional];
    expect(all).toHaveLength(1);
    const s = all[0]!;
    expect(s.name).toBe('code-review'); // 名来自目录
    expect(s.meta.agent).toBe('code-reviewer');
    expect(s.meta.effort).toBe('high');
    expect(s.meta.hooks).toBeDefined();
    expect(s.command.shell).toBe('bash');
    // conditional (有 paths) 不进默认激活集。
    expect(conditional).toHaveLength(1);
    expect(skills).toHaveLength(0);
  });
});
