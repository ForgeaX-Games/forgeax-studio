/**
 * AgentKernel contract — the neutral spine the orchestration layer
 * programs against. This is the M1 linchpin of forgeax_os: the
 * orchestration layer (`packages/server/src/core/`) imports ONLY this
 * module, so everything kernel-specific (the agent SDK, the tool-use gate,
 * resume, the streamed-message type, the permission-mode enum) stays locked
 * inside `packages/server/src/kernel/` and never leaks into the spine.
 *
 *   first kernel  = BcKernel           (M2, hidden behind this contract)
 *   second kernel = forgeax-core       (P7, a drop-in slot implementation)
 *
 * Hard rule (boundary lint Rule6, re-added in M3): this file imports NO
 * kernel-isms and NO `@anthropic-ai/*`. The kernel-shaped vocabulary
 * (the native default/acceptEdits/plan/bypass permission enum) lives in
 * the kernel's profile adapter, NOT here (B2 layering). The spine speaks
 * only neutral `PermissionMode` words.
 *
 * Discriminant is `kind:` (inherited from this package's Driver.ChatEvent,
 * the "C1 lock-in shape") — NOT the CliProvider `type:`. The one-time
 * `type:` → `kind:` translation happens in the inbound mapper (M2) and the
 * `kind:` → wire `event:` translation in `toWireEvents` (M5/M3).
 *
 * ─── three-contract reconciliation (设计稿 §1.2, lossless) ─────────────
 * KernelEvent is the supremum (上确界) of the three pre-existing event
 * contracts. Four fields are easy to drop in a re-platform and are each
 * named here so a mapper that omits one fails review:
 *
 *   semantic        CliProvider(type:)   Driver(kind:)   → KernelEvent
 *   text delta      token                token           message.delta
 *   thinking        thinking             (MISSING)       thinking.delta   ← Driver lacked it
 *   tool call       tool-call            tool-call       tool.call
 *   tool args flow  tool-call-delta      (MISSING)       tool.call.delta  ← UI depends on it
 *   tool result     tool-result{ok,err}  tool-result     tool.result{ok,error}
 *   usage           done.usage.cache*    usage{p/c}      turn.usage       ← MUST keep cache tokens
 *   cost/duration   done.{cost,durMs}    —               turn.usage.{costUsd,durationMs}
 *   stop reason     done.stopReason      done.reason     turn.done.reason
 *   error           error{message,code}  error{msg,rec}  error.error (KernelError)
 *   native pass-thru stored-event        —               stored-event     ← forgeax path, rented kernels never emit
 *
 * The wire field renames (`argsDelta→argumentsDelta`, `payload→storedEvent`,
 * `cacheRead→cacheReadTokens`, independent `turn.usage` folded back into
 * `done.usage`) are NOT done here — they happen in `toWireEvents` (§1.2.1)
 * and are guarded by a golden wire snapshot, because the `default: never`
 * exhaustiveness guard only proves `kind` coverage, not payload fidelity.
 */

// ─── identity & capabilities ─────────────────────────────────────────

/** Known kernel ids. Widened with `(string & {})` so future slots and the
 *  test-only NoopKernel ('noop') type-check without editing the spine. */
export type KernelId = 'bc' | 'forgeax-core' | (string & {});

export interface KernelCapabilities {
  /** Streams partial assistant text (`message.delta`). */
  streaming: boolean;
  /** Emits `thinking.delta` reasoning chunks. */
  thinking: boolean;
  /** Supports tool calls (`tool.call` / `tool.result`). */
  toolCalls: boolean;
  /** Can inject context mid-turn. Rented kernels = false (only between-turn L1 +
   *  veto-only L2 at the tool boundary; see 设计稿 §1.3 L2 既定仅否决式). */
  midTurnInject: boolean;
}

// ─── turn inputs ─────────────────────────────────────────────────────

