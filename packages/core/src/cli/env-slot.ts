/**
 * Env slot(host 层)—— 把会话启动时的真实环境锚点拼成一个静态 system-prompt 段。
 *
 * 为什么要它:模型若不知道 cwd,在 schema 索要绝对路径(file-tools `file_path` 描述
 * 「absolute, or relative to the working directory」)时只能瞎拼,典型幻觉是编一个
 * 像样的 base(如 `/Users/you/Documents/work`)再夹个 `.../` 占位中段。给它一个真实
 * 锚点(`<env>` 块)即可根治:要么直接给对的绝对路径,要么放心
 * 给相对路径。
 *
 * 事实在会话内稳定(cwd/git/platform),故 **构造时探测一次** 缓存进闭包,render 恒返
 * 同一文本(static slot,随 /clear|/compact 失效)。git 探测失败优雅降级为 No。
 *
 * Boundary: 这是 host 层(src/cli/),允许 import `node:`(对齐 io.ts / mcp-stdio.ts);
 * core 本体仍禁 node:,故此 slot 不放进 capability/。
 */
import { execFileSync } from 'node:child_process';
import { release as osRelease } from 'node:os';
import type { Slot } from '../capability/types';

/** 同步探测当前目录是否 git 仓 + 分支名;任何失败(无 git / 非仓 / spawn 异常)→ 优雅降级。 */
function probeGit(cwd: string): { isRepo: boolean; branch?: string } {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (inside !== 'true') return { isRepo: false };
  } catch {
    return { isRepo: false };
  }
  let branch: string | undefined;
  try {
    branch =
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || undefined;
  } catch {
    branch = undefined;
  }
  return { isRepo: true, branch };
}

/** 拼 `<env>…</env>` 文本(纯函数,便于测试)。 */
export function renderEnvBlock(facts: {
  cwd: string;
  isRepo: boolean;
  branch?: string;
  platform: string;
  osVersion: string;
  date: string;
}): string {
  const lines = [
    '<env>',
    `Working directory: ${facts.cwd}`,
    `Is directory a git repo: ${facts.isRepo ? 'Yes' : 'No'}`,
  ];
  if (facts.isRepo && facts.branch) lines.push(`Current git branch: ${facts.branch}`);
  lines.push(`Platform: ${facts.platform}`);
  lines.push(`OS version: ${facts.osVersion}`);
  lines.push(`Today's date: ${facts.date}`);
  lines.push('</env>');
  return lines.join('\n');
}

export interface EnvSlotOpts {
  /** 工作目录锚点(缺省 process.cwd())。 */
  cwd?: string;
}

/**
 * 造 env slot:构造时探测一次环境,render 恒返同一 `<env>` 文本。
 * static(dynamic:false),cacheScope 留空 → 随静态默认域(global/org)缓存。
 */
export function makeEnvSlot(opts: EnvSlotOpts = {}): Slot {
  const cwd = opts.cwd ?? process.cwd();
  const git = probeGit(cwd);
  const text = renderEnvBlock({
    cwd,
    isRepo: git.isRepo,
    branch: git.branch,
    platform: process.platform,
    osVersion: osRelease(),
    date: new Date().toISOString().slice(0, 10),
  });
  return {
    name: 'env',
    dynamic: false,
    render: () => text,
  };
}
