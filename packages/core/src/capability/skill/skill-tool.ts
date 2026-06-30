/**
 * SkillTool —— 把 model 的 `{skill, args?}` 调用 dispatch 到对应 skill Command。
 *
 * skill 本身是 prompt 型 Command；SkillTool 是它在 AgentTool ABI (C2) 上的薄
 * 包装，让 model 能像调工具一样调起 skill。dispatch 两态:
 *   - inline (默认)：展开 skill prompt，作为 newMessages 回灌会话 (host 续跑)。
 *   - fork：返回 `status:'forked'` 描述，由 host 在隔离子 agent 里跑 (core 不
 *     spawn —— 干净律，真正的 fork 由集成者按 status 执行)。
 *
 * 权限：checkPermissions 走 **safe-property allowlist** —— skill Command 若只
 * 含已知安全字段 (allowlist 内) → auto-allow；出现任一未知字段且有意义值 →
 * **fail-closed** 退回 'ask' (要权限)。
 *
 * Boundary: 仅 import C2 契约 + core-local (command)。
 */
import { buildTool } from '../types';
import type { AgentTool, JSONSchema, PermissionResult, ToolResult } from '../types';
import type { CoreEvent } from '../../events/types';
import type { Command, SkillPromptVars } from './command';

/**
 * Skill 工具的指令来源:
 *   - `Command[]`        静态快照(建一次冻结;测试/直接调用用)。
 *   - `() => Command[]`  动态解析器:每次访问现取——支持指令文件**热更新**
 *     (增/改/删在长会话里即时生效)。解析器自带缓存以免每轮重复读盘。
 */
export type SkillToolSource = readonly Command[] | (() => readonly Command[]);

/** SkillTool 输入。 */
export interface SkillToolInput {
  /** skill 名 (可带前导 `/`，会被剥掉)。 */
  skill: string;
  /** 可选参数串。 */
  args?: string;
}

/** SkillTool 输出 (inline | forked 二态)。 */
export type SkillToolOutput =
  | {
      success: true;
      commandName: string;
      status: 'inline';
      /** 展开后的 prompt (host 回灌会话用)。 */
      prompt: string;
      allowedTools?: string[];
      model?: string;
    }
  | {
      success: true;
      commandName: string;
      status: 'forked';
      /** fork 跑所需上下文：prompt + model + allowedTools，由 host spawn。 */
      prompt: string;
      model?: string;
      allowedTools?: string[];
    };

export const SKILL_TOOL_NAME = 'Skill';

/**
 * Command 的安全字段 allowlist —— 只含这些字段 (且无未知有意义字段) 的 skill
 * 才 auto-allow。新增字段默认落到「要权限」一侧 (fail-closed)。
 */
const SAFE_SKILL_PROPERTIES = new Set<string>([
  'type',
  'name',
  'description',
  'whenToUse',
  'version',
  'model',
  'allowedTools',
  'argumentHint',
  'argumentNames',
  'userInvocable',
  'disableModelInvocation',
  'context',
  'baseDir',
  'paths',
  'isHidden',
  'getPrompt',
]);

/** 字段值是否「有意义」(非空)：undefined/null/空数组/空对象都算无意义。 */
function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * skill Command 是否只用安全字段。任一不在 allowlist 且有意义值的字段 →
 * false (要权限)。导出供测试。
 */
