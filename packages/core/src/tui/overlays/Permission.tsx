/**
 * Permission 浮层(受控,无 useInput)—— 权限审批卡(重写自 permissions/{Fallback,registry}.tsx)。
 *
 * 关键修复(梁①「同源 bug」):查审批卡前**先过 `toolMeta(name).canonical`** 吃掉别名
 * (`Bash`→`bash`),再按 canonical 真名查表,**绝不**按 `pp.use.name` 裸键。否则一旦按真名
 * 注册专用审批卡,别名调用即漏判落 fallback。
 *
 * 本组件只做纯渲染:选项三选一(允许一次/总是允许/拒绝)+ 高亮 index 由上层 state 持有。
 * 决策导航(↑↓/enter/esc)交给本文件导出的纯 reducer `permissionReducer`,供 P6 router 调。
 * **本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type {
  Key,
  PermissionDecision,
  PermissionProps,
  ThemeTokens,
  ToolUse,
  PermissionResult,
} from '../contracts';

/** 决策选项(顺序固定,reducer 与渲染共用)。 */
export const PERMISSION_OPTIONS: ReadonlyArray<{ label: string; value: PermissionDecision }> = [
  { label: '允许一次', value: 'allow-once' },
  { label: '总是允许', value: 'allow-always' },
  { label: '拒绝', value: 'deny' },
];

/** 导航 reducer 产出:移动高亮、按当前项决策、或 esc 取消(= deny)。 */
export type PermissionNavResult =
  | { kind: 'move'; index: number }
  | { kind: 'decide'; decision: PermissionDecision }
  | { kind: 'cancel' }
  | { kind: 'none' };

/**
 * Permission 纯导航 reducer —— 供 P6 router 调。
 * ↑↓ 环形移动选项、enter 按当前项决策、esc 取消(router 应据此 resolve(false))。
 */
export function permissionReducer(index: number, key: Key): PermissionNavResult {
  const n = PERMISSION_OPTIONS.length;
  if (key.kind === 'esc') return { kind: 'cancel' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + n) % n };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % n };
  if (key.kind === 'enter') return { kind: 'decide', decision: PERMISSION_OPTIONS[index]!.value };
  return { kind: 'none' };
}

// ── 受控渲染:卡片正文(各专用卡)+ 选项列表(共用) ──

function summarize(v: unknown, max = 120): string {
  if (v == null) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** 卡片渲染器(纯):产出 title/detail/message 三段,由外壳统一套边框 + 选项。
 *  与旧 PermissionRenderer 不同:不含 useInput、不收 onDecision,只画正文。 */
export interface PermissionCardProps {
  use: ToolUse;
  perm: PermissionResult;
  theme: ThemeTokens;
}
export interface PermissionCardBody {
  title: React.ReactNode;
  detail?: React.ReactNode;
  message?: string;
}
export type PermissionCard = (p: PermissionCardProps) => PermissionCardBody;

const bashCard: PermissionCard = ({ use, perm, theme }) => {
  const cmd = (use.input as { command?: string })?.command ?? '';
  return {
    title: '⚠ 运行 Bash 命令?',
    message: perm.message,
    detail: <Text color={theme.accent}>{`$ ${cmd}`}</Text>,
  };
};

interface WriteInput {
  file_path?: string;
  path?: string;
  content?: string;
  new_string?: string;
}
const fileWriteCard: PermissionCard = ({ use, perm, theme }) => {
  const input = (use.input ?? {}) as WriteInput;
  const path = input.file_path ?? input.path ?? '';
  const body = input.new_string ?? input.content ?? '';
  const preview = body.length > 200 ? `${body.slice(0, 197)}...` : body;
  return {
    title: `⚠ 写入 ${path || '文件'}?`,
    message: perm.message,
    detail: preview ? (
      <Box flexDirection="column">
        <Text color={theme.dim}>{preview}</Text>
      </Box>
    ) : undefined,
  };
};

const fallbackCard: PermissionCard = ({ use, perm, theme }) => {
  const inputSummary = summarize(use.input);
  return {
    title: `⚠ 允许 ${use.name}?`,
    message: perm.message,
    detail: inputSummary ? <Text color={theme.dim}>{inputSummary}</Text> : undefined,
  };
};

/** 审批卡注册表 —— **key = canonical 真名**(`bash`/`write_file`/`edit_file`…)。 */
const registry = new Map<string, PermissionCard>([
  ['bash', bashCard],
  ['write_file', fileWriteCard],
  ['edit_file', fileWriteCard],
]);

/** 注册一张专用审批卡(按 canonical 真名)。新工具 = 加一行。 */
export function registerPermissionCard(canonical: string, card: PermissionCard): void {
  registry.set(canonical, card);
}

/** 命中或 fallback(永不抛)。**入参必须是 canonical 真名**(已过 toolMeta 解析)。 */
export function resolvePermissionCard(canonical: string): PermissionCard {
  return registry.get(canonical) ?? fallbackCard;
}

export { fallbackCard };

// ── 浮层组件 ──

export interface PermissionOverlayProps extends PermissionProps {
  /** 已由 router 经 driver.toolMeta(use.name).canonical 解析的真名(查表用)。 */
  canonical: string;
  /** 当前高亮的决策选项下标(由上层 state 持有)。 */
  index: number;
}

/**
 * Permission 浮层(受控)。router 应:
 *   1) const { canonical } = driver.toolMeta(pp.use.name);
 *   2) <Permission {...pp} canonical={canonical} index={navIndex} />
 *   3) 按 permissionReducer 的产出推进 index / 调 onDecision / 取消。
 */
export function Permission(props: PermissionOverlayProps): React.ReactElement {
  const card = resolvePermissionCard(props.canonical);
  const body = card({ use: props.use, perm: props.perm, theme: props.theme });
  const { theme, index } = props;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{body.title}</Text>
      {body.detail ? <Box flexDirection="column">{body.detail}</Box> : null}
      {body.message ? <Text color={theme.dim}>{body.message}</Text> : null}
      <Box flexDirection="column">
        {PERMISSION_OPTIONS.map((o, i) => (
          <Text key={o.value} color={i === index ? theme.accent : theme.text}>
            {i === index ? '> ' : '  '}
            {o.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
