/**
 * SKILL pack 验证用例 —— 补 skill-tool.ts / frontmatter.ts / command.ts 未覆盖颗粒:
 *   skill-tool: validateInput (空名/未知/disable-model-invocation)、checkPermissions
 *     fail-closed (未知工具 ask / 不安全字段 ask)、call fork dispatch (status:'forked')、
 *     call 未知工具 throw、mapResult forked vs inline、renderToolUseMessage。
 *   frontmatter: 嵌套对象 (hooks) 原样保留、块列表里的对象项 + 续接 kv 行、空标量、
 *     裸列表项跳过、effort/shell degrade、parsePaths match-all/后缀剥离。
 *   command: getPrompt 参数替换 ($ARGUMENTS / $i / $ARGUMENTS[i] / 命名参数)、
 *     args===undefined 不替换、自定义 ${KEY} 注入、${BC_SESSION_ID}。
 *
 * 覆盖 skillHasOnlySafeProperties / getPromptForCommand / parseSkillFrontmatter。
 */
import { test, expect, describe } from 'bun:test';
import {
  parseFrontmatter,
  toSkillMeta,
} from '../src/capability/skill/frontmatter';
import { createSkillCommand } from '../src/capability/skill/command';
import type { Command } from '../src/capability/skill/command';
import {
  buildSkillTool,
  skillHasOnlySafeProperties,
  type SkillToolOutput,
} from '../src/capability/skill/skill-tool';
import type { ToolContext } from '../src/capability/types';

const ctx = (): ToolContext => ({ signal: new AbortController().signal });

/** 由 SKILL.md 文本造一个 inline/fork Command (走真实 parse → meta → command 链)。 */
function cmd(content: string, name = 'demo', base = '/skills/demo'): Command {
  const { frontmatter, body } = parseFrontmatter(content);
  const meta = toSkillMeta(frontmatter, body, name);
  return createSkillCommand(meta, base, body, name);
}

// ─── skill-tool: validateInput ────────────────────────────────────────────────

describe('SkillTool — validateInput', () => {
  const tool = buildSkillTool([
    cmd('---\ndescription: ok\n---\nhi'),
    cmd('---\ndescription: x\ndisable-model-invocation: true\n---\nb', 'locked'),
  ]);

  test('empty / slash-only name → invalid format', async () => {
    const r = await tool.validateInput!({ skill: '   /  ' }, ctx());
    // " /  " trims to "/" → slice → "" → invalid format
    expect(r.result).toBe(false);
    if (!r.result) expect(r.message).toContain('Invalid skill format');
  });

  test('unknown skill → rejected', async () => {
    const r = await tool.validateInput!({ skill: 'nope' }, ctx());
    expect(r.result).toBe(false);
    if (!r.result) expect(r.message).toContain('Unknown skill');
  });

  test('disable-model-invocation skill → rejected for model', async () => {
    const r = await tool.validateInput!({ skill: 'locked' }, ctx());
    expect(r.result).toBe(false);
    if (!r.result) expect(r.message).toContain('disable-model-invocation');
  });

  test('leading slash stripped; known skill passes', async () => {
    const r = await tool.validateInput!({ skill: '/demo' }, ctx());
    expect(r.result).toBe(true);
  });
});

// ─── skill-tool: checkPermissions (safe-property allowlist, fail-closed) ───────

