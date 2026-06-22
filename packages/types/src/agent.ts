/**
 * Agent 契约 — 见 docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.2.
 *
 * Agent = 「带人格 + 默认 skill 集 + CLI backend 选择 + 记忆目录」的角色。
 * 用户对话的对象，不是工具。
 *
 * 这一层只放契约。AgentLoader / AgentRuntime 在 phase B / C 才落地。
 */
import { z } from 'zod';
import { I18nStringSchema } from './i18n';
import { SkillRefSchema } from './skill';

/** ProviderId 暂时是 plugin id 字符串；phase C 引入 cli-provider 协议时收紧。 */
export const ProviderIdSchema = z.string().min(1);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const AgentCardSchema = z.object({
  name: I18nStringSchema,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{3,8}$/u, 'must be hex color, e.g. #1F6FEB')
    .or(z.string().min(1)), // 兼容 named color
  avatar: z.string().min(1), // emoji or path
  /** 可选: WEBM 状态机头像. 见 ADR-0019.
   *  rulesFile 留空时 loader 默认尝试 './avatar/AVATAR.md'. */
  avatarSet: z
    .object({
      rulesFile: z.string().min(1).optional(),
    })
    .optional(),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;

/** Universal events the UI hook collapses raw session events into.
 *  AVATAR.md 的 events 表用的就是这套枚举名. 上游事件抖动 (AG-UI 协议或
 *  CUSTOM 透传层) 只影响 hook 的归并逻辑, 不动这个枚举. 见 ADR-0019 §Decision §2. */
export const AGENT_AVATAR_EVENTS = [
  'run_start',
  'reasoning_active',
  'speaking_active',
  'tool_active',
  'sub_agent_active',
  'production_signal',
  'metabolism_signal',
  'error_signal',
  'media_active',
  'run_end',
] as const;
export type AgentAvatarEvent = (typeof AGENT_AVATAR_EVENTS)[number];

/** 一个 state 的播放参数 (loader 把 AVATAR.md 表格行解析后注入此结构). */
export interface AgentAvatarState {
  /** state 名 (agent 自定义, e.g. "期待"/"专注"/"happy"). */
  state: string;
  /** webm URL (loader 解析 file 字段 → /api/files/raw?path=... 形式). */
  url: string;
  loop: boolean;
  fadeInMs: number;
  /** 播完跳到哪个 state (非 loop 用或瞬态强制超时跳转). */
  onEnd?: string;
  /** loop=false 时自然播完 + 此毫秒后跳 onEnd; loop=true 时此毫秒后强制跳 onEnd. */
  onEndAfterMs?: number;
}

/** Loader 把 AVATAR.md 解析后注入到 agent 对象上的完整状态机. */
export interface AgentAvatarRules {
  /** 默认 / fallback state 名. */
  default: string;
  fallback: string;
  /** universal event → state name (agent-defined). */
  events: Partial<Record<AgentAvatarEvent, string>>;
  /** state name → 优先级 (数字越小越高). 多 event 并发时取顶层. */
  priority: Record<string, number>;
  /** state name → 资源 + 播放参数. */
  states: Record<string, AgentAvatarState>;
}

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  card: AgentCardSchema,
  personaFile: z.string().min(1),
  memoryDir: z.string().optional(),
  produces: z.array(z.string()).optional(), // glob
  preferredCliProvider: ProviderIdSchema.optional(),
  defaultLang: z.enum(['zh', 'en']).default('zh'),
  multiInstance: z.boolean().default(false),
  defaultSkills: z.array(SkillRefSchema).optional(),
  /** Host 工具白名单（glob，匹配插件清单声明的 `provides.tools[].id`，如
   *  `"narrative:*"`）。host-tools 桥据此把 exposedToAI 的宿主工具注入本 agent
   *  的 LLM 工具清单 —— 即“这个角色可以通过对话调用哪些 workbench 能力”。
   *  缺省（未声明）= 不注入任何宿主工具（opt-in，避免给每个 agent 堆砌全平台工具）。 */
  tools: z.array(z.string()).optional(),
});

/** Loader-resolved agent definition (kind=agent loader 解析 AVATAR.md 后挂的状态机).
 *  AgentDefinitionSchema 本身只声明清单契约 (rulesFile 字符串); 落地后的运行时
 *  对象再通过这层 wrapper 拼上 avatarRules. 见 ADR-0019 §Decision §3. */
export interface ResolvedAgentDefinition extends AgentDefinition {
  avatarRules?: AgentAvatarRules;
}

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** 启动时上下文，AgentLoader.spawn() 的入参。runtime 还没落地，先放契约。*/
export interface AgentBootContext {
  instanceId: string;
  thread: { id: string; cwd: string };
  workbench?: { id: string };
  warnings: string[];
}
