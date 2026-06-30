/**
 * Transcript.tsx —— 提交生命周期的唯一 owner(梁②)。
 *
 * 持 flushedCount:
 *   - reduceTranscript(log[0..flushed]) → <Static>(committed,Ink 只渲染新增,
 *     承载海量历史,提交后不再重渲)。
 *   - reduceTranscript(log[flushed..]) → live 区(本轮进行中,实时重渲;工具卡
 *     才能从 running→✓/✗ 更新,不被 Static 冻结)。
 *   - turn 结束(!busy)推进 flushed = log.length。彻底解决 Static 冻结(梁② 病根)。
 *
 * **切分必须在 reduce 之前**(按 log 下标切),否则跨边界的 tool_call/tool_result
 * 会被切到两段而配不上对。reduce 各段内部各自配对;一个完整 turn 的 call+result
 * 同在 live 段,turn 结束后整段一起进 Static,配对关系完好。
 *
 * 单条渲染(P6 合龙已接真渲染器):
 *   - tool      → resolveToolByMeta(toolMeta, name):先经 driver.toolMeta(name).canonical
 *                 吃掉别名(`Bash`→`bash`),再按 canonical 真名查 views/tools/registry;
 *                 未命中落 Default(永不抛)。
 *   - assistant → views/messages:thinking(可折叠,expanded 控)+ text。
 *   - user / notice → views/messages 按 key 分发。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static } from 'ink';
import type { TranscriptItem, SessionEntry } from './items';
import { reduceTranscript, safeFlushBoundary } from './reduce';
import { useTheme } from '../providers/theme';
import type { ThemeTokens } from '../contracts';
import { resolveToolByMeta } from '../views/tools/registry';
import { resolveMessageByItem, type MessageViewProps } from '../views/messages/registry';
import { ThinkingView, thinkingText } from '../views/messages/Thinking';
import { useResizeRedraw } from '../use-resize-redraw';

/** driver.toolMeta 的最小形状(查工具卡只需 canonical;别名在此被吃掉)。 */
type ToolMetaFn = (name: string) => { canonical: string; displayName: string };

export interface TranscriptProps {
  /** session 真相:有序事件日志(梁②;user 输入 + 原生 AgentEvent)。 */
  log: SessionEntry[];
  /** 本轮是否进行中。!busy 时把 live 段提交进 Static(推进 flushed)。 */
  busy: boolean;
  /** driver.toolMeta:工具卡查表前经它解析 canonical(吃掉别名)。 */
  toolMeta: ToolMetaFn;
  /** ctrl+o 控制 thinking 是否展开(透传给 views/messages/Thinking)。 */
  expanded?: boolean;
  /** /resume 整体替换 transcript 时由上层自增:并入 <Static key> 强制重挂载 → 重新 emit
   *  恢复会话的全量历史(否则 Ink <Static> 只追加新条目,旧 transcript 不会被替换)。 */
  redrawNonce?: number;
}

export function Transcript(props: TranscriptProps): React.ReactElement {
  const { log, busy, toolMeta, expanded, redrawNonce = 0 } = props;
  const theme = useTheme();

  // resize 干净重绘:staticKey 随终端 resize 自增,用作 <Static key> 触发重挂载 +
  //   重新 emit 整段 transcript(配合 patch 的 resetStaticOutput + clearTerminal,绕开
  //   stock ink resized() 在终端 reflow 后 eraseLines 擦错行数的残影)。见 use-resize-redraw。
  const staticKey = useResizeRedraw();
  // 实际 <Static> key:resize(staticKey)与 /resume 替换(redrawNonce)任一变化都重挂载重绘。
  const staticRenderKey = `${staticKey}:${redrawNonce}`;

  // ── 提交边界(增量):把「已定型」的前缀持续刷进 <Static>,而非憋到 turn 结束。
  //   旧实现把整轮输出全留在 live 动态区直到 !busy → 长输出时动态区超过终端高度,
  //   Ink 每帧整段擦除重画(还叠加 spinner / elapsed 高频刷),视口被反复拽回底部 →
  //   往上滚就被弹回、滚不到底。改为:
  //     ① 随日志推进到 safeFlushBoundary(所有已出现工具均已配对的最大前缀),单调不退;
  //        live 动态区只剩「仍在 running 的工具卡 + 其后尾巴」,恒压在一屏内。
  //     ② turn 结束(!busy)再兜底全量提交(含被 abort 的 running 卡 —— 其 result 永不再来,
  //        已是 terminal,可安全冻结)。
  //     ③ 日志缩短(rewind/clear)时把 flushed 夹回,避免越界 / committed 与 live 重复。
  const [flushed, setFlushed] = useState(0);
  const boundary = useMemo(() => safeFlushBoundary(log), [log]);
  useEffect(() => {
    setFlushed((f) => (f > log.length ? log.length : Math.max(f, boundary)));
  }, [boundary, log.length]);
  useEffect(() => {
    if (!busy) setFlushed(log.length);
  }, [busy, log.length]);

  // 先按 log 下标切,再各自 reduce(保证跨边界的 call/result 不被切散)。
  const committed = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(0, flushed)),
    [log, flushed],
  );
  const live = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(flushed)),
    [log, flushed],
  );

  return (
    <Box flexDirection="column">
      {/* committed:Ink <Static> 只渲染新增条目;key=staticKey 让 resize 时整体重挂载重画。
          每块上方留一行(marginTop=1)给透气感。 */}
      <Static key={staticRenderKey} items={committed}>
        {(item) => (
          <Box key={item.id} flexDirection="column" marginTop={1}>
            {renderItem(item, theme, toolMeta, expanded)}
          </Box>
        )}
      </Static>

      {/* live:本轮进行中条目(实时重渲;工具卡 running→✓/✗ 在此更新)。 */}
      {live.map((item) => (
        <Box key={item.id} flexDirection="column" marginTop={1}>
          {renderItem(item, theme, toolMeta, expanded)}
        </Box>
      ))}
    </Box>
  );
}

/** 单条渲染分发(无 switch on 渲染器;查表走 registry)。 */
function renderItem(
  item: TranscriptItem,
  theme: ThemeTokens,
  toolMeta: ToolMetaFn,
  expanded?: boolean,
): React.ReactNode {
  if (item.kind === 'tool') {
    // 工具卡:经 toolMeta(name).canonical 解析(吃掉别名)→ views/tools/registry。
    const meta = toolMeta(item.name);
    const view = resolveToolByMeta(toolMeta, item.name);
    return view({
      name: meta.canonical,
      displayName: meta.displayName,
      input: item.input,
      result: item.result,
      status: item.status,
      isError: item.isError,
      theme,
    });
  }

  if (item.kind === 'assistant' && item.event.type === 'assistant') {
    // assistant:先渲染 thinking(若有,可折叠),再渲染 text(经 messages registry)。
    const hasThinking = thinkingText(item.event).length > 0;
    const props: MessageViewProps = { item, theme, expanded };
    const text = resolveMessageByItem(item);
    return (
      <>
        {hasThinking ? <Box key="thinking">{ThinkingView(props)}</Box> : null}
        <Box key="text">{text(props)}</Box>
      </>
    );
  }

  // user / notice / 其它 assistant → messages registry 按 key 分发。
  if (item.kind === 'user' || item.kind === 'notice' || item.kind === 'assistant') {
    const view = resolveMessageByItem(item);
    return view({ item, theme, expanded });
  }
  return null;
}
