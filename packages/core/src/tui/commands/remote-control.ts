/**
 * /remote-control —— 远端控制面板(扫码连接微信 + 已连接状态)。
 *
 * 无参时由 Repl.submit 特判拉起浮层(同 /model、/resume 的套路);本 run 仅在带参时被调,
 * 给出可读提示。注册即出现在 /help 与命令菜单里。
 *
 * 铁律(A8):新命令 = 加一个文件 + 自注册一行。
 * Boundary(HOST 层):仅 core 相对 import。
 */
import { registerCommand } from './registry';

registerCommand({
  name: 'remote-control',
  desc: '远端控制:扫码连接微信、查看已连接状态',
  run: (ctx) => {
    ctx.print('用 /remote-control(无参)打开远端控制面板:添加微信账号(扫码登录)并查看已连接状态。');
  },
});
