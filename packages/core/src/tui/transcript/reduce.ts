/**
 * reduceTranscript —— 纯函数:SessionEntry[](session 真相 = 有序事件日志)→
 * 可渲染的 TranscriptItem[](梁② 的心脏)。
 *
 * 职责(地基方案 §3梁② / §8 P2):
 *   - 配对 tool_call/tool_result(按 toolUseId):running → ok/error;
 *     error 判 result.payload.isError || ok === false(对齐 cli/render.ts)。
 *   - 过滤无视图意义的事件:stream / stage / turn_start / turn_end / turn_aborted。
 *   - 把 done(terminal 非 completed)折成 notice 条目 —— **terminal notice 的唯一产地**。
 *   - user / assistant(text|thinking)原样落条目。
 *
 * 「已中断」只由 done(aborted_*)产出一次:kernel 中断必发 `turn_aborted` + `done(aborted_*)`
 * 一对(见 agent.ts),turn_aborted 仅作内部标记不落条目,否则同一次中断会渲染两条「已中断」;
 * 且 turn_aborted 在 unrecoverable_tool_error 路径配的是 done(error),若它也落条目会与
 * 「异常终止」叠成双条。统一由 done 分支单产,既去重又让文案随 terminal.reason 正确。
 *
 * 关键不变量:
 *   - **不在此解析别名**。tool item 的 name 保留事件里的原名(模型裸名,可能是
 *     别名 `Bash`);渲染时(P4)才经 driver.toolMeta(name).canonical 解析。
 *   - 纯函数,无副作用、无 React。可单测。id 取自条目在 log 里的下标(稳定 key)。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink。
 */
import type {
  SessionEntry,
  TranscriptItem,
  ToolItemStatus,
} from './items';

/** result.payload 判错(对齐 cli/render.ts:isError===true || ok===false)。 */
function isResultError(payload: unknown): boolean {
  const p = payload as { isError?: boolean; ok?: boolean } | undefined;
  return p?.isError === true || p?.ok === false;
}

/** 从 terminal.error 抽一条可读的错误详情(供 error 级 notice 附带显示)。 */
function errorDetail(error: unknown): string {
  if (error == null) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const e = error as { message?: unknown; content?: unknown; error?: unknown };
  if (typeof e.message === 'string') return e.message;
  if (typeof e.content === 'string') return e.content;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** terminal.reason 非 completed → 折成 notice(level + 文案)。error 级附带 terminal.error 详情。 */
function terminalNotice(reason: string, error?: unknown): { level: 'info' | 'warn' | 'error'; text: string } {
  if (reason === 'aborted_streaming' || reason === 'aborted_tools') {
    return { level: 'warn', text: '已中断' };
  }
  if (reason === 'max_turns' || reason === 'blocking_limit' || reason === 'token_budget_continuation') {
    return { level: 'warn', text: `已停止:${reason}` };
  }
  // model_error / prompt_too_long / image_error / unrecoverable_tool_error / 其余 → error。
  //   带上真实错误详情,否则用户只看到「model_error」无从排查。
  const detail = errorDetail(error);
  return { level: 'error', text: detail ? `异常终止:${reason} — ${detail}` : `异常终止:${reason}` };
}

/**
 * 安全提交边界 —— 可无损刷进 `<Static>` 的日志前缀长度(梁② 增量提交)。
 *
 * 不变量:committed 段(`<Static>`)一旦渲染就**不再重绘**,所以只能提交「此后
 * 永不变形」的条目。唯一会变形的是**仍在 running 的工具卡**(tool_call 已到、
 * tool_result 未到,status 仍是 running)。因此安全边界 = 「所有已出现的 tool_call
 * 都已配上 tool_result」的最大前缀长度 —— 即 open(在飞工具计数)归零的最后位置。
 *
 * 性质(只增不退,除非日志缩短):
 *   - append 新条目不会回改更早的「open=0 零点」,故随日志增长单调不减;
 *   - 纯流式 assistant(无工具)期间 open 恒 0 → 边界 = log.length,文本即时落盘;
 *   - 工具批次进行中,边界停在该批次开始前,只把仍在动的尾巴留在 live 动态区。
 *
 * 这把「live 动态区」始终压在一屏内,根治 Ink 动态区超过终端高度时的滚动弹跳。
 */
export function safeFlushBoundary(log: SessionEntry[]): number {
  let open = 0;
  let boundary = 0;
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry && entry.kind === 'event') {
      const t = entry.event.type;
      if (t === 'tool_call') open++;
      else if (t === 'tool_result' && open > 0) open--; // 孤儿 result(无对应 call)不计
    }
    if (open === 0) boundary = i + 1; // 此处所有工具均已配对 → [0, i] 可安全提交
  }
  return boundary;
}

/**
 * 把有序的 SessionEntry 日志折成可渲染条目。
 * 同一 toolUseId 的 tool_call/tool_result 合并为一张工具卡(就地更新 status)。
 */
export function reduceTranscript(log: SessionEntry[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  // toolUseId → out 数组中该工具卡的下标(用于 tool_result 回填)。
  const cardAt = new Map<string, number>();

  log.forEach((entry, i) => {
    const id = i;

    if (entry.kind === 'user') {
      out.push({ kind: 'user', id, text: entry.text });
      return;
    }

    const ev = entry.event;
    switch (ev.type) {
      case 'tool_call': {
        cardAt.set(ev.toolUseId, out.length);
        out.push({
          kind: 'tool',
          id,
          toolUseId: ev.toolUseId,
          name: ev.toolName, // 原名,**不**在此解析别名(P4 渲染时才解)。
          input: ev.input,
          status: 'running',
        });
        return;
      }
      case 'tool_result': {
        const at = cardAt.get(ev.toolUseId);
        if (at == null) return; // 孤儿 result(无对应 call)→ 丢弃。
        const prev = out[at];
        if (!prev || prev.kind !== 'tool') return;
        const error = isResultError(ev.result.payload);
        const status: ToolItemStatus = error ? 'error' : 'ok';
        out[at] = {
          ...prev,
          status,
          result: ev.result.payload,
          isError: error,
        };
        return;
      }
      case 'assistant': {
        out.push({ kind: 'assistant', id, event: ev });
        return;
      }
      case 'done': {
        if (ev.terminal.reason === 'completed' || ev.terminal.reason === 'handed_off') return;
        const n = terminalNotice(ev.terminal.reason, ev.terminal.error);
        out.push({ kind: 'notice', id, level: n.level, text: n.text });
        return;
      }
      // 无视图意义的事件:不落条目。turn_aborted 仅作中断标记,notice 统一由 done 分支产。
      case 'turn_aborted':
      case 'stream':
      case 'stage':
      case 'turn_start':
      case 'turn_end':
        return;
      default:
        return;
    }
  });

  return out;
}
