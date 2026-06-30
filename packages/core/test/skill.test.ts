/**
 * SKILL pack tests — frontmatter 解析、realpath 去重、conditional held back、
 * SkillTool dispatch (inline/fork)、safe-property allowlist fail-closed。
 *
 * 用临时目录 (mkdtempSync) 造 `<name>/SKILL.md`。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  toSkillMeta,
} from '../src/capability/skill/frontmatter';
import { createSkillCommand } from '../src/capability/skill/command';
import { loadSkillsDir } from '../src/capability/skill/loader';
import {
  buildSkillTool,
  skillHasOnlySafeProperties,
  type SkillToolOutput,
} from '../src/capability/skill/skill-tool';
import { skillPack } from '../src/capability/skill';
import type { ToolContext } from '../src/capability/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeSkill(root: string, name: string, content: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}

const ctx = (): ToolContext => ({ signal: new AbortController().signal });

// ─── frontmatter parsing ─────────────────────────────────────────────────────

describe('frontmatter — YAML parse + SkillMeta normalize', () => {
  test('parses scalars / quoted / flow list / block list', () => {
    const md = [
      '---',
      'name: My Skill',
      'description: "does a thing"',
      'when_to_use: when you need it',
      'version: 1.2.0',
      'allowed-tools: [Bash, Read]',
      'arguments:',
      '  - foo',
      '  - bar',
      '# a comment',
      'context: fork',
      '---',
      '# Body heading',
      'body text',
    ].join('\n');

    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.name).toBe('My Skill');
    expect(frontmatter.description).toBe('does a thing');
    expect(frontmatter['allowed-tools']).toEqual(['Bash', 'Read']);
    expect(frontmatter.arguments).toEqual(['foo', 'bar']);
    expect(body.startsWith('# Body heading')).toBe(true);

    const meta = toSkillMeta(frontmatter, body, 'my-skill');
    expect(meta.displayName).toBe('My Skill');
    expect(meta.description).toBe('does a thing');
    expect(meta.whenToUse).toBe('when you need it');
    expect(meta.version).toBe('1.2.0');
    expect(meta.allowedTools).toEqual(['Bash', 'Read']);
    expect(meta.argumentNames).toEqual(['foo', 'bar']);
    expect(meta.context).toBe('fork');
    // defaults
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
  });

  test('defaults + booleans + description fallback to first body line', () => {
    const md = [
      '---',
      'user-invocable: false',
      'disable-model-invocation: true',
      '---',
      '',
      'First meaningful line.',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(md);
    const meta = toSkillMeta(frontmatter, body, 'fallbackskill');
    expect(meta.userInvocable).toBe(false);
    expect(meta.disableModelInvocation).toBe(true);
    expect(meta.context).toBe('inline');
    expect(meta.description).toBe('First meaningful line.');
  });

  test('no frontmatter → empty map, body unchanged', () => {
    const { frontmatter, body } = parseFrontmatter('just body\nmore');
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe('just body\nmore');
  });

  test('model: inherit → undefined; paths /** trimmed; all-** → undefined', () => {
    const a = toSkillMeta({ model: 'inherit' }, '', 'x');
    expect(a.model).toBeUndefined();
    const b = toSkillMeta({ model: 'opus' }, '', 'x');
    expect(b.model).toBe('opus');
    const c = toSkillMeta({ paths: ['src/**', 'lib/foo.ts'] }, '', 'x');
    expect(c.paths).toEqual(['src', 'lib/foo.ts']);
    const d = toSkillMeta({ paths: ['**'] }, '', 'x');
    expect(d.paths).toBeUndefined();
  });
});

// ─── command: getPrompt substitution ─────────────────────────────────────────

describe('createSkillCommand — getPrompt substitution', () => {
  test('substitutes $ARGUMENTS / indexed / named + ${BC_SKILL_DIR}', () => {
    const meta = toSkillMeta({ arguments: ['who'] }, '', 'greet');
    const body = 'Hi $who all=[$ARGUMENTS] first=[$0] dir=${BC_SKILL_DIR}';
    const cmd = createSkillCommand(meta, '/tmp/greet', body, 'greet');
    const out = cmd.getPrompt('alice bob');
    expect(out).toContain('Hi alice');
    expect(out).toContain('all=[alice bob]');
    expect(out).toContain('first=[alice]');
    expect(out).toContain('dir=/tmp/greet');
    expect(out).toContain('Base directory for this skill: /tmp/greet');
  });

  test('no args → placeholders left intact; session id var replaced', () => {
    const cmd = createSkillCommand(
      toSkillMeta({}, '', 's'),
      '/tmp/s',
      'sid=${BC_SESSION_ID} a=$ARGUMENTS',
      's',
    );
    const out = cmd.getPrompt(undefined, { sessionId: 'sess-1' });
    expect(out).toContain('sid=sess-1');
    expect(out).toContain('a=$ARGUMENTS'); // untouched when args undefined
  });
});

// ─── loader: realpath dedup + conditional held back ──────────────────────────

describe('loadSkillsDir — realpath dedup + conditional held back', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-loader-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('loads directory-format skills; first-wins on duplicate name', () => {
    const a = join(root, 'srcA');
    const b = join(root, 'srcB');
    writeSkill(a, 'commit', '---\ndescription: A commit\n---\nbody A');
    writeSkill(b, 'commit', '---\ndescription: B commit\n---\nbody B');
    writeSkill(b, 'review', '---\ndescription: review\n---\nbody');

    const { skills } = loadSkillsDir([a, b]);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get('commit')?.meta.description).toBe('A commit'); // first wins
    expect(byName.has('review')).toBe(true);
  });

  test('dedup by realpath across symlinked directories', () => {
    const realRoot = join(root, 'real');
    const linkRoot = join(root, 'linked');
    const realDir = writeSkill(realRoot, 'shared', '---\ndescription: s\n---\nb');
    mkdirSync(linkRoot, { recursive: true });
    // symlink linked/shared -> real/shared (same SKILL.md realpath)
    symlinkSync(realDir, join(linkRoot, 'shared'), 'dir');

    const { skills } = loadSkillsDir([realRoot, linkRoot]);
    expect(skills.filter((s) => s.name === 'shared')).toHaveLength(1);
  });

  test('conditional skills (with paths) are held back', () => {
    const c = join(root, 'cond');
    writeSkill(c, 'plain', '---\ndescription: p\n---\nb');
    writeSkill(
      c,
      'scoped',
      '---\ndescription: s\npaths:\n  - src/**\n---\nb',
    );
    const { skills, conditional } = loadSkillsDir([c]);
    expect(skills.find((s) => s.name === 'plain')).toBeDefined();
    expect(skills.find((s) => s.name === 'scoped')).toBeUndefined();
    expect(conditional.find((s) => s.name === 'scoped')).toBeDefined();
    expect(conditional[0]?.meta.paths).toEqual(['src']);
  });

  test('non-directory entries / missing SKILL.md are skipped', () => {
    const d = join(root, 'mixed');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'loose.md'), '# not a skill');
    mkdirSync(join(d, 'empty-dir'), { recursive: true }); // no SKILL.md
    writeSkill(d, 'ok', '---\ndescription: ok\n---\nb');
    const { skills } = loadSkillsDir([d]);
    expect(skills.map((s) => s.name)).toEqual(['ok']);
  });
});

// ─── safe-property allowlist (fail-closed) ───────────────────────────────────

describe('skillHasOnlySafeProperties — fail-closed on unknown field', () => {
  test('clean command → only safe properties', () => {
    const cmd = createSkillCommand(toSkillMeta({}, '', 'x'), '/tmp/x', 'b', 'x');
    expect(skillHasOnlySafeProperties(cmd)).toBe(true);
  });

  test('unknown meaningful field → not safe', () => {
    const cmd = createSkillCommand(toSkillMeta({}, '', 'x'), '/tmp/x', 'b', 'x');
    const tampered = { ...cmd, hooks: { PreToolUse: [{}] } };
    expect(skillHasOnlySafeProperties(tampered as never)).toBe(false);
  });

  test('unknown empty field → still safe (no meaningful value)', () => {
    const cmd = createSkillCommand(toSkillMeta({}, '', 'x'), '/tmp/x', 'b', 'x');
    const tampered = { ...cmd, hooks: [], extra: undefined };
    expect(skillHasOnlySafeProperties(tampered as never)).toBe(true);
  });
});

// ─── SkillTool dispatch ──────────────────────────────────────────────────────

describe('buildSkillTool — dispatch inline / fork + permissions', () => {
  const inline = createSkillCommand(
    toSkillMeta({ 'allowed-tools': ['Read'] }, '', 'doc'),
    '/tmp/doc',
    'Do $ARGUMENTS',
    'doc',
  );
  const forked = createSkillCommand(
    toSkillMeta({ context: 'fork', model: 'opus' }, '', 'big'),
    '/tmp/big',
    'big body',
    'big',
  );
  const noModel = createSkillCommand(
    toSkillMeta({ 'disable-model-invocation': 'true' }, '', 'secret'),
    '/tmp/secret',
    'b',
    'secret',
  );

  test('inline dispatch returns expanded prompt + newMessages', async () => {
    const tool = buildSkillTool([inline, forked, noModel]);
    const res = await tool.call({ skill: 'doc', args: 'thing' }, ctx());
    const data = res.data as Extract<SkillToolOutput, { status: 'inline' }>;
    expect(data.status).toBe('inline');
    expect(data.prompt).toContain('Do thing');
    expect(data.allowedTools).toEqual(['Read']);
    expect(res.newMessages?.[0]?.type).toBe('skill.prompt');
  });

  test('fork dispatch returns forked status + model/prompt, no newMessages', async () => {
    const tool = buildSkillTool([inline, forked]);
    const res = await tool.call({ skill: '/big' }, ctx());
    const data = res.data as Extract<SkillToolOutput, { status: 'forked' }>;
    expect(data.status).toBe('forked');
    expect(data.model).toBe('opus');
    expect(data.prompt).toContain('big body');
    expect(res.newMessages).toBeUndefined();
  });

  test('validateInput: unknown skill / disable-model-invocation rejected', async () => {
    const tool = buildSkillTool([inline, noModel]);
    expect((await tool.validateInput!({ skill: 'nope' }, ctx())).result).toBe(false);
    expect(
      (await tool.validateInput!({ skill: 'secret' }, ctx())).result,
    ).toBe(false);
    expect((await tool.validateInput!({ skill: 'doc' }, ctx())).result).toBe(true);
  });

  test('checkPermissions: safe skill auto-allow; unsafe → ask (fail-closed)', async () => {
    // safe skill (only allowlisted props) → allow
    const safeTool = buildSkillTool([inline]);
    const ok = await safeTool.checkPermissions({ skill: 'doc' }, ctx());
    expect(ok.behavior).toBe('allow');

    // a skill carrying an unknown meaningful prop → ask (fail-closed)
    const tampered = { ...inline, name: 'tampered', hooks: { PreToolUse: [{}] } };
    const unsafeTool = buildSkillTool([tampered as never]);
    const ask = await unsafeTool.checkPermissions({ skill: 'tampered' }, ctx());
    expect(ask.behavior).toBe('ask');
  });

  test('call on unknown skill throws', async () => {
    const tool = buildSkillTool([inline]);
    await expect(tool.call({ skill: 'ghost' }, ctx())).rejects.toThrow();
  });
});

// ─── skillPack ───────────────────────────────────────────────────────────────

describe('skillPack — builtin CapabilityPack with a Skill tool', () => {
  test('packs default (non-conditional) skills into one Skill tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-pack-'));
    try {
      writeSkill(root, 'alpha', '---\ndescription: a\n---\nbody');
      writeSkill(root, 'beta', '---\ndescription: b\npaths:\n  - x/**\n---\nbody');
      const pack = skillPack([root]);
      expect(pack.name).toBe('skill');
      expect(pack.layer).toBe('builtin');
      expect(pack.tools).toHaveLength(1);
      expect(pack.tools?.[0]?.name).toBe('Skill');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
