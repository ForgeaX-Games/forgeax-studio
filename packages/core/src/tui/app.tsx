/**
 * TUI App —— Provider 树 + 路由壳 + 入口 runTui()。
 *
 * runTui(args, providerOverride):main.ts 的 TUI 分支调用。先 buildHostContext 出
 * 初始 context,createAgentDriver 持有它,render(<App/>),退出时 await driver.dispose()。
 *
 * Provider 树(A8:状态走 Context,屏幕走路由表):
 *   Theme → Session → StatusLine → InputHistory → Permission → Agent → <Route screen/>
 *
 * 注册副作用(P6 合龙):import 一次 views/* + commands 的 barrel,触发各 registerX。
 *   - views/messages:registerMessage('user'|'assistant'|'notice', …)
 *   - views/tools:registerTool('default'|'bash'|'edit_file'|…, …)(by canonical 真名)
 *   - commands:registerCommand(help/clear/model/exit)
 *   审批卡注册在 overlays/Permission.tsx 的模块级 Map,由 Repl import 触发,无需此处。
 *
 * Boundary(HOST 层):react + ink + 相对 import(含 ../cli/*)。
 */
import React from 'react';
import { render } from 'ink';
import type { LLMProvider } from '../provider/types';
import { buildHostContext, type HostContextArgs } from '../cli/host-context';
import { ThemeProvider } from './providers/theme';
import { SessionProvider } from './providers/session';
import { StatusLineProvider } from './providers/status-line';
import { InputHistoryProvider } from './providers/input-history';
import { PermissionProvider, usePermissionQueue } from './providers/permission';
import { QuestionProvider, useQuestionQueue } from './providers/question';
import { AgentProvider, createAgentDriver } from './driver/useAgent';
import { RemoteProvider } from './providers/remote';
import { createRemoteController, type ChannelFactory, type RemoteController } from './remote/controller';
import { createFakeChannel } from './remote/fake-channel';
import { createWechatChannel } from './remote/wechat/wechat-channel';
import type { AgentDriver } from './contracts';
import { routes, defaultRoute, type RouteName } from './routes';
import { installStderrGuard } from './stderr-guard';
import { inkInstanceRef } from './ink-instance-ref';

// 触发各注册表的副作用注册(views/* 在自己文件内 registerX;commands 同)。
import './views/messages/index';
import './views/tools/index';
import './commands/index';
import { registerFileCommands } from './commands/file-commands';

/** 把 driver 的 askUser / askQuestion 接到对应队列(桥)。在 Agent provider 下、Route 上方挂一层。
 *  契约分、渲染合:askUser(布尔权限闸)与 askQuestion(结构化提问)是两个独立接缝,各自有
 *  自己的队列 provider;此处统一把两条 ask 回调注入 driver。 */
function HostBridge(props: { driver: AgentDriver; children: React.ReactNode }): React.ReactElement {
  const perm = usePermissionQueue();
  const questions = useQuestionQueue();
  // 把队列的 ask 注入 driver(driveTurn 时 CoreAgent 'ask' → 弹权限卡;AskUserQuestion 工具 → 弹提问卡)。
  props.driver.setAskUser(perm.ask);
  props.driver.setAskQuestion(questions.ask);
  return <>{props.children}</>;
}