/** Which conversation + which agent persona this turn belongs to.
 *  Converged from CliProvider.ChatRequest. Note `threadId ≠ the kernel's
 *  session id` — the kernel maintains that mapping internally and uses its
 *  own id for resume (协议级真相 ⚠1). */
export interface SessionRef {
  threadId: string;
  agentId: string;
}

export interface InputMessage {
  text: string;
  /** Structured attachments — image refs, files, etc. The shape stays
   *  open; kernels MUST tolerate unknown keys (forward-compat). */
  attachments?: Array<Record<string, unknown>>;
}

/** A neutral conversation message for HOST-OWNED context (`TurnRequest.history`).
 *  Mirrors the shape the orchestration layer's `materialize*` already produces,
 *  kept neutral (no llm-lib import) so the spine stays dependency-free. Tool
 *  results carry their FULL payload so the host's ledger is a faithful, replayable
 *  context source — not just a display projection. See
 *  `历史归属与上下文所有权-取舍方案.md`. */
export type TurnMessage =
  | { role: 'user'; content: string | Array<Record<string, unknown>> }
  | {
      role: 'assistant';
      content: string | Array<Record<string, unknown>>;
      toolCalls?: Array<{ callId: string; name: string; args?: unknown }>;
    }
  | { role: 'tool'; callId: string; ok: boolean; result?: unknown; error?: string };

/** prompt assembly (设计稿 §2.4, bound to prompt-cache B): `charter`+`persona`
 *  form the stable cached prefix; `dynamicSuffix` (active-game note / L1
 *  perception) is injected as a USER-message suffix, never into the system
 *  prompt, so swapping the active game never busts the prefix cache. */
export interface ComposedPrompt {
  charter: string;
  persona: string;
  dynamicSuffix?: string;
  /** How the kernel applies `charter`+`persona` to its system prompt.
   *  'append' (default) keeps the kernel's built-in identity and appends to it;
   *  'replace' fully replaces the kernel default with `charter`+`persona`.
   *  Opaque to the spine; the profile adapter maps it. Absent ⇒ append
   *  (backward-compatible). Kernels without a replace primitive ignore it. */
  mode?: 'append' | 'replace';
}

/** A tool offered to the kernel. Dual delivery: a rented kernel exposes these
 *  as an MCP server; a native core kernel registers them directly. Shape stays
 *  open for forward-compat. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON-schema-ish input contract. Opaque to the spine. */
  inputSchema?: Record<string, unknown>;
  /** 工具执行位置(由 host 决定;权限策略归 host):
   *  - `'host'`(缺省):内核把该工具调用回调宿主执行(host 把闸 + 真实现)。等于现状,作兜底。
   *  - `'local'`:原生 core 内核**在本进程内**用自带 builtin 实现直跑(满速 + crash 隔离)。
   *    host 仅对它信任放行的「安全类」工具(读/写/编辑文件、grep/glob)标 `'local'`;危险类
   *    (bash/出网/删/凭据)仍标 `'host'` 回宿主把闸(ask)。
   *  spine 不解释语义,内核 facade 据此分流;缺省 `'host'` 保向后兼容。 */
  delivery?: 'local' | 'host';
}

export interface Budget {
  maxTurns?: number;
  maxTokens?: number;
  deadlineMs?: number;
  maxBudgetUsd?: number;
}

/** Opaque model identifier. The orchestration layer cascades models
 *  (cheap→Opus); the kernel passes it through and does NOT interpret it. */
export type ModelRef = string;

/** Trust tier of the agent pack, assigned authoritatively by load PATH in
 *  `agents/loader.ts` (NOT self-reported by the pack). builtin/Forge =
 *  'own'; marketplace + user-imported = 'imported'. The spine carries it
 *  as an opaque pass-through (additive, frozen-allowed; wired end-to-end in
 *  M7) — the kernel never interprets trust semantics; enforcement lives in
 *  the host (sidecar + checkTool). */
