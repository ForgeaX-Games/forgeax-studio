/**
 * Skill 契约 — 见 docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.3.
 *
 * Skill = 「可独立分发、可被 agent 装载、可被 workbench 触发」的能力模块。
 * 与 Plugin (分发单位) 和 Agent (人格容器) 正交。
 *
 * 这一层只放契约 (TS interface + zod schema)。runtime SkillRunner / SkillResolver
 * 在 phase B / D 才落地，本文件不引任何 server-only 依赖。
 */
import { z } from 'zod';
import { I18nStringSchema } from './i18n';

/* ----------------------------------------------------------------------------
 * SkillEntry：skill 的执行入口三选一
 * --------------------------------------------------------------------------*/

export const SkillEntryPromptSchema = z.object({
  kind: z.literal('prompt'),
  file: z.string().min(1), // 相对 plugin 根的 .md 路径
});

export const SkillEntryTsSchema = z.object({
  kind: z.literal('ts'),
  file: z.string().min(1),
  export: z.string().optional(), // dynamic import 后取的命名导出
});

export const SkillEntryPySchema = z.object({
  kind: z.literal('py'),
  file: z.string().min(1),
  entry: z.string().optional(), // python 函数名
});

export const SkillEntrySchema = z.discriminatedUnion('kind', [
  SkillEntryPromptSchema,
  SkillEntryTsSchema,
  SkillEntryPySchema,
]);

export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/* ----------------------------------------------------------------------------
 * SkillTrigger：UI / CLI / event 三种触发面
 * --------------------------------------------------------------------------*/

export const SkillTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slash'), command: z.string().min(1) }),
  z.object({ kind: z.literal('ui'), surface: z.string().min(1) }),
  z.object({ kind: z.literal('event'), topic: z.string().min(1) }),
]);

export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

/* ----------------------------------------------------------------------------
 * SkillPermission：脚本类 skill 的沙箱白名单
 * --------------------------------------------------------------------------*/

export const SkillPermissionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fs'),
    mode: z.enum(['read', 'write']),
    path: z.string().min(1), // glob
  }),
  z.object({ kind: z.literal('tool'), id: z.string().min(1) }),
  z.object({ kind: z.literal('net'), host: z.string().min(1) }),
  z.object({ kind: z.literal('spawn'), cmd: z.string().min(1) }),
]);

export type SkillPermission = z.infer<typeof SkillPermissionSchema>;

/* ----------------------------------------------------------------------------
 * SkillRef：agent.defaultSkills[] / 跨 plugin 引用
 * --------------------------------------------------------------------------*/

export const SkillRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('plugin'), pluginId: z.string().min(1), skillId: z.string().optional() }),
  z.object({ source: z.literal('inline'), skillId: z.string().min(1) }),
]);

export type SkillRef = z.infer<typeof SkillRefSchema>;

/* ----------------------------------------------------------------------------
 * SkillDefinition：完整契约（loader 注册时的形态）
 * --------------------------------------------------------------------------*/

export const SkillDefinitionSchema = z.object({
  id: z.string().min(1),
  entry: SkillEntrySchema,
  triggers: z.array(SkillTriggerSchema).min(1),
  requiresTools: z.array(z.string()).optional(),
  permissions: z.array(SkillPermissionSchema).optional(),
  io: z
    .object({
      input: z.unknown().optional(),
      output: z.unknown().optional(),
    })
    .optional(),
  /** 04 §timeout — wall-clock cap for ts skill execution; defaults to 60000 (60s)
   *  when omitted. The runner aborts via Promise.race; in-flight side effects
   *  (fs writes / tool calls already running) are not retracted. */
  timeoutMs: z.number().int().positive().optional(),
  displayName: I18nStringSchema,
  description: I18nStringSchema,
});

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

/* ----------------------------------------------------------------------------
 * 现存 manifest 里的简短形态 — 兼容接受 (Phase A1 验收要求 17 plugin 通过)。
 *  - skill-make-game-design 写法: `{ id, entry: "./SKILL.md", trigger: "/foo" }`
 *  - 三层路径都允许 entry 是裸字符串（默认推断为 prompt）
 *  - trigger 单值字符串 = slash 触发的语法糖 (以 `/` 开头)
 * 这是 ManifestSchema 的 provides.skills[] 用的 shape，不是上面 strict
 * SkillDefinition。loader 的 KindLoader 负责把它 normalize 到 SkillDefinition。
 * --------------------------------------------------------------------------*/

export const ManifestSkillEntrySchema = z.object({
  id: z.string().min(1),
  /** prompt 形态可写 "./SKILL.md"；ts/py 形态可写 SkillEntry object */
  entry: z.union([z.string().min(1), SkillEntrySchema]).optional(),
  /** 简写：`/cmd` */
  trigger: z.string().optional(),
  triggers: z.array(SkillTriggerSchema).optional(),
  requiresTools: z.array(z.string()).optional(),
  permissions: z.array(SkillPermissionSchema).optional(),
  io: z.object({ input: z.unknown().optional(), output: z.unknown().optional() }).optional(),
  timeoutMs: z.number().int().positive().optional(),
  displayName: I18nStringSchema.optional(),
  description: I18nStringSchema.optional(),
});

export type ManifestSkillEntry = z.infer<typeof ManifestSkillEntrySchema>;
