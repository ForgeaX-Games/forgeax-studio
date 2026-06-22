/**
 * forgeax-plugin.json zod schema — single source of truth.
 *
 * 见 docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §3
 * 「三体 manifest 合法组合 + R1/R2/R3 规则」。
 *
 * R1: 每个 plugin 只有一个主 kind。kind=workbench 可带 skills/tools，但不能
 *     带 agent；反向也成立。Discriminated union by `kind` 强制这一点。
 * R2: provides.skills[] 在不同 host 里语义不同（全局 / agent-default / workbench-bound）
 *     —— loader 行为，schema 只校验形状。
 * R3: 跨 plugin SkillRef 用 `@scope/name#skillId`（在 src/skill.ts 落 SkillRefSchema）。
 *
 * 这个 schema 必须接受 packages/marketplace/plugins/ 下当前 20 个真实 manifest（验收
 * 标准见 13-MIGRATION-ROADMAP §A1）。test/validate-manifests.ts 跑回归。
 */
import { z } from 'zod';
import { I18nStringSchema } from './i18n';
import { ManifestSkillEntrySchema } from './skill';
import { ManifestToolEntrySchema } from './tool';

/* ============================================================================
 * Common building blocks
 * ==========================================================================*/

// 第二段起始字符允许 `_`，用于约定俗成的 `_template` / `_archive` 等隐藏样板。
const PluginIdSchema = z
  .string()
  .min(1)
  .regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*$/u, {
    message: 'plugin id must be `@scope/name` (lowercase, kebab/snake; name may start with `_` for templates)',
  });

const SemverLikeSchema = z.string().min(1); // 不严格校验 semver；loader 层再说

const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

const DependencySchema = z.object({
  id: PluginIdSchema,
  versionRange: z.string().optional(),
  optional: z.boolean().optional(),
});

/** Permission scope 字符串 —— 详见 03 §6 + 10 §签名/install flow。
 *  目前仍由 loader 自己解析；schema 只断言非空字符串。 */
const PermissionScopeSchema = z.string().min(1);

const EventDeclSchema = z.object({
  name: z.string().min(1),
  payload: z.union([z.string().min(1), z.unknown()]).optional(),
});

const ConsumesSchema = z
  .object({
    models: z
      .array(
        z.object({
          channel: z.string().min(1),
          role: z.string().min(1),
        }),
      )
      .optional(),
  })
  .optional();

/* ============================================================================
 * provides.{...} kind-specific shapes
 * ==========================================================================*/

const PaneSchema = z.object({
  width: z.number().optional(),
  minHeight: z.number().optional(),
  scrollable: z.boolean().optional(),
});

const ProvidesWorkbenchSchema = z.object({
  id: z.string().min(1),
  lens: z.string().optional(),
  icon: z.string().optional(),
  position: z.number().optional(),
  panelSize: z.enum(['sm', 'md', 'lg']).optional(),
  surface: z.string().optional(), // "split" 等
  panes: z
    .object({
      left: PaneSchema.optional(),
      center: PaneSchema.optional(),
    })
    .optional(),
  bus: z.object({ surfaceId: z.string().min(1) }).optional(),
  matchProduces: z.array(z.string()).optional(),
  hidden: z.boolean().optional(),
  // Soft hint: when this workbench plugin is active, the workbench panel's
  // upper-right agent picker defaults to this agent (a sub-agent panel under
  // the current session). Does NOT lock the user — they can still pick any
  // session agent from the dropdown. R1 untouched: this is a string ref to
  // an agent-kind plugin id, not an inline agent definition.
  preferredAgent: z.string().min(1).optional(),
});

const ProvidesAgentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  card: z.object({
    name: I18nStringSchema,
    color: z.string().min(1),
    avatar: z.string().min(1),
    // ADR-0019: WEBM 状态机头像. 缺省时 loader 也会自动尝试 ./avatar/AVATAR.md.
    avatarSet: z
      .object({
        rulesFile: z.string().min(1).optional(),
      })
      .optional(),
  }),
  personaFile: z.string().min(1),
  memoryDir: z.string().optional(),
  produces: z.array(z.string()).optional(),
  preferredCliProvider: z.string().optional(),
  defaultLang: z.enum(['zh', 'en']).optional(),
  multiInstance: z.boolean().optional(),
  // defaultSkills 用 SkillRefSchema 严格校验，但允许缺省
  defaultSkills: z.array(z.unknown()).optional(),
  // Host 工具白名单 glob（如 ["narrative:*"]）；host-tools 桥据此把 exposedToAI
  // 的宿主工具注入此 agent 的对话工具清单。缺省 = 不注入（opt-in）。
  tools: z.array(z.string()).optional(),
});

const ProvidesCliProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  models: z.array(z.string()).optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      thinking: z.boolean().optional(),
      toolCalls: z.boolean().optional(),
      subAgents: z.boolean().optional(),
      sessions: z.boolean().optional(),
    })
    .optional(),
  runner: z
    .object({
      cmd: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    })
    .optional(),
});

const ProvidesModelBindingSchema = z.object({
  channel: z.string().min(1),
  vendor: z.string().min(1),
  models: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});

/** DUAL-MODALITY-UI sec 4.2 - declarative surface registration.
 *  Each surface declares one or more actions; loaders auto-register them
 *  with the bus.ui registry at plugin load. `requireConfirm` reuses the
 *  3-value enum from ManifestToolEntry. `exposedToAI=false` keeps a surface
 *  out of `bus.tools.list` (e.g. internal selection state). */