export type TrustTier = 'own' | 'imported';

export interface TurnRequest {
  session: SessionRef;
  /** Optional caller-supplied correlation id (body.callId). Lets the host
   *  match an in-flight turn to a `TurnHandle` for interrupt/cancel. */
  callId?: string;
  input: InputMessage;
  /** Host-owned full conversation history (incl. tool_use/tool_result structure).
   *  Provided when the orchestration layer wants to OWN context instead of relying
   *  on the kernel's own session continuation. RENTED kernels ignore it and use
   *  their own session store (codex via `exec resume`);
   *  the NATIVE forgeax-core kernel CONSUMES it as the authoritative context.
   *  Absent ⇒ kernel falls back to its own continuation (backward-compatible).
   *  Additive (frozen-allowed). See 历史归属与上下文所有权-取舍方案.md. */
  history?: TurnMessage[];
  systemPrompt: ComposedPrompt;
  /** Dual-delivered tools (see ToolSpec). */
  tools: ToolSpec[];
  /** Tool-surface policy. Carries OPAQUE kernel-native tool names (e.g.
   *  Bash/Read/Edit/Write/Glob/Grep/WebFetch/Task/…); the spine forwards them
   *  verbatim and does NOT interpret them (same contract as `model: ModelRef`).
   *  `allow` = exclusive whitelist of built-in tools the agent may use
   *  (absent ⇒ kernel default = all); `deny` = removed from the model's context
   *  (a bare name like 'Bash', or a wildcard like 'mcp__*'). The profile adapter
   *  maps these onto the kernel's flags; kernels without per-tool control no-op.
   *  Additive (frozen-allowed). */
  toolPolicy?: { allow?: string[]; deny?: string[] };
  budget: Budget;
  /** Orchestration-layer model cascade; pass-through, not interpreted. */
  model?: ModelRef;
  /** Fallback model chain tried in order when `model` is overloaded/unavailable.
   *  Pass-through, not interpreted by the spine.
   *  Absent/empty ⇒ no fallback. Additive (frozen-allowed). */
  fallbackModels?: ModelRef[];
  /** Initial permission mode for THIS turn (neutral enum). The native kernel maps
   *  it via its profile adapter; lets the host start a turn in e.g. `planning`
   *  without a separate `setPermissionMode` control-plane round-trip. Absent ⇒
   *  kernel keeps its current/default mode. Additive (frozen-allowed). */
  permissionMode?: PermissionMode;
  /** Pack trust tier; pass-through to the host enforcement layer (M7). */
  trustTier?: TrustTier;
  /** Host session id (real sid), pass-through for the host-tool bridge: lets a
   *  tool MCP server call back into the host and locate the live agent by
   *  (sid, agentId). Distinct from `session.threadId` (which the kernel maps to
   *  its own CLI session id, often a synthetic UUID). Opaque to the kernel
   *  except for forwarding into the tool server's env. */
  hostSessionId?: string;
  /** Blocking gate (the single tool-use chokepoint, fail-closed).
   *  Absent ⇒ kernel applies its own default. */
  requestPermission?(call: PermissionCall): Promise<PermissionDecision>;
  /** Fire-and-forget lifecycle injection (PreToolUse/PostToolUse/turnEnd). */
  hooks?: HookEndpoint;
}

// ─── permission gate ─────────────────────────────────────────────────

export interface PermissionCall {
  name: string;
  args: unknown;
  /** Correlates to the emitted `tool.call.callId`. */
  callId?: string;
  /** The kernel's tool-use id, when the underlying kernel surfaces one. */
  toolUseId?: string;
  /** Kernel-supplied edit suggestions; opaque to the gate. */
  suggestions?: unknown;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedArgs?: unknown }
  | { behavior: 'deny'; message: string };

