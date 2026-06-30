/**
 * R3 sidecar 控制协议类型(SoT,规格 §2)。self-contained:不依赖任何 @forgeax/* 包,
 * 让 sidecar 进程零外部依赖、可独立 spawn/typecheck;server 侧 client 镜像同款形状。
 */

/** 信任档(规格 §1.2)。本地定义,避免跨包依赖。 */
export type TrustTier = 'own' | 'imported';

/** 内核 spawn 规格(② 编排层 → ③ sidecar)。 */
export interface KernelSpawnSpec {
  kind: 'forgeax-core' | 'bc' | 'codex' | (string & {});
  /** forgeax-core=sidecar 托管;外部 CLI=user 自管(本阶段不区分,仅进程监督)。 */
  credential: 'sidecar-managed' | 'user-managed';
  cmd: string;
  args: string[];
  cwd?: string;
  /** 注入子进程的 env(server 侧已 allowlist/scrub;sidecar 原样用)。 */
  env?: Record<string, string>;
  resourceLimits?: { cpuPct?: number; memMb?: number; maxProcs?: number };
  /**
   * serve 模式(forgeax-core --serve):子进程不走 stdout-JSONL,而是在
   * `StartSessionReq.endpoint` 指定的 per-session unix-sock 上起双向 JSON-RPC。
   * Host 仍只做进程监督(spawn/kill/reap/cred/sandbox),**不解析该 sock 内容**——
   * 数据面由 adapter 直连(就绪靠 adapter 侧连接探测,Host 不 sniff stdout)。
   * 缺省/false ⇒ 旧 stdout-JSONL 形态(rented 内核,如 codex)。 */
  serveMode?: boolean;
}

export interface StartSessionReq {
  sessionId: string;
  agentId: string;
  trustTier: TrustTier;
  /** 关联 callId(用于 cancel 寻址;缺省 = sessionId)。 */
  callId?: string;
  budget?: { maxTurns?: number; maxTokens?: number; deadlineMs?: number; maxBudgetUsd?: number };
  kernel: KernelSpawnSpec;
  /** serve 模式:adapter 提供的 per-session unix-sock 路径(子进程将在此监听;
   *  adapter 自行把 `--sock <path>` 放进 kernel.args)。Host 原样回 grant.endpoint,
   *  不解析、不连接(协议无关)。缺省 ⇒ 非 serve。 */
  endpoint?: string;
}

export interface SessionGrant {
  sessionId: string;
  pid: number;
  pgid: number;
  /** 仅 credential==='sidecar-managed' 才有(S2 接入);本阶段恒空。 */
  scopedToken?: string;
  baseUrl?: string;
  /** serve 模式:回显 `StartSessionReq.endpoint`(adapter 据此直连 serve 子进程)。 */
  endpoint?: string;
}

export interface KernelProcessHandle {
  sessionId: string;
  pid: number;
  pgid: number;
  startedAt: number;
  trustTier: TrustTier;
}

export interface SessionInfo {
  sessionId: string;
  pid: number;
  trustTier: TrustTier;
  startedAt: number;
}

export type ExitReason = 'done' | 'cancelled' | 'crash' | 'budget' | 'timeout';

export interface ExitInfo {
  sessionId: string;
  code: number | null;
  signal: string | null;
  reason: ExitReason;
}

export interface PingResult {
  pid: number;
  uptimeMs: number;
  version: string;
  sessions: number;
}

export type Unsubscribe = () => void;

/** 控制面(② → ③ · loopback unix-socket · newline-delimited JSON-RPC 2.0)。 */
export interface SidecarControl {
  startSession(req: StartSessionReq): Promise<SessionGrant>;
  cancel(callId: string): Promise<void>;
  shutdownSession(sessionId: string): Promise<void>;
  getProcess(sessionId: string): KernelProcessHandle | null;
  listSessions(): SessionInfo[];
  onExit(cb: (info: ExitInfo) => void): Unsubscribe;
  ping(): Promise<PingResult>;
}

/** JSON-RPC 错误码(规格 §2.1)。 */
export const RpcError = {
  SESSION_NOT_FOUND: -32000,
  AUTH_FAILED: -32001,
  SPAWN_FAILED: -32002,
  INTERNAL: -32603,
  METHOD_NOT_FOUND: -32601,
  PARSE: -32700,
} as const;

/** 默认控制 socket 路径(可被 FORGEAX_AGENT_HOST_SOCK 覆盖)。 */
export const DEFAULT_SOCK_ENV = 'FORGEAX_AGENT_HOST_SOCK';
