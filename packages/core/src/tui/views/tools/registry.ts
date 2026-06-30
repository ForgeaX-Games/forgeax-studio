/**
 * 工具视图注册表(梁① · by canonical name)。
 *
 * 选型 = by-name(地基方案 §1/§3梁①):key = canonical 真工具名(`bash` /
 * `edit_file` / `read_file` …),每名一个 ToolView 渲染器 + `default` 兜底。
 *
 * 铁律:
 *  - registry **不做别名解析**(解析是 driver.toolMeta 的事)。查表者必须先过
 *    `driver.toolMeta(name).canonical` 拿真名再 `resolveTool(canonical)`;为方便
 *    P6 接线,提供 `resolveToolByMeta(toolMeta, name)` 便捷函数。
 *  - 未命中 → Default 兜底,**永不抛**。
 *  - 新增工具专用渲染 = 加一个文件 + 自注册一行(`registerTool(realName, view)`),
 *    不改本表。多工具共用一卡 = 同一渲染器在多个真名下各 register 一次。
 *
 * Boundary(HOST 层):仅 core 相对 import + react/ink。
 */
import { createElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolView, ThemeTokens } from '../../contracts';

const registry = new Map<string, ToolView>();

function statusMark(status: 'running' | 'ok' | 'error'): string {
  if (status === 'running') return '*';
  if (status === 'error') return 'x';
  return '+';
}

function summarize(v: unknown): string {
  if (v == null) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** 内置 thin 兜底:`mark name summary`(单行)。Default.tsx 会再注册一个富 'default'
 *  覆盖它;此 thin 版仅作 'default' 未注册时的终极保险(永不抛)。 */
const thinDefault: ToolView = (p) => {
  const color =
    p.status === 'error' ? p.theme.error : p.status === 'ok' ? p.theme.success : p.theme.dim;
  const summary = summarize(p.input);
  return createElement(
    Box,
    null,
    createElement(Text, { color }, `${statusMark(p.status)} ${p.displayName}`),
    summary ? createElement(Text, { color: p.theme.dim }, ` ${summary}`) : null,
  );
};

/** 按 canonical 真名注册一个 ToolView。 */
export function registerTool(canonical: string, view: ToolView): void {
  registry.set(canonical, view);
}

/** 按 canonical 真名解析(永不抛):命中 → 该渲染器;否则 → 富 'default';
 *  连 'default' 都没注册 → 内置 thin 兜底。**不做别名解析**(调用方先经 toolMeta)。 */
export function resolveTool(canonical: string): ToolView {
  return registry.get(canonical) ?? registry.get('default') ?? thinDefault;
}

/** 便捷函数(供 P6 接线):接收 driver.toolMeta 与模型发来的原名,内部先 canonical
 *  解析(吃掉别名 `Bash`→`bash`)再 resolveTool。这是查表的唯一正确入口。 */
export function resolveToolByMeta(
  toolMeta: (name: string) => { canonical: string },
  name: string,
): ToolView {
  return resolveTool(toolMeta(name).canonical);
}

/** ThemeTokens 的便利再导出,免渲染器再绕一圈。 */
export type { ThemeTokens };
