/**
 * Host SDK postMessage 协议 — 见 docs/v2-vision/architecture-evolution/06-WORKBENCH-THREE-PANE-V2.md
 * + 07-INTERFACE-EXPOSURE.md.
 *
 * 把 host (interface) 跟 plugin (iframe) 之间走的 postMessage 收口成 5 类 envelope:
 *   - handshake: 协议版本协商
 *   - chat:      plugin 把消息发到 ChatPanel
 *   - tool:      plugin → host 调 host-side tool（包含其他 plugin 暴露的 tool）
 *   - surface:   plugin 报告自己当前 UI 状态 + 可触发动作（AI 走 ts/js/html 路径）
 *   - theme:     host → plugin 推主题 / locale
 *
 * 实现包 @forgeax/host-sdk 在 phase A2 落地（packages/host-sdk/）。本文件只是
 * 协议契约 —— iframe 两端 import 后 type-check 同一份 envelope。
 */
import { z } from 'zod';
import { ToolCallSchema, ToolResultSchema } from './tool';

/* ----------------------------------------------------------------------------
 * Envelope envelope: 所有消息共享 header
 * --------------------------------------------------------------------------*/

const EnvelopeBase = {
  /** 协议版本，目前只支持 1。Phase B-D 可能升 2。 */
  v: z.literal(1),
  /** 单调递增 nonce，用于 reply 配对。 */
  id: z.string().min(1),
  /** RPC 时回填发起者的 id，便于异步 reply。 */
  replyTo: z.string().optional(),
  /** 来源端 — host 还是某个 plugin。 */
  from: z.union([
    z.object({ kind: z.literal('host') }),
    z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1) }),
  ]),
  /** ISO timestamp。host 可用于 ledger。 */
  ts: z.string().optional(),
};

/* ----------------------------------------------------------------------------
 * 1. Handshake
 * --------------------------------------------------------------------------*/

export const HandshakeRequestSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('handshake.request'),
  /** plugin 自己声明它实现的 protocol versions */
  protocols: z.array(z.literal(1)).min(1),
});

export const HandshakeResponseSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('handshake.response'),
  /** host 选定的 protocol version */
  protocol: z.literal(1),
  /** host 当前 locale + theme，plugin 可立即同步 */
  locale: z.enum(['zh', 'en', 'ja']).default('zh'),
  theme: z.enum(['light', 'dark']).default('dark'),
  /** session/thread 上下文，用于 tool call 的 caller 字段 */
  ctx: z
    .object({
      sessionId: z.string().optional(),
      threadId: z.string().optional(),
      pane: z.enum(['left', 'center']).optional(),
    })
    .optional(),
});

/* ----------------------------------------------------------------------------
 * 2. Chat — plugin 往 ChatPanel 发消息
 * --------------------------------------------------------------------------*/

export const ChatPostSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('chat.post'),
  /** plugin 写一段给当前 active agent 的消息（如同用户输入）。 */
  text: z.string().min(1),
  /** 可选附件 url 列表（host 端 resolve）。 */
  attachments: z.array(z.string()).optional(),
});

/* ----------------------------------------------------------------------------
 * 3. Tool — plugin → host: 调内置或别 plugin 暴露的 tool
 * --------------------------------------------------------------------------*/

export const ToolCallEnvelopeSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('tool.call'),
  call: ToolCallSchema,
});

export const ToolResultEnvelopeSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('tool.result'),
  result: ToolResultSchema,
});

/* ----------------------------------------------------------------------------
 * 4. Surface — plugin 主动 expose 自己当前可触发的动作
 *    （AI 走 ts/js/html structured 路径不走 vision，这是它的入口）
 * --------------------------------------------------------------------------*/

export const SurfaceExposeSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('surface.expose'),
  surfaceId: z.string().min(1),
  /** 当前 UI 上「可点击 / 可填」的元素集合。每条 = 一个等价 toolId + 当前 args。*/
  actions: z.array(
    z.object({
      id: z.string().min(1),                  // tool id (即 button 等价 tool)
      label: z.string().optional(),
      args: z.unknown().optional(),           // 当前 args 快照（schema 由 ToolSpec 描述）
      enabled: z.boolean().default(true),
      hotkey: z.string().optional(),
    }),
  ),
  /** UI 状态快照，AI 读它做决策。结构由 plugin 自定义。 */
  snapshot: z.unknown().optional(),
});

export const SurfaceDispatchSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('surface.dispatch'),
  /** host → plugin: 触发某条 action（来自 AI tool-call 等）。 */
  surfaceId: z.string().min(1),
  actionId: z.string().min(1),
  args: z.unknown().optional(),
  /** plugin 完成后回 surface.ack envelope。 */
  awaitAck: z.boolean().default(true),
});

export const SurfaceAckSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('surface.ack'),
  surfaceId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.unknown().optional(),
});

/* ----------------------------------------------------------------------------
 * 5. Theme — host → plugin: 推 theme/locale 变化
 * --------------------------------------------------------------------------*/