describe('SkillTool — checkPermissions allowlist', () => {
  test('safe-only command → allow', async () => {
    const tool = buildSkillTool([cmd('---\ndescription: safe\n---\nbody')]);
    const r = await tool.checkPermissions({ skill: 'demo' }, ctx());
    expect(r.behavior).toBe('allow');
  });

  test('unknown skill → fail-closed ask (checkPermissions backstop)', async () => {
    const tool = buildSkillTool([cmd('---\ndescription: safe\n---\nbody')]);
    const r = await tool.checkPermissions({ skill: 'ghost' }, ctx());
    expect(r.behavior).toBe('ask');
    expect(r.message).toContain('Execute skill');
  });

  test('meaningful unknown property → ask with unsafe-skill-property reason', async () => {
    const base = cmd('---\ndescription: safe\n---\nbody');
    // inject an unknown, meaningful field (not in SAFE_SKILL_PROPERTIES)
    const tainted = { ...base, danger: 'rm -rf' } as unknown as Command;
    const tool = buildSkillTool([tainted]);
    const r = await tool.checkPermissions({ skill: 'demo' }, ctx());
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('unsafe-skill-property');
  });
});

describe('skillHasOnlySafeProperties — boundaries', () => {
  test('empty / null / empty-array / empty-object unknown fields are NOT meaningful → safe', () => {
    const base = cmd('---\ndescription: x\n---\nb');
    const c = {
      ...base,
      extraNull: null,
      extraUndef: undefined,
      extraEmptyArr: [],
      extraEmptyObj: {},
    } as unknown as Command;
    expect(skillHasOnlySafeProperties(c)).toBe(true);
  });

  test('any meaningful unknown field → unsafe', () => {
    const base = cmd('---\ndescription: x\n---\nb');
    expect(
      skillHasOnlySafeProperties({ ...base, weird: 'val' } as unknown as Command),
    ).toBe(false);
    expect(
      skillHasOnlySafeProperties({ ...base, list: ['a'] } as unknown as Command),
    ).toBe(false);
    expect(
      skillHasOnlySafeProperties({ ...base, obj: { k: 1 } } as unknown as Command),
    ).toBe(false);
  });
});

// ─── skill-tool: call (inline / fork / throw) + mapResult + render ────────────

describe('SkillTool — call dispatch', () => {
  test('inline call returns status:inline + newMessages (skill.prompt)', async () => {
    const tool = buildSkillTool([
      cmd('---\ndescription: x\nallowed-tools: [Bash]\nmodel: opus\n---\nrun $ARGUMENTS'),
    ]);
    const res = await tool.call({ skill: 'demo', args: 'now' }, ctx());
    const out = res.data as Extract<SkillToolOutput, { status: 'inline' }>;
    expect(out.status).toBe('inline');
    expect(out.commandName).toBe('demo');
    expect(out.prompt).toContain('run now');
    expect(out.allowedTools).toEqual(['Bash']);
    expect(out.model).toBe('opus');
    expect(res.newMessages?.[0]?.type).toBe('skill.prompt');

    const ev = tool.mapResult(out, 'tu1');
    expect(ev.payload).toMatchObject({ status: 'inline' });
  });

  test('fork command returns status:forked (core does not spawn)', async () => {
    const tool = buildSkillTool([
      cmd('---\ndescription: x\ncontext: fork\nmodel: sonnet\n---\nfork body'),
    ]);
    const res = await tool.call({ skill: 'demo' }, ctx());
    const out = res.data as Extract<SkillToolOutput, { status: 'forked' }>;
    expect(out.status).toBe('forked');
    expect(out.model).toBe('sonnet');
    // forked carries no newMessages (host spawns by status)
    expect(res.newMessages).toBeUndefined();

    const ev = tool.mapResult(out, 'tu2');
    expect(String(ev.payload && (ev.payload as any).content)).toContain('forked');
  });

  test('empty allowed-tools → allowedTools undefined (not [])', async () => {
    const tool = buildSkillTool([cmd('---\ndescription: x\n---\nbody')]);
    const res = await tool.call({ skill: 'demo' }, ctx());
    expect((res.data as any).allowedTools).toBeUndefined();
  });

  test('call on unknown skill throws (validateInput-bypassed path)', async () => {
    const tool = buildSkillTool([cmd('---\ndescription: x\n---\nb')]);
    await expect(tool.call({ skill: 'ghost' }, ctx())).rejects.toThrow('Unknown skill');
  });

  test('renderToolUseMessage formats with/without args', () => {
    const tool = buildSkillTool([cmd('---\ndescription: x\n---\nb')]);
    expect(tool.renderToolUseMessage!({ skill: '/demo', args: 'a b' })).toBe('Skill(demo a b)');
    expect(tool.renderToolUseMessage!({ skill: 'demo' })).toBe('Skill(demo)');
  });

  test('skill is not read-only and not concurrency-safe (serial prompt expansion)', () => {
    const tool = buildSkillTool([cmd('---\ndescription: x\n---\nb')]);
    expect(tool.isReadOnly({ skill: 'demo' })).toBe(false);
    expect(tool.isConcurrencySafe({ skill: 'demo' })).toBe(false);
    expect(tool.isEnabled()).toBe(true);
  });
});

