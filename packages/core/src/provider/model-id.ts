/**
 * wireModel —— 把「内部模型 id」规整成「发给 provider/API 的干净 id」。
 *
 * 病根:模型解析链会读 `ANTHROPIC_MODEL` env,而某些客户端会把自己的
 * 内部模型 id(带 1M 上下文标记后缀,如 `claude-opus-4-8[1m]`)写进该 env。这种带 `[...]`
 * 后缀的 id 被原样发给 Anthropic/代理时不被识别 → 401「key not allowed to access model」
 * → agent 包成 model_error。`[1m]` 这类后缀是**客户端内部约定**(用于窗口/能力判定),
 * 不是 API 认的模型名。
 *
 * 策略:在 provider 边界(register.resolveProvider 的 stream 包装)统一剥掉**末尾的
 * `[...]` 标记段**再上 wire。窗口/计费判定仍用**原始 id**(走 model-context-table /
 * usage-stats 的 matcher,它们识别 `[1m]`),只清理 wire 上的名字。一处兜全部 provider +
 * 全部调用方(主轮/子 agent/压缩/auto-memory)。
 *
 * Boundary(核心层):纯函数,无依赖。
 */

/** 末尾 `[...]` 标记段(含前导空白),如 ` [1m]` / `[beta]`。 */
const TRAILING_TAG = /\s*\[[^\]]*\]\s*$/;

/**
 * 规整发给 API 的模型名:剥掉末尾的 `[...]` 内部标记并 trim。
 * 非字符串 / 空 → 原样返回(防御)。重复标记(`a[x][y]`)循环剥净。
 */
export function wireModel(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return model;
  let out = model.trim();
  while (TRAILING_TAG.test(out)) {
    out = out.replace(TRAILING_TAG, '').trim();
  }
  return out;
}
