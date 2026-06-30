/**
 * Host(规格 §2,T3.3)—— session 表 + 进程监督(spawn / cancel / shutdown / 整组 reap / onExit)。
 * 不懂 agent/编排业务,只管进程。被 main.ts 经 RPC 驱动;onExit 经连接通知 server。
 */
import { createKernelProcess, type KernelProcess } from './kernel-process';
import { issueScoped, revokeScoped, type Provider, type ScopedBudget } from './cred-vault';
import { maybeSandbox, SANDBOX_ENV } from './sandbox';
import { recordOrphan, forgetOrphan } from './orphan-registry';
import {
  RpcError,
  type ExitInfo,
  type ExitReason,
  type KernelProcessHandle,
  type PingResult,
  type SessionGrant,
  type SessionInfo,
  type StartSessionReq,
  type Unsubscribe,
} from './types';

const VERSION = '0.1.0';

interface RpcThrow { code: number; message: string }
const rpcErr = (code: number, message: string): RpcThrow => ({ code, message });

interface SessionEntry {
  proc: KernelProcess;
  handle: KernelProcessHandle;
  callId: string;
  scopedToken?: string;
}

/** imported 未给预算时的默认上限(防失控开销/滥用;S3 信任层)。 */
const IMPORTED_DEFAULT_MAX_TOKENS = 200_000;

function providerOf(kind: string): Provider {
  return kind === 'codex' ? 'openai' : 'anthropic';
}

/** sidecar 权威 env:在 spec.env 上注入 scoped 凭据(覆盖/剔除真 key)。 */
function buildKernelEnv(
  base: Record<string, string> | undefined,
  scoped: { provider: Provider; token: string; baseUrl: string } | null,
): Record<string, string> {
  const out = { ...(base ?? {}) };
  // 双保险:删两家真 model key(内核侧也已剔除,这里兜底)。
  delete out.ANTHROPIC_API_KEY;
  delete out.OPENAI_API_KEY;
  if (scoped) {
    if (scoped.provider === 'anthropic') { out.ANTHROPIC_API_KEY = scoped.token; out.ANTHROPIC_BASE_URL = scoped.baseUrl; }
    else { out.OPENAI_API_KEY = scoped.token; out.OPENAI_BASE_URL = scoped.baseUrl; }
  }
  return out;
}

export interface HostOpts {
  /** 孤儿登记目录(硬杀恢复)。缺省 → 关闭登记(测试/嵌入场景)。 */
  orphanDir?: string;
}

export class Host {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly callIndex = new Map<string, string>(); // callId → sessionId
  private readonly pendingReason = new Map<string, ExitReason>(); // 我方发起的终止意图
  private readonly exitListeners = new Set<(info: ExitInfo) => void>();
  private readonly dataListeners = new Set<(sessionId: string, stream: 'stdout' | 'stderr', chunk: string) => void>();
  private readonly startedAt = Date.now();
  private readonly orphanDir?: string;

  constructor(opts: HostOpts = {}) {
    if (opts.orphanDir) this.orphanDir = opts.orphanDir;
  }

