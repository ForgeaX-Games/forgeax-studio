/**
 * Tool dispatch (Wave3 LOOP, K3/K5) — serial/parallel partition + 权限把闸 + hook block.
 *
 * partitionToolCalls(连续并发安全→并行批,
 * 否则单工具串行) + `toolExecution.ts`(schema parse → 权限 → call → mapResult)。
 * Boundary: 仅 core 相对 import。
 */
import type { AgentTool, ToolContext, PermissionResult } from '../capability/types';
import type { CoreEvent } from '../events/types';
import { hasPermissionsToUseTool, type PermissionMode } from '../permission/engine';
import type { PermissionRuleSet } from '../permission/rules';
import { validateAgainstSchema } from '../capability/validate';

/** 交互式权限回路:当把闸判定 'ask' 时,host 决定放行与否(REPL 提示 / 策略)。
 *  无此回调 → 'ask' 一律 fail-closed(deny)。 */
export type AskUserFn = (perm: PermissionResult, use: ToolUse) => Promise<boolean>;

/** 工具错误五类(移植 agentic_os 03.E.1)。仅供诊断聚合 + LOOP 循环兜底(02.4)判定用,
 *  不进 LLM-visible 文案、不指挥模型恢复(工程只分类,模型自决)。 */
export type ErrorCategory =
  | 'validation' // schema/参数校验失败
  | 'unknown_tool' // 工具名不在工具集
  | 'permission_denied' // 权限/hook 拒绝
  | 'timeout' // 执行超时 / abort
  | 'runtime_error'; // 其余 handler 执行期异常

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolDispatchResult {
  toolUseId: string;
  toolName: string;
  result: CoreEvent;
  isError: boolean;
  /** 错误五类(仅 isError 时设);LOOP 用之做循环兜底,诊断用之聚合。 */
  errorCategory?: ErrorCategory;
  /** JSON-schema 校验失败时的 JSON Path(如 `$.a.b[0]`);仅 errorCategory==='validation' 设,供诊断定位。 */
  validationPath?: string;
  /** 工具产生的附加消息(如 skill inline 展开的 prompt);loop 回灌进上下文。 */
  newMessages?: CoreEvent[];
}

export interface DispatchDeps {
  tools: AgentTool[];
  toolContext: Omit<ToolContext, 'signal'>;
  signal: AbortSignal;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  /** 是否启用 core 内置受保护路径 safetyCheck(默认 false;CLI 独立形态可开,serve/Studio 关)。 */
  enableSafetyCheck?: boolean;
  /** trust channel：agent_command 绕过权限把闸（C5 §5）。 */
  trusted?: boolean;
  /** hook block 检查：返回 true 表示该工具调用被 hook 拦下（K1/K5）。 */
  isBlocked?: (use: ToolUse) => boolean;
  /**
   * PreToolUse hook 权限三态(`permissionDecision`):
   *  - `'allow'` → 旁路权限引擎,直接放行(免审批卡);
   *  - `'deny'`  → 拒绝(通常同时经 isBlocked 拦下,这里冗余兜底);
   *  - `'ask'`   → 强制交互式审批(即便引擎判 allow 也要 askUser 确认);
   *  - `undefined` → 无 hook 意见,走常规权限引擎。
   * 与 isBlocked 共用同一次 PreToolUse 发布(host 缓存回执),不重复触发 hook。
   */
  preToolPermission?: (use: ToolUse) => 'allow' | 'deny' | 'ask' | undefined;
  /** 交互式权限:'ask' 判定时咨询;无则 'ask' fail-closed(deny)。 */
  askUser?: AskUserFn;
}

/** 别名感知匹配:模型发来的名(可能是别名 PascalCase)→ 真工具对象。
 *  `t.name === name || t.aliases?.includes(name)`(与 agent.ts:212 同款)。
 *  P1 export 供 host 层 driver.toolMeta 复用,避免平行实现(SSOT,见地基方案 §3梁①)。 */
export function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name || (t.aliases?.includes(name) ?? false));
}

function errorEvent(
  toolUseId: string,
  message: string,
  errorCategory?: ErrorCategory,
  validationPath?: string,
): CoreEvent {
  return {
    type: 'tool.result',
    payload: {
      toolUseId,
      isError: true,
      message,
      ...(errorCategory ? { errorCategory } : {}),
      ...(validationPath ? { validationPath } : {}),
    },
    ts: 0,
  };
}

/** 把 catch 到的异常归类(就近赋类,移植 03.E.1):abort/超时 → timeout;zod-like → validation;
 *  其余 → runtime_error。signal.aborted 优先判 timeout(中断当作可重试类)。 */
function classifyThrown(e: unknown, signal: AbortSignal): ErrorCategory {
  if (signal.aborted) return 'timeout';
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out|timeout|abort/i.test(msg)) return 'timeout';
  // zod / JSON-schema 校验错通常带 issues 数组。
  if (e && typeof e === 'object' && Array.isArray((e as { issues?: unknown }).issues)) return 'validation';
  return 'runtime_error';
}

/** 解析输入：zod inputSchema 优先，否则原样（MCP/JSON Schema 工具）。 */
function parseInput(tool: AgentTool, raw: unknown): unknown {
  if (tool.inputSchema?.parse) {
    try {
      return tool.inputSchema.parse(raw);
    } catch {
      return raw; // 解析失败交给 validateInput / call 处理
    }
  }
  return raw;
}

