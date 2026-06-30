/**
 * Error-category diagnostics aggregation (移植 agentic_os 03.E.1 工具错误五类的
 * **诊断侧**聚合)。dispatch.ts 给每个 isError 结果就近赋一个 `errorCategory`
 * (validation / unknown_tool / permission_denied / timeout / runtime_error);本
 * 文件只把一批结果**按类计数 + 人读摘要**,纯统计、不指挥模型恢复(工程只分类,
 * 模型自决,见 dispatch.ts 头注)。
 *
 * 在 toolExecution 旁按错误归因做遥测/计数,给 core 一个
 * provider-neutral 的聚合点,供 host telemetry / REPL 调试面板消费。
 *
 * 纯函数,无副作用、无 IO。入参用结构子集(`{ errorCategory? }`)而非耦合
 * dispatch.ts 的 ToolDispatchResult —— 任何带 errorCategory 字段的对象皆可喂入,
 * 故签名取 `string`(放宽于 ErrorCategory 联合,避免跨模块类型耦合)。
 * Boundary: 无 import(只算字符串),自然满足 core-relative 律。
 */

/**
 * 按 `errorCategory` 计数。`undefined`(无类目=非错误/未归因)一律跳过,不计入。
 * 返回 plain Record(类目名 → 次数),键的出现顺序即首见顺序(便于稳定摘要)。
 *
 * 纯函数:同一入参恒返回等价结果,不改入参。
 */
export function aggregateErrorCategories(items: Array<{ errorCategory?: string }>): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const item of items) {
    const cat = item?.errorCategory;
    if (cat == null) continue; // 无类目(成功/未归因)→ 不计
    stats[cat] = (stats[cat] ?? 0) + 1;
  }
  return stats;
}

/**
 * 把计数 Record 渲染成一行人读摘要(诊断/日志用)。空 → 'no errors'。
 * 非空 → 按**次数降序、同次数按名升序**稳定排序的 `cat=n` 串 + 总数,例:
 *   `3 error(s): timeout=2, validation=1`
 * 排序确定 → 摘要在相同输入下逐字稳定(便于快照/对比)。
 */
export function summarizeErrorStats(stats: Record<string, number>): string {
  const entries = Object.entries(stats).filter(([, n]) => n > 0);
  if (entries.length === 0) return 'no errors';
  entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const parts = entries.map(([cat, n]) => `${cat}=${n}`);
  return `${total} error(s): ${parts.join(', ')}`;
}
