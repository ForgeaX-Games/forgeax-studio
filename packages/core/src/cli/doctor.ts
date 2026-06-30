/**
 * 环境健康自检(A 层 · 024 /doctor)—— `runDoctor(opts)` 逐项**探测**并产出
 * ✅/❌ 列表 + 可读修复提示,供 TUI `/doctor` 命令 + Studio `doctor` RPC 共用。
 *
 * 与 `/status`(纯聚合,见 `status-aggregate.ts`)的根本区别:**doctor 做真探测**
 * —— 发最小 provider 请求验连通、逐 MCP server 试连、(可选)查 LSP 可执行在不在。
 * 这是本任务的**新逻辑**(任务 024「runDoctor 的连通探测是新逻辑」)。
 *
 * 设计要点:
 *   - **每项独立 fail-soft**:一项探测抛错只让该项 ❌,不连累其它项(逐项 try/catch)。
 *   - **provider 连通**:发一条极小 stream 请求(maxOutputTokens 极小),只要能拿到
 *     首个事件(message_start / 任意事件)即判连通;抛错则 ❌ 并把错误信息折成提示
 *     (401/未授权 → 提示查 key;网络错 → 提示查 baseUrl/网络)。**不消费完整流**
 *     (探测到第一个事件即 break,省 token)。
 *   - **MCP 可达**:直接复用 016 `inspectMcpServers`(同一连接链路,避免双份语义),
 *     把每个 server 的连接态映射成一项;无 MCP 配置 → 跳过(不报错)。
 *   - **可选 LSP**:host 注入「命令是否在 PATH」探针(`probeCommand`),core 不直接碰
 *     child_process(boundary)。未注入 → 整组 LSP 跳过(003 LSP 未落地时优雅缺省)。
 *   - **注入接缝**:所有外部依赖(provider / mcp 接缝 / probeCommand / now)都从 `opts`
 *     入参拿,本文件不读 env、不连网全局,便于单测(注入假 provider / 假 fetch)。
 *
 * Boundary: 仅 import core-local。真 IO(child_process / fetch / spawn)由 host 经
 *   入参注入。
 */
import type { LLMProvider } from '../provider/types';
import { inspectMcpServers, type InspectMcpOptions } from '../capability/mcp/inspect';
import type { LspServerDef } from '../capability/lsp/servers';

// ─── 对外形状 ──────────────────────────────────────────────────────────────────

/** 一项探测的判定。 */
export type DoctorCheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

/** 探测分组(便于渲染层归类)。 */
export type DoctorCheckCategory = 'provider' | 'mcp' | 'lsp';

/** 单项探测结果(渲染层逐条画 ✅/❌/⚠️/➖ + label + 提示)。 */
export interface DoctorCheck {
  /** 分组。 */
  category: DoctorCheckCategory;
  /** 项标识(稳定,便于测试断言;如 'provider' / 'mcp:srv' / 'lsp:typescript-language-server')。 */
  id: string;
  /** 人读标题。 */
  label: string;
  /** 判定。 */
  status: DoctorCheckStatus;
  /** 详情 / 修复提示(fail/warn 必给可读建议;ok 可空)。 */
  detail?: string;
}

/** runDoctor 完整结果。 */
export interface DoctorReport {
  /** 逐项探测结果(顺序:provider → mcp → lsp)。 */
  checks: DoctorCheck[];
  /** 是否全部健康(无 fail;warn 不算 fail)。 */
  healthy: boolean;
}

/** LSP 探测的注入接缝(003 LSP 落地后接,否则不传 → 跳过)。 */
export interface DoctorLspProbe {
  /** 要检查的 server 定义清单(去重后的 command);一般取 DEFAULT_SERVERS 的值。 */
  servers: LspServerDef[];
  /** host 注入:返回该命令是否在 PATH(true=可执行存在)。core 不碰 child_process。 */
  probeCommand: (command: string) => boolean | Promise<boolean>;
}

/** `runDoctor` 入参(全部可选;缺哪组跳哪组)。 */
export interface DoctorOptions {
  /** provider 连通探测:provider 实例 + 探测用 model。缺则跳过该项。 */
  provider?: { provider: LLMProvider; model: string };
  /** MCP 可达探测:直接转交 016 inspectMcpServers。缺则跳过。 */
  mcp?: InspectMcpOptions;
  /** 可选 LSP 探测(003 落地后接)。缺则跳过。 */
  lsp?: DoctorLspProbe;
}

// ─── provider 连通探测 ──────────────────────────────────────────────────────────

/** 把 provider 错误信息折成可读修复提示。 */
function providerHint(message: string): string {
  if (/\b401\b|unauthor|invalid.*key|api[_ -]?key/i.test(message)) {
    return `provider 鉴权失败:检查 ANTHROPIC_API_KEY 是否正确/未过期(${message})`;
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return `provider 拒绝访问(403):检查 key 权限或 baseUrl(${message})`;
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return `provider 限流(429):稍后重试或检查配额(${message})`;
  }
  if (/ENOTFOUND|ECONN|fetch failed|network|timeout/i.test(message)) {
    return `provider 网络不可达:检查 ANTHROPIC_BASE_URL / 代理 / 网络(${message})`;
  }
  return `provider 连通失败:${message}`;
}