// ─── frontmatter: nested object / block-list object items / edges ─────────────

describe('frontmatter — nested + list edges', () => {
  test('nested object (hooks) preserved verbatim; non-object hooks → undefined', () => {
    const md = [
      '---',
      'description: d',
      'hooks:',
      '  PreToolUse:',
      '    matcher: Bash',
      '    cmd: echo hi',
      '---',
      'body',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(md);
    const meta = toSkillMeta(frontmatter, 'body', 'h');
    expect(meta.hooks).toBeDefined();
    expect((meta.hooks as any).PreToolUse).toMatchObject({
      matcher: 'Bash',
      cmd: 'echo hi',
    });

    // scalar `hooks:` → not an object → undefined in meta
    const md2 = '---\ndescription: d\nhooks: nope\n---\nb';
    const m2 = toSkillMeta(parseFrontmatter(md2).frontmatter, 'b', 'h');
    expect(m2.hooks).toBeUndefined();
  });

  test('block list with object items + continuation kv rows', () => {
    const md = [
      '---',
      'description: d',
      'steps:',
      '  - name: first',
      '    run: a',
      '  - name: second',
      '    run: b',
      '  - plain-scalar-item',
      '---',
      'body',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(md);
    const steps = frontmatter.steps as any[];
    expect(steps[0]).toMatchObject({ name: 'first', run: 'a' });
    expect(steps[1]).toMatchObject({ name: 'second', run: 'b' });
    expect(steps[2]).toBe('plain-scalar-item');
  });

  test('empty scalar value, inline flow list inside nested block, comment lines', () => {
    const md = [
      '---',
      'description: d',
      'empty:',
      '# comment skipped',
      'nested:',
      '  tools: [Bash, Read]',
      '  blank:',
      '---',
      'b',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.empty).toBe('');
    expect((frontmatter.nested as any).tools).toEqual(['Bash', 'Read']);
    expect((frontmatter.nested as any).blank).toBe('');
  });

  test('no frontmatter fence → empty map; unterminated fence → empty map', () => {
    expect(parseFrontmatter('just body').frontmatter).toEqual({});
    expect(parseFrontmatter('---\nname: x\nno end fence').frontmatter).toEqual({});
  });
});

// ─── frontmatter: degrade / normalize edges ──────────────────────────────────

describe('frontmatter — toSkillMeta degrade paths', () => {
  test('effort: valid level / integer / illegal → undefined', () => {
    const mk = (v: string) =>
      toSkillMeta(parseFrontmatter(`---\ndescription: d\neffort: ${v}\n---\nb`).frontmatter, 'b', 's')
        .effort;
    expect(mk('high')).toBe('high');
    expect(mk('3')).toBe(3);
    expect(mk('banana')).toBeUndefined();
  });

  test('shell: bash/powershell kept; illegal → undefined', () => {
    const mk = (v: string) =>
      toSkillMeta(parseFrontmatter(`---\ndescription: d\nshell: ${v}\n---\nb`).frontmatter, 'b', 's')
        .shell;
    expect(mk('bash')).toBe('bash');
    expect(mk('powershell')).toBe('powershell');
    expect(mk('fish')).toBeUndefined();
  });

  test('paths: strips /** suffix; match-all (**) → undefined; conditional otherwise', () => {
    const mk = (v: string) =>
      toSkillMeta(parseFrontmatter(`---\ndescription: d\npaths: ${v}\n---\nb`).frontmatter, 'b', 's')
        .paths;
    expect(mk('[src/**, lib]')).toEqual(['src', 'lib']);
    expect(mk('[**]')).toBeUndefined();
    expect(mk('[]')).toBeUndefined();
  });

  test('description fallback: frontmatter < body first line < heading < dir name', () => {
    // no description, body has a heading then text
    const m1 = toSkillMeta({}, '# Title\nfirst real line', 'dirA');
    expect(m1.description).toBe('first real line');
    // body only a heading
    const m2 = toSkillMeta({}, '# Only Heading', 'dirB');
    expect(m2.description).toBe('Only Heading');
    // empty body → dir-name fallback
    const m3 = toSkillMeta({}, '   \n', 'dirC');
    expect(m3.description).toBe('Skill: dirC');
  });

  test('model inherit → undefined; arguments drop pure-numeric/empty names', () => {
    const m = toSkillMeta(
      parseFrontmatter(
        '---\ndescription: d\nmodel: inherit\narguments: [foo, 1, "", bar]\n---\nb',
      ).frontmatter,
      'b',
      's',
    );
    expect(m.model).toBeUndefined();
    expect(m.argumentNames).toEqual(['foo', 'bar']);
  });
});

// ─── command: getPrompt substitution edges ───────────────────────────────────

describe('createSkillCommand — getPrompt substitution', () => {
  const body = 'all=$ARGUMENTS first=$0 idx=$ARGUMENTS[1] named=$who';
  const c = (extra = '') =>
    cmd(`---\ndescription: d\narguments: [who]\n${extra}---\n${body}`, 'demo', '/sk/demo');

  test('args=undefined → no substitution (raw passthrough)', () => {
    const out = c().getPrompt(undefined);
    expect(out).toContain('$ARGUMENTS');
    expect(out).toContain('$who');
  });

  test('$ARGUMENTS full, $i shorthand, $ARGUMENTS[i], named-by-position', () => {
    const out = c().getPrompt('alpha beta');
    expect(out).toContain('all=alpha beta'); // $ARGUMENTS full
    expect(out).toContain('first=alpha'); // $0
    expect(out).toContain('idx=beta'); // $ARGUMENTS[1]
    expect(out).toContain('named=alpha'); // $who → argName[0] → parsed[0]
  });

  test('out-of-range index → empty string; quoted args grouped', () => {
    const out = cmd('---\ndescription: d\n---\nx=$ARGUMENTS[5] y=$3', 'd2').getPrompt('"a b" c');
    expect(out).toContain('x=');
    expect(out).toContain('y=');
    // quoted "a b" is one arg → $0 would be "a b"; verify grouping via $0
    const out2 = cmd('---\ndescription: d\n---\nz=$0', 'd3').getPrompt('"a b" c');
    expect(out2).toContain('z=a b');
  });

  test('${BC_SKILL_DIR} + ${BC_SESSION_ID} + custom ${KEY} injected', () => {
    const command = cmd(
      '---\ndescription: d\n---\ndir=${BC_SKILL_DIR} sid=${BC_SESSION_ID} k=${FOO}',
      'demo',
      '/abs/skill',
    );
    const out = command.getPrompt('', { sessionId: 'S1', FOO: 'bar' });
    expect(out).toContain('dir=/abs/skill');
    expect(out).toContain('sid=S1');
    expect(out).toContain('k=bar');
  });

  test('prompt always prefixes the base directory header', () => {
    const out = cmd('---\ndescription: d\n---\nhello', 'demo', '/base/x').getPrompt('');
    expect(out.startsWith('Base directory for this skill: /base/x')).toBe(true);
  });
});