  async startSession(req: StartSessionReq): Promise<SessionGrant> {
    if (!req.sessionId) throw rpcErr(RpcError.INTERNAL, 'startSession: missing sessionId');
    const k = req.kernel;

    // 凭据保险箱(S2):sidecar-managed → 发 scoped token(真 key 只在 sidecar)。
    // imported 未给预算 → 套默认上限(S3 信任层)。
    let scopedToken: string | undefined;
    let scoped: { provider: Provider; token: string; baseUrl: string } | null = null;
    if (k.credential === 'sidecar-managed') {
      const provider = providerOf(k.kind);
      const budget: ScopedBudget = {
        ...(req.budget?.maxTokens != null ? { maxTokens: req.budget.maxTokens } : {}),
        ...(req.budget?.maxBudgetUsd != null ? { maxBudgetUsd: req.budget.maxBudgetUsd } : {}),
      };
      if (req.trustTier === 'imported' && budget.maxTokens == null) budget.maxTokens = IMPORTED_DEFAULT_MAX_TOKENS;
      const issued = await issueScoped(provider, req.sessionId, budget);
      if (issued) { scopedToken = issued.token; scoped = { provider, token: issued.token, baseUrl: issued.baseUrl }; }
    }
    const childEnv = buildKernelEnv(k.env, scoped);

    // 信任沙箱(S3):imported(macOS)→ sandbox-exec 网络隔离(拦外网,仅放 loopback→vault)。
    // own/forge / 非 darwin / FORGEAX_NO_SANDBOX=1 → passthrough。进程组/reap 不受影响。
    const sb = maybeSandbox(k.cmd, k.args ?? [], { trustTier: req.trustTier });
    if (sb.sandboxed) Object.assign(childEnv, SANDBOX_ENV); // 关非必要外网,只留模型(loopback vault)
    const proc = createKernelProcess({
      command: sb.command,
      args: sb.args,
      cwd: k.cwd ?? process.cwd(),
      env: childEnv,
    });
    if (proc.pid <= 0) {
      if (scopedToken) revokeScoped(scopedToken);
      throw rpcErr(RpcError.SPAWN_FAILED, `spawn failed for ${k.cmd}`);
    }
    const handle: KernelProcessHandle = {
      sessionId: req.sessionId,
      pid: proc.pid,
      pgid: proc.pgid,
      startedAt: Date.now(),
      trustTier: req.trustTier,
    };
    const callId = req.callId ?? req.sessionId;
    this.sessions.set(req.sessionId, { proc, handle, callId, ...(scopedToken ? { scopedToken } : {}) });
    this.callIndex.set(callId, req.sessionId);
    // 硬杀恢复:登记进程组,sidecar 若被 SIGKILL,下次 boot sweep 会收割此组。
    if (this.orphanDir) recordOrphan(this.orphanDir, proc.pgid, req.sessionId);

    // 把内核 stdout/stderr 转发回控制连接(S1b 事件面经 sidecar 转发)。
    proc.onData((chunk, stream) => this.emitData(req.sessionId, stream, chunk.toString('utf8')));

    proc.onExit((e) => {
      if (scopedToken) revokeScoped(scopedToken); // 会话退出 → 失效 scoped token
      // 整组兜底收割:leader 退出(尤其**崩溃/被外部 SIGKILL**,我们没主动 terminate)时,
      // 它派生的工具子进程(Bash/后台逃兵)可能成孤儿仍在组里存活 → 这里对进程组补一刀
      // SIGKILL。group 已空 → ESRCH 被吞,无害;有幸存者 → 一并收割,杜绝孤儿泄漏。
      try { proc.kill('SIGKILL'); } catch { /* group already gone */ }
      if (this.orphanDir) forgetOrphan(this.orphanDir, proc.pgid); // 优雅/正常退出 → 撤登记
      const intended = this.pendingReason.get(req.sessionId);
      const reason: ExitReason = intended ?? (e.error ? 'crash' : e.exitCode === 0 ? 'done' : 'crash');
      this.cleanup(req.sessionId);
      this.emitExit({ sessionId: req.sessionId, code: e.exitCode, signal: e.signal, reason });
    });

    // serve 模式:原样回显 adapter 提供的 endpoint(Host 不连接/不解析,仅监督进程)。
    return { sessionId: req.sessionId, pid: proc.pid, pgid: proc.pgid, ...(scoped ? { scopedToken: scoped.token, baseUrl: scoped.baseUrl } : {}), ...(req.endpoint ? { endpoint: req.endpoint } : {}) };
  }

  /** 取消该 callId 对应进程组(SIGTERM→宽限→SIGKILL),发 ExitInfo{cancelled}。 */
  async cancel(callId: string): Promise<void> {
    const sid = this.callIndex.get(callId) ?? (this.sessions.has(callId) ? callId : undefined);
    if (!sid) throw rpcErr(RpcError.SESSION_NOT_FOUND, `no session for callId ${callId}`);
    const s = this.sessions.get(sid);
    if (!s) throw rpcErr(RpcError.SESSION_NOT_FOUND, `session ${sid} gone`);
    this.pendingReason.set(sid, 'cancelled');
    await s.proc.terminate(2000);
  }

  /** 结束会话:整组 reap + 清理(幂等)。 */
  async shutdownSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return; // 幂等:未知 sid 不抛
    this.pendingReason.set(sessionId, 'done');
    await s.proc.terminate(2000);
  }

  getProcess(sessionId: string): KernelProcessHandle | null {
    return this.sessions.get(sessionId)?.handle ?? null;
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.handle.sessionId,
      pid: s.handle.pid,
      trustTier: s.handle.trustTier,
      startedAt: s.handle.startedAt,
    }));
  }

  onExit(cb: (info: ExitInfo) => void): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /** 订阅所有 session 的 stdout/stderr(client 按 sessionId 过滤)。 */
  onData(cb: (sessionId: string, stream: 'stdout' | 'stderr', chunk: string) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  ping(): PingResult {
    return { pid: process.pid, uptimeMs: Date.now() - this.startedAt, version: VERSION, sessions: this.sessions.size };
  }

  /** 关停所有 session(进程退出时清理)。 */
  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sid) => this.shutdownSession(sid)));
  }

  private cleanup(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) this.callIndex.delete(s.callId);
    this.sessions.delete(sessionId);
    this.pendingReason.delete(sessionId);
  }

  private emitExit(info: ExitInfo): void {
    for (const cb of this.exitListeners) { try { cb(info); } catch { /* ignore */ } }
  }

  private emitData(sessionId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    for (const cb of this.dataListeners) { try { cb(sessionId, stream, chunk); } catch { /* ignore */ } }
  }
}