/**
 * 探测 provider 连通:发一条极小请求,拿到第一个流事件即判连通(不消费完整流)。
 *
 * 只要 `stream()` 能产出 ≥1 个事件即视为连上(握手 + 鉴权通过)。任何抛错 →
 * fail + 折算修复提示。探测请求刻意极小(空 tools、单条 user、maxOutputTokens=1)。
 */
async function probeProvider(p: { provider: LLMProvider; model: string }): Promise<DoctorCheck> {
  const id = 'provider';
  const label = `Provider 连通(${p.model})`;
  // abort 接缝:拿到第一个事件即 abort,真正中断底层请求(省 token)。
  const ac = new AbortController();
  try {
    const iter = p.provider.stream(
      {
        model: p.model,
        system: [],
        tools: [],
        messages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 1,
        querySource: 'doctor',
      },
      { signal: ac.signal },
    );
    // 拿到第一个事件即证明连通(握手 + 鉴权通过),abort + 收手。
    let gotEvent = false;
    for await (const _ev of iter) {
      gotEvent = true;
      ac.abort();
      break;
    }
    if (!gotEvent) {
      return { category: 'provider', id, label, status: 'fail', detail: 'provider 未产出任何事件(可能是空响应或被中断)' };
    }
    return { category: 'provider', id, label, status: 'ok', detail: '可达' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { category: 'provider', id, label, status: 'fail', detail: providerHint(message) };
  }
}

// ─── MCP 可达探测 ───────────────────────────────────────────────────────────────

/** 把 016 巡检的每个 server 折成一项 doctor check。 */
async function probeMcp(opts: InspectMcpOptions): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let result;
  try {
    result = await inspectMcpServers(opts);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return [{ category: 'mcp', id: 'mcp', label: 'MCP 配置', status: 'fail', detail: `MCP 巡检失败:${message}` }];
  }
  // 配置解析期错误各报一条 warn(单条坏不连累其它)。
  for (const err of result.configErrors) {
    out.push({ category: 'mcp', id: 'mcp:config', label: 'MCP 配置解析', status: 'warn', detail: err });
  }
  for (const s of result.servers) {
    const id = `mcp:${s.name}`;
    const label = `MCP server「${s.name}」(${s.type})`;
    if (s.status === 'connected') {
      out.push({ category: 'mcp', id, label, status: 'ok', detail: `已连,暴露 ${s.toolCount} 个工具${s.deferred ? '(延迟注入)' : ''}` });
    } else if (s.status === 'auth-pending') {
      out.push({ category: 'mcp', id, label, status: 'warn', detail: `需认证:触发该 server 的 OAuth/登录后重试(${s.error ?? '401'})` });
    } else {
      out.push({ category: 'mcp', id, label, status: 'fail', detail: `连接失败:${s.error ?? '未知错误'}(检查命令/URL/网络)` });
    }
  }
  return out;
}

// ─── LSP 探测(可选)──────────────────────────────────────────────────────────────

/** 探测各 LSP server 命令是否在 PATH(去重 command)。 */
async function probeLsp(lsp: DoctorLspProbe): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const seen = new Set<string>();
  for (const def of lsp.servers) {
    if (seen.has(def.command)) continue;
    seen.add(def.command);
    const id = `lsp:${def.command}`;
    const label = `Language server「${def.command}」`;
    try {
      const present = await lsp.probeCommand(def.command);
      if (present) {
        out.push({ category: 'lsp', id, label, status: 'ok', detail: '可执行已就绪' });
      } else {
        out.push({ category: 'lsp', id, label, status: 'warn', detail: `未在 PATH 找到 ${def.command};需要 LSP 能力时请安装它` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.push({ category: 'lsp', id, label, status: 'warn', detail: `探测失败:${message}` });
    }
  }
  return out;
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 跑环境健康自检,逐项探测 provider/MCP/LSP 连通性,返回 ✅/❌ 列表 + 修复提示。
 *
 * 每组独立 fail-soft:某组未注入 → 跳过(不产 check);某项探测抛错 → 该项 fail/warn,
 * 不连累其它。`healthy` = 无任何 fail(warn 不算 fail,如 LSP 缺失只是提醒)。
 *
 * @param opts 各组探测的注入接缝(见 {@link DoctorOptions})。
 * @returns 逐项探测结果 + 全局健康判定(见 {@link DoctorReport})。
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  if (opts.provider) {
    checks.push(await probeProvider(opts.provider));
  }
  if (opts.mcp) {
    checks.push(...(await probeMcp(opts.mcp)));
  }
  if (opts.lsp) {
    checks.push(...(await probeLsp(opts.lsp)));
  }

  const healthy = checks.every((c) => c.status !== 'fail');
  return { checks, healthy };
}
