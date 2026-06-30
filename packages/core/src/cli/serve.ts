/**
 * forgeax-core `--serve` —— 把 forgeax-core 内核以**子进程 + 双向 JSON-RPC**形态暴露,
 * 供 sidecar(agent-host)托管、server 侧 adapter 直连(R3 内核归一)。
 *
 * 本进程在 per-session unix-sock 上起 RPC server,**自家代码原生
 * 实现协议层**(比 headless CLI 的 stdout-JSONL 更高契合:全双工、反向 host-tool/取消)。
 *
 * 控制面方法(adapter → serve):
 *   - `runTurn(wireReq)`     跑一轮;KernelEvent 经 `event` 通知流回;请求 resolve = 轮终。
 *   - `cancel(callId)` / `interrupt(callId)`  取消在飞轮(abort signal + facade handle)。
 *   - `setModel` / `setPermissionMode`        透传 facade handle(headless 上限同 facade)。
 *   - `ping`                                  健康探测。
 * 反向(serve → adapter):
 *   - `hostTool({name,args,sid})` 请求       **所有工具执行回调宿主**——宿主复跑 checkKernelTool
 *     (信任边界钉在 host;serve 不持危险工具本地实现)。详见评审稿 §3.1。
 *
 * 凭据:provider 从 **env 的 scoped token** 造(真 key 只在 sidecar cred-vault);serve 进程
 * 不持真 upstream key。
 *
 * Boundary: 仅 core 相对 + node:。
 */
import { existsSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:net';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';
import { ForgeaxCoreKernel, type ExecuteToolFn } from '../kernel-facade/forgeax-core-kernel';
import { InProcessScheduler } from '../inject/in-process-scheduler';
import { InProcessTeammateExecutor } from '../inject/in-process-teammate-executor';
import { EventBus } from '../events/event-bus';
import { buildChildSpawnFn } from './peer';
import { listenRpc, type RpcConnection } from './rpc';
import { resolveProvider } from '../provider/register';
import type { LLMProvider, ProviderRequest } from '../provider/types';
import type { AgentTool } from '../capability/types';
import { builtinToolsPack } from '../capability/builtin-tools/index';
import { notebookToolsPack } from '../capability/builtin-tools/notebook-tools';
import { NodeSandboxFs, NodeTerminal } from './io';
import { makeNodeObservability } from './observability';
import type { TelemetryRecord } from '@forgeax/types';

/** runTurn 的线上入参 = TurnRequest 的**可序列化子集**(去掉 requestPermission/hooks 等函数)。 */
type WireTurnRequest = Omit<TurnRequest, 'requestPermission' | 'hooks'>;

/** 扩展思考配置:默认 `adaptive`(对齐重构前的 working 配置——旧请求即 thinking:adaptive,
 *  且能持续吐 thinking 增量,避免长轮在首 token 前长时间静默)。重构曾整段丢了这条接线。
 *  env `FORGEAX_THINKING`:`off|0|disabled|none` → 关;`enabled[:budget]` → 固定预算;
 *  其余(含缺省)→ `adaptive`。 */
function resolveThinkingConfig(): ProviderRequest['thinking'] | undefined {
  const v = (process.env.FORGEAX_THINKING ?? 'adaptive').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'disabled' || v === 'none') return undefined;
  if (v.startsWith('enabled')) {
    const b = Number(v.split(':')[1]);
    return { type: 'enabled', budgetTokens: Number.isFinite(b) && b > 0 ? b : 8192 };
  }
  // display:'summarized' → 流式吐 thinking 增量(UI 可见思考),对齐旧 working 请求。
  return { type: 'adaptive', display: 'summarized' };
}

function buildProvider(model: string): LLMProvider {
  // 与 forgeax-core-adapter 同源:从 env 造 anthropic provider(scoped token 经 env 注入)。
  void model;
  return resolveProvider('anthropic-messages', {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    headers: { 'anthropic-version': '2023-06-01' },
  });
}