async function runOne(use: ToolUse, deps: DispatchDeps): Promise<ToolDispatchResult> {
  const tool = findTool(deps.tools, use.name);
  if (!tool) {
    return { toolUseId: use.id, toolName: use.name, result: errorEvent(use.id, `unknown tool: ${use.name}`, 'unknown_tool'), isError: true, errorCategory: 'unknown_tool' };
  }
  if (deps.isBlocked?.(use)) {
    return { toolUseId: use.id, toolName: use.name, result: errorEvent(use.id, `blocked by hook`, 'permission_denied'), isError: true, errorCategory: 'permission_denied' };
  }

  const ctx: ToolContext = { ...deps.toolContext, signal: deps.signal, toolUseId: use.id };
  const parsed = parseInput(tool, use.input);

  // JSON-schema 校验(移植 agentic_os 03.E.2):仅「有 inputJSONSchema 而无 zod parser」的
  //   passthrough 工具(MCP/外部声明式)在把闸前走一遍 schema walker;空/无约束 schema →
  //   permissive ok → 零回归(zod-validated / schema-less 工具行为逐字不变)。失配 → validation 错。
  if (!tool.inputSchema?.parse && tool.inputJSONSchema) {
    const v = validateAgainstSchema(parsed, tool.inputJSONSchema);
    if (!v.ok) {
      return {
        toolUseId: use.id,
        toolName: use.name,
        result: errorEvent(use.id, `input validation failed at ${v.path}: ${v.message}`, 'validation', v.path),
        isError: true,
        errorCategory: 'validation',
        validationPath: v.path,
      };
    }
  }

  // PreToolUse hook 权限三态(permissionDecision):在引擎把闸之前裁决。
  const hookPerm = deps.preToolPermission?.(use);
  if (hookPerm === 'deny') {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: errorEvent(use.id, `denied by hook (permissionDecision)`, 'permission_denied'),
      isError: true,
      errorCategory: 'permission_denied',
    };
  }

  // 权限把闸（trust channel 绕过；K5）。hook 'allow' 亦旁路引擎(显式放行,免审批卡)。
  let callInput: unknown = parsed;
  if (!deps.trusted && hookPerm !== 'allow') {
    const perm = await hasPermissionsToUseTool(tool, parsed, ctx, deps.rules, {
      mode: deps.mode,
      enableSafetyCheck: deps.enableSafetyCheck,
    });
    // hook 'ask' → 强制交互式审批(即便引擎判 allow);否则按引擎行为。
    const mustAsk = hookPerm === 'ask';
    let granted = !mustAsk && perm.behavior === 'allow';
    // 'ask'(引擎判或 hook 强制)→ 交互式裁决(有回调才可能放行;无 → fail-closed deny)。'deny' 永不咨询。
    if (!granted && perm.behavior !== 'deny' && (perm.behavior === 'ask' || mustAsk) && deps.askUser) {
      try {
        granted = await deps.askUser(perm, use);
      } catch {
        granted = false; // 咨询抛错 → fail-closed
      }
    }
    if (!granted) {
      return {
        toolUseId: use.id,
        toolName: use.name,
        result: errorEvent(use.id, perm.message ?? `permission ${perm.behavior} for ${use.name}`, 'permission_denied'),
        isError: true,
        errorCategory: 'permission_denied',
      };
    }
    callInput = perm.updatedInput ?? parsed;
  }

  try {
    const out = await tool.call(callInput, ctx);
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: tool.mapResult(out.data, use.id),
      isError: false,
      newMessages: out.newMessages,
    };
  } catch (e) {
    const category = classifyThrown(e, deps.signal);
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: errorEvent(use.id, e instanceof Error ? e.message : String(e), category),
      isError: true,
      errorCategory: category,
    };
  }
}

/** 把连续的并发安全工具分到同一并行批；非并发安全工具自成串行单元
 *  (partitionToolCalls)。isConcurrencySafe 抛错 → 当作不安全 (fail-closed)。 */
export function partition(uses: ToolUse[], tools: AgentTool[]): ToolUse[][] {
  const batches: ToolUse[][] = [];
  let cur: ToolUse[] = [];
  for (const use of uses) {
    const tool = findTool(tools, use.name);
    let safe = false;
    if (tool) {
      try {
        safe = tool.isConcurrencySafe(parseInput(tool, use.input));
      } catch {
        safe = false;
      }
    }
    if (safe) {
      cur.push(use);
    } else {
      if (cur.length) batches.push(cur), (cur = []);
      batches.push([use]);
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 按批 dispatch：并发安全批并行,其余串行。保持工具调用的原始顺序产出结果。 */
export async function dispatchTools(uses: ToolUse[], deps: DispatchDeps): Promise<ToolDispatchResult[]> {
  const out: ToolDispatchResult[] = [];
  for (const batch of partition(uses, deps.tools)) {
    if (deps.signal.aborted) break;
    if (batch.length === 1) {
      out.push(await runOne(batch[0], deps));
    } else {
      const results = await Promise.all(batch.map((u) => runOne(u, deps)));
      out.push(...results);
    }
  }
  return out;
}
