/**
 * walEventsToUiMessages —— 纯函数:会话 WAL 的原始事件流(CoreEvent[])→ 可渲染的
 * UiMessage[](供 /resume 把历史会话回灌进当前 transcript)。
 *
 * 这是 reduce.ts 的「上游补片」:live 路径里 driver 把 agent.run 吐的 AgentEvent 直接
 * push 进 session;resume 路径没有 live AgentEvent 流,只有落盘的 CoreEvent WAL。本函数
 * 把 WAL 事件**逆映射**回与 live 同构的 AgentEvent,包成 UiMessage,使 reduceTranscript
 * 渲染出与当时一模一样的 transcript(对齐 cc:恢复 = 用全量 messages 重建 REPL)。
 *
 * 映射(只取有视图意义的 4 类;其余 turn 生命周期 / stop / session / stage 等跳过):
 *   - user_prompt.submit → { kind:'user', text: payload.prompt }
 *   - assistant.message  → { kind:'agent', event:{ type:'assistant', message: <该 CoreEvent> } }
 *   - tool.requested     → { kind:'agent', event:{ type:'tool_call', toolName, toolUseId, input } }
 *   - tool.result        → { kind:'agent', event:{ type:'tool_result', toolUseId, result: <该 CoreEvent> } }
 *
 * 形状对齐:AgentEvent 联合(agent/types.ts)+ events 目录 payload(events.ts)+
 *   history/llm-fold-adapter.ts(同一组事件的 LLM 侧投影)。tool_result 的 `result` 持有
 *   整条 CoreEvent,reduceTranscript 读 `result.payload`(含 isError)判错,与 live 一致。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import,无 react/ink。纯函数,可单测。
 */
import type { CoreEvent } from '../../events/types';
import type { AgentEvent, UiMessage } from '../contracts';

/** loop 自吐的 assistant 会话事件类型(非 CoreEventType 成员;与 llm-fold-adapter 同源)。 */
const ASSISTANT_MESSAGE = 'assistant.message';
const USER_PROMPT = 'user_prompt.submit';
const TOOL_REQUESTED = 'tool.requested';
const TOOL_RESULT = 'tool.result';

export function walEventsToUiMessages(events: CoreEvent[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const e of events) {
    switch (e.type) {
      case USER_PROMPT: {
        const prompt = (e.payload as { prompt?: unknown }).prompt;
        out.push({ kind: 'user', text: typeof prompt === 'string' ? prompt : String(prompt ?? '') });
        break;
      }
      case ASSISTANT_MESSAGE: {
        // message 即该 assistant.message CoreEvent(payload.content),与 live 'assistant' 事件同构。
        out.push({ kind: 'agent', event: { type: 'assistant', message: e } as AgentEvent });
        break;
      }
      case TOOL_REQUESTED: {
        const p = e.payload as { toolName?: string; toolUseId?: string; input?: unknown };
        out.push({
          kind: 'agent',
          event: {
            type: 'tool_call',
            toolName: String(p.toolName ?? ''),
            toolUseId: String(p.toolUseId ?? ''),
            input: p.input,
          },
        });
        break;
      }
      case TOOL_RESULT: {
        const p = e.payload as { toolUseId?: string };
        out.push({
          kind: 'agent',
          event: { type: 'tool_result', toolUseId: String(p.toolUseId ?? ''), result: e } as AgentEvent,
        });
        break;
      }
      // 其余事件(turn.*/stop/session.*/stage/compaction.* 等)无 transcript 视图意义 → 跳过。
      default:
        break;
    }
  }
  return out;
}
