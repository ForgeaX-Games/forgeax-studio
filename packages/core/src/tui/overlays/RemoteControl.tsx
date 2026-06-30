/**
 * RemoteControl 浮层(受控,无 useInput)—— /remote-control 远端控制面板。
 *
 * 列表 = 第 0 行「+ 添加微信账号」+ 每个已连接账号一行(带状态)。高亮 index 由上层 state 持有;
 * 导航(up/down/enter/esc)走 router 的 navReduce(本 mode 在 OVERLAY_MODES)。enter:
 *   - 第 0 行 → 添加账号(Repl 调 controller.addAccount);
 *   - 账号行 → 无副作用(详情已由高亮展示)。
 * 高亮的账号若处于 'scan' 且有二维码 → 下方渲染 <Qr/> 供扫码;否则展示状态详情。
 * **本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { Qr } from '../components/Qr';
import type { RemoteAccount } from '../remote/controller';
import type { RemoteStatus } from '../remote/channel';

/** 状态 → 可读标签(ASCII 符号 + 中文,符合 TUI 既有风格)。 */
const STATUS_LABEL: Record<RemoteStatus, string> = {
  idle: '未连接',
  connecting: '连接中...',
  scan: '待扫码',
  online: '在线',
  offline: '离线',
  error: '错误',
};

export interface RemoteControlProps {
  /** 账号快照(由 useRemote().accounts 传入)。 */
  accounts: RemoteAccount[];
  /** 当前高亮下标(0 = 添加行;1.. = 账号行)。 */
  index: number;
}

/** overlay 行数 = 1(添加行)+ 账号数。供 Repl 算 overlayLength。 */
export function remoteControlLength(accounts: RemoteAccount[]): number {
  return 1 + accounts.length;
}

export function RemoteControl(props: RemoteControlProps): React.ReactElement {
  const theme = useTheme();
  const { accounts, index } = props;
  // 高亮在账号行时取该账号(index 0 是添加行)。
  const highlighted = index > 0 ? accounts[index - 1] : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{'远端控制 - 微信(up/down 选择 | enter 确认 | esc 返回)'}</Text>

      {/* 第 0 行:添加账号 */}
      <Box>
        <Text color={index === 0 ? theme.accent : theme.text}>
          {index === 0 ? '> ' : '  '}
          {'+ 添加微信账号'}
        </Text>
      </Box>

      {/* 已连接账号 */}
      {accounts.length === 0 ? (
        <Text color={theme.dim}>{'  (暂无已连接账号)'}</Text>
      ) : (
        accounts.map((a, i) => {
          const active = i + 1 === index;
          return (
            <Box key={a.id}>
              <Text color={active ? theme.accent : theme.text}>
                {active ? '> ' : '  '}
                {a.label}
              </Text>
              <Text color={a.status === 'online' ? theme.success : a.status === 'error' ? theme.error : theme.dim}>
                {`  [${STATUS_LABEL[a.status]}]`}
              </Text>
            </Box>
          );
        })
      )}

      {/* 高亮账号详情:扫码态 → 渲染二维码;否则状态提示。 */}
      {highlighted ? (
        <Box flexDirection="column" marginTop={1}>
          {highlighted.status === 'scan' && highlighted.qr ? (
            <>
              <Text color={theme.dim}>{'用微信扫描下方二维码登录:'}</Text>
              <Qr payload={highlighted.qr} />
            </>
          ) : highlighted.status === 'online' ? (
            <Text color={theme.success}>{'已连接,可在微信里直接发消息控制当前会话。'}</Text>
          ) : highlighted.status === 'error' ? (
            <Text color={theme.error}>{'连接失败,请检查微信(openclaw)配置(FORGEAX_WECHAT_* 环境变量)。'}</Text>
          ) : (
            <Text color={theme.dim}>{`状态:${STATUS_LABEL[highlighted.status]}`}</Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