/** Neutral permission modes. The kernel's profile adapter maps these onto
 *  the kernel's native permission enum — the spine stays free of kernel-native
 *  vocabulary (B2):
 *    gated        → every tool gated (native 'default')
 *    autoEdits    → auto-approve edits (native 'acceptEdits')
 *    planning     → plan only, no execution (native 'plan')
 *    unrestricted → bypass the gate (native 'bypassPermissions') */
export type PermissionMode = 'gated' | 'autoEdits' | 'planning' | 'unrestricted';

// ─── hooks (fire-and-forget) ─────────────────────────────────────────

export interface HookEndpoint {
  preToolUse?(call: PermissionCall): void | Promise<void>;
  postToolUse?(call: PermissionCall, result: { ok: boolean; result?: unknown; error?: string }): void | Promise<void>;
  turnEnd?(summary: { reason: TurnDoneReason }): void | Promise<void>;
}

// ─── streamed events ─────────────────────────────────────────────────

export type TurnDoneReason =
  | 'stop'
  | 'tool_use'
  | 'max_tokens'
  | 'max_turns'
  | 'cancelled'
  | 'error';

/** The 12-kind streamed event union. The trailing `x.*` extensions are
 *  injected by the orchestration layer and DROPPED by the rented-kernel exporter
 *  (they have no native representation). */
export type KernelEvent =
  | { kind: 'message.delta'; role: 'assistant'; text: string }
  | { kind: 'thinking.delta'; text: string }
  | { kind: 'tool.call'; callId: string; name: string; args: unknown }
  | { kind: 'tool.call.delta'; callId: string; name: string; argsDelta: string }
  | { kind: 'tool.result'; callId: string; ok: boolean; result?: unknown; error?: string }
  | {
      kind: 'turn.usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheCreation?: number;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'turn.done'; reason: TurnDoneReason }
  | { kind: 'error'; error: KernelError }
  | { kind: 'stored-event'; payload: Record<string, unknown> }
  // forgeax extensions (orchestration-injected; rented-kernel exporter discards):
  | { kind: 'x.delegation'; delegator: string; agentId: string; brief: string }
  | { kind: 'x.file_activity'; path: string; op: 'write' | 'read' | 'create' }
  | { kind: 'x.perception'; source: 'world' | 'screen' | 'console' | 'playtest'; payload: unknown }
  | { kind: 'x.subagent.start'; agentId: string; agentType?: string; role?: string; depth: number }
  | { kind: 'x.subagent.turn'; agentId: string; turn: number }
  | { kind: 'x.subagent.tool'; agentId: string; callId: string; name: string }
  | { kind: 'x.subagent.done'; agentId: string; reason: string; turns: number; toolCalls: number };

/** All `kind` literals of KernelEvent, kept in sync with the union by a
 *  compile-time exhaustiveness check in the test suite (and by
 *  `toWireEvents`' `default: never` guard in M3). */
export type KernelEventKind = KernelEvent['kind'];

/** Closed error union — replaces Driver's `{message,recoverable}` and
 *  CliProvider's `{message,code?}`. A missing kernel is an explicit `error`
 *  event with `kernel_unavailable`, NOT a silent NoopKernel fallback
 *  (v9 decision #6 / M5). */
export type KernelError =
  | { code: 'kernel_unavailable'; message: string }
  | { code: 'tool_failed'; message: string; retryable: boolean }
  | { code: 'budget_exceeded'; message: string }
  | { code: 'driver_timeout'; message: string }
  | { code: 'cancelled'; message: string }
  | { code: 'protocol'; message: string };

// ─── kernel slot ─────────────────────────────────────────────────────

export interface KernelHealth {
  ok: boolean;
  kernelId: KernelId;
  /** Free-form detail for the SettingsPanel row. */
  detail?: string;
}

/** Active-turn control handle. The neutral face only — `setModel`,
 *  `interrupt`, `cancel`. `setPermissionMode` takes the NEUTRAL
 *  `PermissionMode`; the kernel's profile adapter translates it to the kernel's
 *  native enum. (B2: the spine never names native permission modes.) */
export interface TurnHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  /** Turn-level graceful interrupt (kernel interrupt). */
  interrupt(): Promise<void>;
  /** Call-level cancel (= the existing cancelWithDeadline wrapper). */
  cancel(): Promise<void>;
}