const SurfaceActionSchema = z.object({
  id: z.string().min(1),
  exposedToAI: z.boolean().optional(),
  permission: PermissionScopeSchema.optional(),
  requireConfirm: z.enum(['always', 'destructive', 'never']).optional(),
});

const ProvidesSurfaceSchema = z.object({
  id: z.string().min(1),
  schema: z.string().optional(),
  actions: z.array(SurfaceActionSchema).optional(),
});

/* ============================================================================
 * Entry points
 * ==========================================================================*/

const EntrySchema = z.object({
  backend: z.string().optional(),
  frontend: z.string().optional(),
  standalone: z
    .object({
      start: z.string().optional(),
      port: z.number().optional(),
      readyProbe: z.string().optional(),
      dev: z
        .object({
          watch: z.boolean().optional(),
          hmr: z.boolean().optional(),
        })
        .optional(),
      embeddedAlso: z.boolean().optional(),
      /** Doc 14 §4 spike — dev-only standalone entry. When true, the host
       *  refuses to load this entry under FORGEAX_NODE_ENV=production. Lets
       *  authors ship a `bun --watch dev.ts` shim without it leaking into
       *  packaged builds. */
      devOnly: z.boolean().optional(),
    })
    .optional(),
});

/* ============================================================================
 * Common base — fields every kind shares
 * ==========================================================================*/

const ManifestBase = {
  schemaVersion: z.literal(1),
  id: PluginIdSchema,
  version: SemverLikeSchema,
  displayName: I18nStringSchema,
  description: I18nStringSchema.optional(),
  author: AuthorSchema.optional(),
  icon: z.string().optional(),
  hidden: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  dependencies: z.array(DependencySchema).optional(),
  consumes: ConsumesSchema,
  entry: EntrySchema.optional(),
  permissions: z.array(PermissionScopeSchema).optional(),
  hot: z.boolean().optional(),
  experimental: z.boolean().optional(),
  compatibleWith: z.record(z.string()).optional(),
  /** GAP 5 — plugin declares which host env vars it needs.
   *  Tool handlers receive only these keys via ctx.env (any other key is
   *  scrubbed). Default empty → no env exposed. Plugins authored against
   *  the host SDK MUST list keys here instead of reading process.env
   *  directly. */
  requestedEnv: z.array(z.string().min(1)).optional(),
};

/* ============================================================================
 * Discriminated union by `kind` — enforces R1.
 * ==========================================================================*/

export const ManifestKindSchema = z.enum([
  'agent',
  'skill',
  'workbench',
  'cli-provider',
  'model-binding',
  'tool',
]);

export type ManifestKind = z.infer<typeof ManifestKindSchema>;

/** kind=workbench: 必含 provides.workbench；可含 skills/tools/events；R1 禁带 agent/cliProvider/modelBinding */
export const WorkbenchManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('workbench'),
  provides: z
    .object({
      workbench: ProvidesWorkbenchSchema,
      skills: z.array(ManifestSkillEntrySchema).optional(),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
    })
    .strict(),
});

/** kind=agent: 必含 provides.agent；可带 skills/tools；R1 禁带 workbench/cliProvider/modelBinding */
export const AgentManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('agent'),
  provides: z
    .object({
      agent: ProvidesAgentSchema,
      skills: z.array(ManifestSkillEntrySchema).optional(),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
    })
    .strict(),
});

/** kind=skill: 必含 provides.skills (>=1)。skill plugin 也可带自己的 tools。 */
export const SkillManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('skill'),
  provides: z
    .object({
      skills: z.array(ManifestSkillEntrySchema).min(1),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
    })
    .strict(),
});

/** kind=cli-provider */
export const CliProviderManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('cli-provider'),
  provides: z
    .object({
      cliProvider: ProvidesCliProviderSchema,
    })
    .strict(),
});

/** kind=model-binding */
export const ModelBindingManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('model-binding'),
  provides: z
    .object({
      modelBinding: ProvidesModelBindingSchema,
    })
    .strict(),
});

/** kind=tool: 必含 provides.tools (>=1) */
export const ToolManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('tool'),
  provides: z
    .object({
      tools: z.array(ManifestToolEntrySchema).min(1),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
    })
    .strict(),
});

/** 顶层 union — 按 kind 分发 */
export const ManifestSchema = z.discriminatedUnion('kind', [
  WorkbenchManifestSchema,
  AgentManifestSchema,
  SkillManifestSchema,
  CliProviderManifestSchema,
  ModelBindingManifestSchema,
  ToolManifestSchema,
]);

export type PluginManifest = z.infer<typeof ManifestSchema>;
export type WorkbenchManifest = z.infer<typeof WorkbenchManifestSchema>;
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type CliProviderManifest = z.infer<typeof CliProviderManifestSchema>;
export type ModelBindingManifest = z.infer<typeof ModelBindingManifestSchema>;
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/* ============================================================================
 * Helpers
 * ==========================================================================*/

export interface ManifestParseResult {
  ok: boolean;
  manifest?: PluginManifest;
  error?: z.ZodError;
  /** 警告 — schema 通过了但有 soft issue（如缺 description）。 */
  warnings: string[];
}

export function parseManifest(input: unknown): ManifestParseResult {
  const r = ManifestSchema.safeParse(input);
  const warnings: string[] = [];
  if (!r.success) return { ok: false, error: r.error, warnings };

  const m = r.data;
  if (!('description' in m) || m.description === undefined) {
    warnings.push('description missing — Settings UI will fall back to displayName');
  }
  return { ok: true, manifest: m, warnings };
}