export function App(props: {
  driver: AgentDriver;
  controller: RemoteController;
  route?: RouteName;
}): React.ReactElement {
  const route = routes[props.route ?? defaultRoute];
  const Screen = route.screen;
  return (
    <ThemeProvider>
      <SessionProvider>
        <StatusLineProvider>
          <InputHistoryProvider>
            <PermissionProvider>
              <QuestionProvider>
                <AgentProvider driver={props.driver}>
                  <RemoteProvider controller={props.controller}>
                    <HostBridge driver={props.driver}>
                      <Screen />
                    </HostBridge>
                  </RemoteProvider>
                </AgentProvider>
              </QuestionProvider>
            </PermissionProvider>
          </InputHistoryProvider>
        </StatusLineProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

/**
 * 远端通道工厂(/remote-control):wechat → openclaw HTTP 长轮询通道;fake → 离线桩。
 * --demo 下一律返回 fake(自动登录 + 自证一条入站),不联网也能跑通全链路。
 */
function makeChannelFactory(demo: boolean): ChannelFactory {
  return (kind) => {
    if (demo || kind === 'fake') {
      return createFakeChannel({ label: '演示账号', autoLoginMs: 3000, autoInboundMs: 1500 });
    }
    // 「+ 添加微信账号」语义 = 登录一个账号 → 总是出二维码重新扫(不静默复用磁盘旧凭证,
    //   否则有缓存时会瞬间 online 又被自动收起,看起来像「二维码没出来直接回聊天」)。
    return createWechatChannel({ freshScan: true });
  };
}

/** 为一次新交互生成会话 id:`YYYYMMDD-HHmmss-<rand>`,可读且按字典序≈时间序。 */
function newSessionId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/** runTui 入口入参(CliArgs 结构上是其超集;不从 cli/main import 以免环依赖)。 */
export interface TuiArgs extends HostContextArgs {
  /** --continue:续接「default」会话(= --resume default 的快捷)。 */
  continueSession?: boolean;
}

/** main.ts 的 TUI 分支入口:装配 → 渲染 → 等退出 → 清理。返回退出码。 */
export async function runTui(args: TuiArgs, providerOverride?: LLMProvider): Promise<number> {
  // 会话 id 解析:
  //   --resume/--session <id> → 用指定 id;--continue → 续接「default」会话;
  //   否则**自动生成**一个新会话 id(时间戳),让普通交互也持久化 WAL,从而可被 /resume 列出。
  //   (此前未指定时 sessionId=undefined,host-context 不接 WAL → 永不落盘 → /resume 永远为空。)
  const sessionId =
    args.sessionId ?? (args.continueSession ? 'default' : newSessionId());
  const hostArgs = {
    model: args.model,
    demo: args.demo,
    memoryDir: args.memoryDir,
    skillDirs: args.skillDirs,
    commandDirs: args.commandDirs,
    mcpConfigPath: args.mcpConfigPath,
    pluginDirs: args.pluginDirs,
    hooksConfigPath: args.hooksConfigPath,
    searchUrl: args.searchUrl,
    sessionId,
    sessionsDir: args.sessionsDir,
  };
  // 把用户/项目的 markdown 指令(~/.forgeax/commands 等)接到 TUI slash(菜单/解析/分发)。
  //   provider 现取 → 热更新;给了 --skills/--commands 只用 flag,否则自动发现两层。
  registerFileCommands(args.skillDirs, args.commandDirs);
  const host = await buildHostContext(hostArgs, providerOverride);
  const driver = createAgentDriver({ ...hostArgs, providerOverride }, host);
  // 远端控制(/remote-control):controller 持有微信/桩通道,中转消息进 TUI 轮路径。
  const controller = createRemoteController(makeChannelFactory(!!args.demo));

  // stderr guard:挂载期把裸 process.stderr.write 拦进缓冲,退出还屏后再 flush。
  //   stock ink 的 patch-console 只接管 console.*,拦不住 core 的裸 stderr 写,会污染帧
  //   (输入框残影/重复)。详见 ./stderr-guard。⚠️ 只拦 stderr,ink 帧走 stdout 不可碰。
  const restoreStderr = installStderrGuard();
  const instance = render(<App driver={driver} controller={controller} />);
  // 暴露 Instance 给 resize 干净重绘用(Transcript 经 inkInstanceRef 调 resetStaticOutput)。
  inkInstanceRef.current = instance as unknown as typeof inkInstanceRef.current;
  try {
    await instance.waitUntilExit();
  } finally {
    inkInstanceRef.current = null;
    await controller.dispose(); // 登出 / 关闭全部远端通道(wechaty bot.stop 等)。
    await driver.dispose();
    restoreStderr(); // ink 已卸载、终端已还屏,此时 flush 缓冲不污染画面。
  }
  return 0;
}