/** The single slot the orchestration layer programs against. One
 *  implementation in phase 1 (BcKernel); forgeax-core is the
 *  second slot (P7). Swapping kernels swaps only this implementation —
 *  the orchestration layer changes zero lines. */
export interface AgentKernel {
  readonly id: KernelId;
  readonly capabilities: KernelCapabilities;
  /** Run one turn. `usage` MUST be emitted before `turn.done`, including on
   *  cancelled/error paths (best-effort fields), so budget/cascade
   *  accounting never drops a turn (B5). */
  runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent>;
  /** Control handle for the in-flight turn identified by `callId`. */
  openHandle(callId: string): TurnHandle;
  /** Readiness probe (= the converged Driver.health / CliProvider.health). */
  probe(): Promise<KernelHealth>;
  /** Optional one-shot init (reuses this package's bootDriver semantics). */
  init?(): Promise<void>;
  /** Optional teardown — kernels holding subprocess/sidecar handles release
   *  them here. */
  shutdown?(): Promise<void>;
}

// ─── in-process kernel registry ──────────────────────────────────────
// Mirrors the driver registry in `./driver` (落点决议: 复用 registry +
// bootDriver 语义). `resolve-kernel.ts` (M5) builds kernel selection on top
// of these primitives. A missing kernel is surfaced as an explicit
// KernelError by the resolver, never as a silent NoopKernel.

interface KernelSlot {
  kernel: AgentKernel;
  /** When `init()` rejects, the slot is retained so the UI can paint a red
   *  badge; routing must consult `isKernelBroken` before dispatching. */
  brokenReason?: string;
}

const _kernels = new Map<KernelId, KernelSlot>();

export function registerKernel(k: AgentKernel): void {
  _kernels.set(k.id, { kernel: k });
}

export function unregisterKernel(id: KernelId): boolean {
  return _kernels.delete(id);
}

export function getKernel(id: KernelId): AgentKernel | null {
  return _kernels.get(id)?.kernel ?? null;
}

export function listKernels(): AgentKernel[] {
  return Array.from(_kernels.values()).map((s) => s.kernel);
}

/** Boot a kernel: run `init()` if present, mark broken on failure. Returns
 *  the broken reason on failure, null on success. Always registers first so
 *  the SettingsPanel can render the row even when init fails. */
export async function bootKernel(k: AgentKernel): Promise<string | null> {
  registerKernel(k);
  if (!k.init) return null;
  try {
    await k.init();
    return null;
  } catch (e) {
    const reason = (e as Error).message ?? String(e);
    const slot = _kernels.get(k.id);
    if (slot) slot.brokenReason = reason;
    return reason;
  }
}

/** Call shutdown() if present, swallow errors, drop the slot. */
export async function shutdownKernel(id: KernelId): Promise<void> {
  const slot = _kernels.get(id);
  if (!slot) return;
  try {
    await slot.kernel.shutdown?.();
  } catch {
    // intentionally swallowed — registry must always release the slot
  }
  _kernels.delete(id);
}

export function isKernelBroken(id: KernelId): boolean {
  return Boolean(_kernels.get(id)?.brokenReason);
}

export function getKernelBrokenReason(id: KernelId): string | null {
  return _kernels.get(id)?.brokenReason ?? null;
}

/** Test helper — reset the kernel registry between cases. Best-effort
 *  shutdown on each slot. */
export function _resetKernelRegistryForTests(): void {
  for (const slot of _kernels.values()) {
    try {
      void slot.kernel.shutdown?.();
    } catch {
      // swallow
    }
  }
  _kernels.clear();
}
