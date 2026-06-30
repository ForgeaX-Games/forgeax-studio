/** /skills · /plugin · /hooks 共用的列表渲染(023)。三命令同一展示模式。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import type { ExtensionRow } from '../contracts';

/** 把 ExtensionRow[] 渲染成可读文本;空集给「无」提示。 */
export function renderExtensionRows(kind: string, rows: ExtensionRow[]): string {
  if (!rows.length) return `无已加载 ${kind}。`;
  return rows
    .map((r) => `- ${r.name} [${r.source}] - ${r.status}${r.detail ? ` | ${r.detail}` : ''}`)
    .join('\n');
}
