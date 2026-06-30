/**
 * Slash 命令注册表(name → SlashCommand;list 全集)。
 *
 * 铁律(A8):新命令 = 加一个文件 + 自注册一行(registerCommand)。本表只持有
 * Map + register/list/resolve。T6 的各命令在自己文件内自注册;Repl(T9)import 触发。
 *
 * Boundary(HOST 层):仅 core 相对 import。
 */
import type { SlashCommand } from '../contracts';

const registry = new Map<string, SlashCommand>();

export function registerCommand(c: SlashCommand): void {
  registry.set(c.name, c);
}

/**
 * 动态 provider —— 返回一组 file 指令(用户 `~/.forgeax/commands` 等),**每次现取**以支持
 * 热更新。由 TUI 启动时 `registerCommandProvider` 注入。内置命令(静态注册)恒优先,同名时
 * file 指令被让位。listCommands/resolveCommand/CommandMenu 一处接入即全覆盖。
 */
let dynamicProvider: (() => SlashCommand[]) | null = null;

export function registerCommandProvider(fn: () => SlashCommand[]): void {
  dynamicProvider = fn;
}

/** provider 现取的 file 指令(剔除与内置同名者)。provider 抛错时优雅返回空。 */
function providerCommands(): SlashCommand[] {
  if (!dynamicProvider) return [];
  try {
    return dynamicProvider().filter((c) => !registry.has(c.name));
  } catch {
    return [];
  }
}

export function listCommands(): SlashCommand[] {
  return [...registry.values(), ...providerCommands()];
}

/** 命中或 undefined(调用方对未知 /xxx 给可读提示)。内置优先,再查 file 指令。 */
export function resolveCommand(name: string): SlashCommand | undefined {
  return registry.get(name) ?? providerCommands().find((c) => c.name === name);
}