export const ThemeChangedSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('theme.changed'),
  locale: z.enum(['zh', 'en', 'ja']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
});

/* ----------------------------------------------------------------------------
 * 6. UI flash — host → plugin: 让 plugin 在它的 surface 上做 1.5s 视觉高亮
 *    Doc 07 §9.2 fx-ai-acting：AI 触发 tool.starting 时 host 找到对应 surface
 *    所属的 iframe，再发 ui.flash，plugin SDK 在内部找 selector 加 class。
 *
 *    selector 不强约束 schema —— plugin SDK 默认会拼 `[data-fx-surface="${surfaceId}"]`
 *    + `[data-fx-action="${actionId}"]`，但允许调用方传任意 CSS selector 覆盖。
 * --------------------------------------------------------------------------*/

export const UiFlashSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('ui.flash'),
  surfaceId: z.string().min(1),
  /** 与 surface.expose 中的 action.id 对齐；不传 = 高亮整个 surface */
  actionId: z.string().optional(),
  /** 自定义 CSS selector；不传则按 data-fx-* 反查 */
  selector: z.string().optional(),
  /** 高亮持续毫秒，默认 1500 */
  durationMs: z.number().int().positive().max(10_000).optional(),
  /** 触发来源（caller.kind），plugin 可基于此切换颜色 */
  cause: z.enum(['ai', 'cli', 'event', 'user']).optional(),
});

/* ----------------------------------------------------------------------------
 * 7. Visibility — host → plugin: keep-alive 面板显隐信号
 *    Module: docs/v2-vision/architecture-evolution/06-WORKBENCH-THREE-PANE-V2.md
 *
 *    host 切换面板时不再卸载 iframe（避免整页 reload / 冷启动），而是把不活跃
 *    的 iframe 用 CSS 隐藏并常驻 DOM。隐藏期间浏览器仍认为 iframe 的 document
 *    可见（document.hidden=false），所以 3D / rAF 渲染循环会继续烧 GPU/CPU。
 *    host 通过本 envelope 显式告诉 plugin 当前是否可见，重型 plugin 据此在
 *    隐藏时暂停渲染循环、恢复时 resume —— 这是 keep-alive 架构的配套。
 * --------------------------------------------------------------------------*/

export const VisibilityChangedSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('visibility.changed'),
  /** true = 面板当前可见（活跃 tab）；false = 已被 CSS 隐藏但仍 keep-alive。 */
  visible: z.boolean(),
});

/* ----------------------------------------------------------------------------
 * 8. Navigate — plugin → host: 请求宿主切换到另一个 workbench 插件,并把交接
 *    数据(角色 id / role 等)带过去。
 *
 *    背景:角色设计(wb-character)与动画工作台(wb-anim)拆成独立插件后,旧的
 *    `ce:switch-pipeline` window 事件跨不出 iframe。这个 envelope 让 wb-character
 *    的「生成动画」按钮能请求宿主把 active workbench 切到 wb-anim,并透传刚生成的
 *    charId + role,wb-anim 据此从磁盘 manifest 读回角色、按 role 分流到对应管线。
 *
 *    payload 故意宽松(z.unknown record),因为不同目标插件需要的交接字段不同;
 *    约定字段:targetPluginId(必填)、charId、role、slug。
 * --------------------------------------------------------------------------*/

export const NavigateRequestSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal('navigate.request'),
  /** 要切到的目标插件 id,如 '@forgeax-plugin/wb-anim'。 */
  targetPluginId: z.string().min(1),
  /** 交接给目标插件的上下文(charId / role / slug 等)。 */
  payload: z.record(z.string(), z.unknown()).optional(),
});

/* ----------------------------------------------------------------------------
 * Top-level discriminated union
 * --------------------------------------------------------------------------*/

export const HostSdkEnvelopeSchema = z.discriminatedUnion('kind', [
  HandshakeRequestSchema,
  HandshakeResponseSchema,
  ChatPostSchema,
  ToolCallEnvelopeSchema,
  ToolResultEnvelopeSchema,
  SurfaceExposeSchema,
  SurfaceDispatchSchema,
  SurfaceAckSchema,
  ThemeChangedSchema,
  UiFlashSchema,
  VisibilityChangedSchema,
  NavigateRequestSchema,
]);

export type HostSdkEnvelope = z.infer<typeof HostSdkEnvelopeSchema>;

/* ----------------------------------------------------------------------------
 * Convenience: ResultFor<E> maps a request envelope to its expected reply kind.
 * Phase A2 host-sdk 用它做 type-safe RPC wrapper。
 * --------------------------------------------------------------------------*/

export type ResultFor<K extends HostSdkEnvelope['kind']> =
  K extends 'handshake.request' ? Extract<HostSdkEnvelope, { kind: 'handshake.response' }>
  : K extends 'tool.call' ? Extract<HostSdkEnvelope, { kind: 'tool.result' }>
  : K extends 'surface.dispatch' ? Extract<HostSdkEnvelope, { kind: 'surface.ack' }>
  : never;