/** 起 serve:在 sockPath 上 listen,每条连接绑定一个 forgeax-core facade。返回 net.Server。 */
export async function startServe(sockPath: string): Promise<Server> {
  // 清理陈旧 sock(同款 listen-before-use)。
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* ignore */ }
  }

  const peerAgents = process.env.FORGEAX_PEER_AGENTS !== '0';

  // B 路径(own 安全工具本地直跑):core builtin 实现表 + 本地 IO(NodeSandboxFs/Terminal)。
  //   host 经 `ToolSpec.delivery==='local'` 决定哪些工具走本地;facade wrapTools 按名取本表实现,
  //   在本进程内直跑(满速 + crash 隔离),不回宿主。注入全量 builtin 无害——未标 local 的仍走
  //   host 桥。serve 是 HOST 层,引 capability/io 合法(机制层不碰 node:fs 的约束不破)。
  const localToolImpls: AgentTool[] = [
    ...(builtinToolsPack().tools ?? []),
    ...(notebookToolsPack().tools ?? []),
  ];
  const localToolContext: Record<string, unknown> = {
    sandboxFs: new NodeSandboxFs(),
    terminal: new NodeTerminal(),
    cwd: process.cwd(),
  };

  // 扩展思考:默认 adaptive,对齐重构前 working 配置(旧 working 请求即 thinking:adaptive)。
  const thinkingCfg = resolveThinkingConfig();

  const server = await listenRpc(sockPath, (conn: RpcConnection, sock) => {
    // 反向 host-tool 桥:serve 的所有工具执行都回调宿主(adapter 复跑 checkKernelTool)。
    const executeTool: ExecuteToolFn = async (name, args, sid, agentId) =>
      conn.request('hostTool', { name, args, sid, agentId });

    // ★ 可观测性(v3/B 档):exporter `send` → 独立 `telemetry` RPC 通知回流 server(与 turn 解耦,
    //   不开自己的 WS、不落盘——落盘+广播在 host/server 端)。FORGEAX_OTEL=off 时 makeNodeObservability
    //   内部不挂 exporting processor(span 不出),logger 仍出 LogRecord;通知本身 best-effort 吞错。
    const observability = makeNodeObservability({
      send: (records: TelemetryRecord[]) => {
        try {
          conn.notify('telemetry', { records });
        } catch {
          /* 诊断绝不影响主流程(§9) */
        }
      },
    });
    // 连接关闭:刷尽残留批 + 关 OTLP exporter(否则丢最后一批 / 泄漏 exporter)。
    sock.on('close', () => void observability.shutdown());

    // ★ M2 team 接线(plan-strategy D-2 / m2-t6):per-connection 一个 team —— 共享 bus +
    //   InProcessTeammateExecutor(进程内 mailbox 两平面)。子 agent 经 buildChildSpawnFn 登记
    //   可寻址、拿 inbox 闭包(数据面进 LLM / 控制面进 handler,闭包在 host 侧 peer.ts 构造,
    //   不改 agent.ts)。peerAgents 关时不建(退化为单 agent + 父子树,§9)。
    const teamExecutor = peerAgents ? new InProcessTeammateExecutor() : undefined;
    const teamBus = peerAgents ? new EventBus() : undefined;

    const kernel = new ForgeaxCoreKernel({
      provider: buildProvider('claude-opus-4-8'),
      executeTool,
      observability,
      // B 路径:本地工具实现表 + 本地 IO。delivery==='local' 的工具经此本进程直跑(不回宿主);
      //   其余仍走上面的 executeTool 桥(host 把闸)。
      toolContext: localToolContext,
      localToolImpls,
      // 扩展思考(重构丢了这条接线 → 旧版有 thinking 显示、新版没有)。默认 adaptive。
      ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
      // 信任边界钉在 host(评审稿 §3.1):serve 的所有工具都回调宿主,宿主 host-tool-bridge
      //   复跑 checkKernelTool **并在 `ask` 档弹权限卡**(own 危险操作 / imported)。因此 in-core
      //   的交互式 'ask' 一律 **defer 给 host**——askUser 恒 allow,让工具落到 host 闸由用户裁决;
      //   in-core 的 **deny**(规则 / plan 只读)仍照常在核内强制(askUser 只拦 'ask',不影响 deny)。
      //   若不传 askUser,in-core 对 'ask' 会 fail-closed deny(agent.ts:131),Bash/写等永远到不了
      //   host 卡 —— 故这里必须显式 defer。
      askUser: async () => true,
      // peer 多 agent:每轮工厂用本轮 provider/model/host 工具建调度器(子 agent 同源回调宿主)。
      //   M2:把 team 接线(共享 bus + executor)透进 spawn 工厂,子 agent 走共享 bus + mailbox
      //   inbox 闭包(可寻址 + 收 SendMessage 真投递);scheduler 也接同一 bus 供 sleep{event}。
      ...(peerAgents
        ? {
            handoff: ({ provider, model, tools }) =>
              new InProcessScheduler({
                spawnFn: buildChildSpawnFn(provider, tools, model, 20, {
                  executor: teamExecutor!,
                  bus: teamBus!,
                }),
                bus: teamBus,
              }),
          }
        : {}),
    });

    /** callId → 在飞轮的 AbortController(供 cancel/interrupt)。 */
    const inflight = new Map<string, AbortController>();

    conn.setRequestHandler(async (method, params) => {
      switch (method) {
        case 'ping':
          return { ok: true };
        case 'runTurn': {
          const req = params as WireTurnRequest;
          const callId = req.callId ?? req.session?.threadId ?? 'turn';
          const ac = new AbortController();
          inflight.set(callId, ac);
          try {
            for await (const ev of kernel.runTurn(req as TurnRequest, ac.signal)) {
              conn.notify('event', { callId, event: ev as KernelEvent });
            }
            return { ok: true };
          } finally {
            inflight.delete(callId);
          }
        }
        case 'cancel':
        case 'interrupt': {
          const { callId } = (params as { callId: string }) ?? { callId: '' };
          inflight.get(callId)?.abort(method);
          await kernel.openHandle(callId)[method === 'cancel' ? 'cancel' : 'interrupt']();
          return { ok: true };
        }
        case 'setModel': {
          const { callId, model } = params as { callId: string; model: string };
          await kernel.openHandle(callId).setModel(model);
          return { ok: true };
        }
        case 'setPermissionMode': {
          const { callId, mode } = params as { callId: string; mode: 'gated' | 'autoEdits' | 'planning' | 'unrestricted' };
          await kernel.openHandle(callId).setPermissionMode(mode);
          return { ok: true };
        }
        default:
          throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
      }
    });
  });

  // ready 行(纯日志;adapter 靠连接探测就绪,不解析 stdout)。
  process.stdout.write(`${JSON.stringify({ ready: true, sock: sockPath, pid: process.pid })}\n`);

  const shutdown = (): void => {
    try { server.close(); } catch { /* ignore */ }
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