export function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) continue;
    if (isMeaningful((command as unknown as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** 剥前导 `/` 并 trim。 */
function normalizeName(skill: string): string {
  const t = skill.trim();
  return t.startsWith('/') ? t.slice(1) : t;
}

/**
 * 由 skill 指令来源造 name='Skill' 的 AgentTool。
 *
 * 来源是 `() => Command[]` 时,工具**每次访问现解析**(dispatch + schema 的 available
 * 列表都随之更新),从而支持指令文件热更新;是 `Command[]` 时为静态快照。`inputJSONSchema`
 * 做成 live getter —— `buildRequest` 每轮现读它,故模型每轮看到最新可用指令(内容不变时
 * 返回等价文本,prompt-cache 不被无谓击穿)。
 *
 * @param source  指令来源(静态数组 或 动态解析器),见 {@link SkillToolSource}
 * @param vars    可选 prompt 注入变量 (sessionId 等)，透传给 getPrompt
 */
export function buildSkillTool(
  source: SkillToolSource,
  vars?: SkillPromptVars,
): AgentTool<SkillToolInput, SkillToolOutput> {
  const resolve = typeof source === 'function' ? source : () => source;

  /** 现解析一份 name→Command 映射(同名后注册覆盖,与既有快照语义一致)。 */
  const currentByName = (): Map<string, Command> => {
    const m = new Map<string, Command>();
    for (const c of resolve()) m.set(c.name, c);
    return m;
  };

  /** 由当前可用指令名算 schema(available 列表随源更新)。 */
  const computeSchema = (): JSONSchema => {
    const names = [...currentByName().keys()];
    return {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: `The skill to invoke${names.length ? ` (available: ${names.join(', ')})` : ''}.`,
        },
        args: { type: 'string', description: 'Optional arguments passed to the skill.' },
      },
      required: ['skill'],
      additionalProperties: false,
    };
  };

  const tool = buildTool<SkillToolInput, SkillToolOutput>({
    name: SKILL_TOOL_NAME,
    searchHint: 'invoke a slash-command skill',
    // inputJSONSchema 不在此设静态值;下方 defineProperty 挂 live getter(动态 available 列表)。
    maxResultSizeChars: 100_000,

    isReadOnly: () => false,
    isConcurrencySafe: () => false, // skill 展开成 prompt，必须串行

    async validateInput(input) {
      const name = normalizeName(input.skill);
      if (name === '') {
        return { result: false, message: `Invalid skill format: ${input.skill}` };
      }
      const cmd = currentByName().get(name);
      if (!cmd) {
        return { result: false, message: `Unknown skill: ${name}` };
      }
      if (cmd.disableModelInvocation) {
        return {
          result: false,
          message: `Skill ${name} cannot be invoked by the model (disable-model-invocation)`,
        };
      }
      return { result: true };
    },

    async checkPermissions(input): Promise<PermissionResult> {
      const name = normalizeName(input.skill);
      const cmd = currentByName().get(name);
      // 找不到 → fail-closed 要权限 (validateInput 之外的兜底)。
      if (!cmd) {
        return {
          behavior: 'ask',
          message: `Execute skill: ${name}`,
          updatedInput: input,
        };
      }
      // safe-property allowlist：只用安全字段 → auto-allow。
      if (skillHasOnlySafeProperties(cmd)) {
        return { behavior: 'allow', updatedInput: input };
      }
      // 出现未知有意义字段 → fail-closed，退回 ask。
      return {
        behavior: 'ask',
        message: `Execute skill: ${name}`,
        updatedInput: input,
        decisionReason: { type: 'unsafe-skill-property' },
      };
    },

    async call(input): Promise<ToolResult<SkillToolOutput>> {
      const name = normalizeName(input.skill);
      const cmd = currentByName().get(name);
      if (!cmd) {
        throw new Error(`Unknown skill: ${name}`);
      }
      const prompt = cmd.getPrompt(input.args, vars);
      const allowedTools =
        cmd.allowedTools.length > 0 ? cmd.allowedTools : undefined;

      if (cmd.context === 'fork') {
        return {
          data: {
            success: true,
            commandName: name,
            status: 'forked',
            prompt,
            model: cmd.model,
            allowedTools,
          },
        };
      }

      // inline：把展开的 prompt 作为 newMessages 回灌 (host 续跑)。
      const msg: CoreEvent = {
        type: 'skill.prompt',
        payload: { skill: name, prompt },
        ts: Date.now(),
        source: SKILL_TOOL_NAME,
      };
      return {
        data: {
          success: true,
          commandName: name,
          status: 'inline',
          prompt,
          allowedTools,
          model: cmd.model,
        },
        newMessages: [msg],
      };
    },

    mapResult(output, toolUseId): CoreEvent {
      const content =
        output.status === 'forked'
          ? `Skill "${output.commandName}" dispatched (forked execution).`
          : `Launching skill: ${output.commandName}`;
      return {
        type: 'tool.result',
        payload: { toolUseId, content, status: output.status },
        ts: Date.now(),
        source: SKILL_TOOL_NAME,
      };
    },

    renderToolUseMessage(input) {
      const name = normalizeName(input.skill);
      return input.args ? `Skill(${name} ${input.args})` : `Skill(${name})`;
    },
  });

  // inputJSONSchema 做 live getter:buildRequest 每轮现读 → available 列表随源更新。
  //   (放 buildTool 之外,因为 buildTool 会 spread def 把取值冻结成静态值。)
  Object.defineProperty(tool, 'inputJSONSchema', {
    enumerable: true,
    configurable: true,
    get: computeSchema,
  });
  return tool;
}
