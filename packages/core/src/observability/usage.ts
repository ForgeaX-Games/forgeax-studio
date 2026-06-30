/**
 * 派生诊断指标 —— 纯函数,无副作用、无 SDK 依赖。
 *
 * 为什么独立成文件:这些是「从已有数据**派生**」的可观测性指标(架构公理 §2 Derive),
 * 把口径收敛到**单一来源**(SSOT §1)——缓存命中率怎么算、错误摘要怎么截断,只此一处定义,
 * fck(kernel.turn)与 agent(tool span)共用,且能被纯单测打满分支。
 */

/** 一轮的 token 用量(与 KernelEvent `turn.usage` 同形)。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

/** 提示词总 token = 新增 input + 命中(cacheRead)+ 写入(cacheCreation)。output 不计入提示词。 */
export function promptTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheRead + u.cacheCreation;
}

/** 缓存命中率 = cacheRead / 提示词总 token(0..1,4 位小数;提示词总数为 0 → 0,不抛除零)。 */
export function cacheHitRate(u: TokenUsage): number {
  const p = promptTokens(u);
  return p > 0 ? Math.round((u.cacheRead / p) * 10000) / 10000 : 0;
}

/** 工具错误结果 → span 用的简短错误摘要(截断 300 防大 payload 爆 span)。best-effort,绝不抛。 */
export function briefError(result: unknown): string {
  try {
    const payload = (result as { payload?: unknown } | null)?.payload ?? result;
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return 'tool error';
  }
}
