/**
 * Skill / Command 模型 (SKILL pack)。
 *
 * skill 是 **prompt 型 Command 不是 Tool** —— skill 展开成
 * 一段 prompt 注入会话，不是直接产出 ToolResult。SkillTool 只是把 model 的
 * `{skill, args}` 调用 dispatch 到对应 Command 的 `getPrompt(args)`。
 *
 * 设计稿: core-layer-spec §3.4。
 *
 * Boundary: 仅 import core-local (frontmatter) + node:path。
 */
import type {
  EffortValue,
  FrontmatterShell,
  RawFrontmatterObject,
  SkillMeta,
} from './frontmatter';

/** skill prompt 渲染时可注入的运行期变量 (集成者 inject；缺省走默认替换)。 */
export interface SkillPromptVars {
  /** ${BC_SESSION_ID}（兼容 ${CLAUDE_SESSION_ID}）替换值。 */
  sessionId?: string;
  /** 其它 ${KEY} 字面替换 (key→value)。 */
  [key: string]: string | undefined;
}

/**
 * Command —— skill 的 prompt 形态 (`type:'prompt'` Command)。
 * 是 Skill 的「能力」面：给 SkillTool / slash dispatcher 调。
 */
export interface Command {
  readonly type: 'prompt';
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly version?: string;
  readonly model?: string;
  readonly allowedTools: string[];
  readonly argumentHint?: string;
  readonly argumentNames: string[];
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly context: 'fork' | 'inline';
  /** skill 自身目录 (绝对路径)，用于 ${BC_SKILL_DIR} 替换 / 相对资源解析。 */
  readonly baseDir: string;
  /** 条件激活 path 模式 (有则为 conditional skill)。 */
  readonly paths?: string[];
  /** fork 时委派的 agent 名 (frontmatter `agent:`)。 */
  readonly agent?: string;
  /** 推理强度 (level 或整数)。 */
  readonly effort?: EffortValue;
  /** !`…` 注入块用的 shell (缺省由 host 走 bash)。 */
  readonly shell?: FrontmatterShell;
  /** skill 级 hooks 原样对象 (执行由 host)。 */
  readonly hooks?: RawFrontmatterObject;
  /** 是否隐藏 (= !userInvocable)。 */
  readonly isHidden: boolean;
  /** 渲染最终 prompt：参数替换 + ${BC_SKILL_DIR}/${BC_SESSION_ID} 替换。 */
  getPrompt(args?: string, vars?: SkillPromptVars): string;
}

/**
 * Skill —— 一个已加载的技能 (meta + 它的 Command)。
 * 是发现/列举面 (loader 产出)；`command` 是它的可调用面。
 */
export interface Skill {
  readonly name: string;
  readonly meta: SkillMeta;
  readonly baseDir: string;
  readonly command: Command;
}

// ─── 参数替换 (极简参数替换子集) ─────────────────────────

/** 朴素 shell-ish 分词：支持单/双引号包裹的空格。 */
function parseArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在 content 里做参数替换：
 *   - $ARGUMENTS          → 全部参数原串
 *   - $ARGUMENTS[i] / $i  → 第 i 个参数 (越界=空串)
 *   - $name (命名)        → 按位映射 argumentNames[i] → parsedArgs[i]
 * args === undefined → 不替换 (原样返回)。
 */
function substituteArguments(
  content: string,
  args: string | undefined,
  argumentNames: string[],
): string {
  if (args === undefined) return content;
  const parsed = parseArgs(args);

  let out = content;

  // 命名参数 (先做，避免 $0 简写误伤)。$name 但不接 [ 或 word char。
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i];
    if (!name) continue;
    out = out.replace(
      new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'),
      parsed[i] ?? '',
    );
  }

  // $ARGUMENTS[i]
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_all, idx: string) => {
    return parsed[Number(idx)] ?? '';
  });

  // $i 简写 (索引)。不接 word char。
  out = out.replace(/\$(\d+)(?!\w)/g, (_all, idx: string) => {
    return parsed[Number(idx)] ?? '';
  });

  // $ARGUMENTS 全量。不接 [ (上面已处理) 或 word char。
  out = out.replace(/\$ARGUMENTS(?![\[\w])/g, args);

  return out;
}

/**
 * 由 meta + baseDir + 正文 造一个 prompt 型 Command。
 * getPrompt 做参数替换 + ${BC_SKILL_DIR} / ${BC_SESSION_ID} / 自定义
 * ${KEY} 字面替换。
 *
 * @param meta     toSkillMeta 产出的强类型元数据
 * @param baseDir  skill 目录绝对路径
 * @param body     SKILL.md 正文 (去 frontmatter)
 * @param name     skill 名 (= 目录名)
 */
export function createSkillCommand(
  meta: SkillMeta,
  baseDir: string,
  body: string,
  name: string,
): Command {
  return {
    type: 'prompt',
    name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    version: meta.version,
    model: meta.model,
    allowedTools: meta.allowedTools,
    argumentHint: meta.argumentHint,
    argumentNames: meta.argumentNames,
    userInvocable: meta.userInvocable,
    disableModelInvocation: meta.disableModelInvocation,
    context: meta.context,
    baseDir,
    paths: meta.paths,
    agent: meta.agent,
    effort: meta.effort,
    shell: meta.shell,
    hooks: meta.hooks,
    isHidden: !meta.userInvocable,
    getPrompt(args?: string, vars?: SkillPromptVars): string {
      // base directory 头 (便于相对资源解析)。
      let content = `Base directory for this skill: ${baseDir}\n\n${body}`;

      content = substituteArguments(content, args, meta.argumentNames);

      // ${BC_SKILL_DIR} —— skill 自身目录 (win32 反斜杠归一)。
      // 同时兼容外部 skill 资产里旧的 ${CLAUDE_SKILL_DIR} 写法。
      const skillDir =
        process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir;
      content = content.replace(/\$\{(?:BC|CLAUDE)_SKILL_DIR\}/g, skillDir);

      // ${BC_SESSION_ID}（兼容 ${CLAUDE_SESSION_ID}）
      if (vars?.sessionId !== undefined) {
        content = content.replace(
          /\$\{(?:BC|CLAUDE)_SESSION_ID\}/g,
          vars.sessionId,
        );
      }

      // 其它注入的 ${KEY}
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          if (k === 'sessionId' || v === undefined) continue;
          content = content.replace(
            new RegExp(`\\$\\{${escapeRegExp(k)}\\}`, 'g'),
            v,
          );
        }
      }

      return content;
    },
  };
}
