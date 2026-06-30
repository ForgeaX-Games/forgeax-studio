/**
 * File 指令桥 —— 把用户/项目目录下的 markdown 指令(`~/.forgeax/commands`、
 * `.forgeax/commands`,以及 skill 目录里 userInvocable 的 skill)接到 TUI slash 系统。
 *
 * 经 `registerCommandProvider` 注入一个**动态 provider**:每次现取(复用带 mtime 缓存的
 * `makeCommandSource`),故指令文件的增/改/删在长会话里即时生效。映射成 `source:'file'` 的
 * `SlashCommand`,`expand(args)` 把参数展开成最终 prompt —— 实际执行由 Repl 作为一轮 user
 * 输入提交(模型据此行动)—— 即 `/command` 展开为一轮 prompt 的语义。
 *
 * 只暴露 `userInvocable`(非 `disable-model-invocation` 限制的)的指令给用户敲 `/name`。
 *
 * Boundary(HOST 层):仅 core 相对 import。
 */
import { makeCommandSource } from '../../capability/skill/index';
import { effectiveSkillDirs, effectiveCommandDirs } from '../../cli/locations';
import { registerCommandProvider } from './registry';
import type { SlashCommand } from '../contracts';

/**
 * 用生效的 skill/command 目录注册 file 指令 provider(给了 flag 只用 flag,否则项目级+用户级)。
 * @param skillFlag    `--skills` 值(无则自动发现)
 * @param commandFlag  `--commands` 值(无则自动发现)
 */
export function registerFileCommands(skillFlag?: readonly string[], commandFlag?: readonly string[]): void {
  const source = makeCommandSource(effectiveSkillDirs(skillFlag), effectiveCommandDirs(commandFlag));
  registerCommandProvider(() =>
    source()
      .filter((c) => c.userInvocable)
      .map<SlashCommand>((c) => ({
        name: c.name,
        desc: c.description,
        source: 'file',
        expand: (args: string) => c.getPrompt(args),
        // Repl 对 source:'file' 走 expand+提交一轮,run 不会被调用(占位以满足契约)。
        run: () => undefined,
      })),
  );
}
