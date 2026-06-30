/**
 * Builtin ask tool (②) — `AskUserQuestion`.
 *
 * 让 agent 能向用户发**结构化多选问题**消歧(选方案 A/B、确认需求),而非只能用
 * 权限闸做 yes/no(AskUserQuestion)。一次最多几个
 * 问题,每问 2–4 个选项,支持多选(multiSelect),用户可走 "Other" 自填。
 *
 * 接缝:经 host 注入的 `AskQuestionFn`(inject §4.10)。host 把它挂在 `ToolContext`
 * 上的开放字段 `askQuestion`(与 terminal/sandboxFs/shellRegistry 同款约定,types.ts:31)。
 * 这区别于权限审批回调 `askUser`(yes/no);提问与审批同信道、不同 payload。
 * **无 host 实现 → 优雅降级**:不抛断流,返回一个错误结果提示需 host 接线。
 *
 * core 自身不渲染、不阻塞;问题怎么弹给用户由 host 决定(server 走 EventBus→WS
 * card-pop,CLI TUI 走进程内交互浮层 013)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { AskQuestionFn, AskQuestionItem, AskQuestionAnswer } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';

// ─── 集成者约定:ctx 上的注入句柄 ────────────────────────────────────────────
//
// 与 file-tools / shell-tools 对称:host 把 inject 的 `AskQuestionFn` 挂在
// ctx.askQuestion 上。

/** ToolContext 上 host 注入的提问句柄(开放字段约定)。 */
export interface AskDeps {
  askQuestion?: AskQuestionFn;
}

/** 从 ctx 取 AskQuestionFn;缺失返回 undefined(由 call 做优雅降级,不 loud throw)。 */
export function getAskQuestion(ctx: ToolContext): AskQuestionFn | undefined {
  return (ctx as ToolContext & AskDeps).askQuestion;
}

// ─── AskUserQuestion ───────────────────────────────────────────────────────────

/** 工具入参的单个候选项。 */
export interface AskUserQuestionOptionInput {
  label: string;
  description?: string;
}

/** 工具入参的单条问题。 */
export interface AskUserQuestionItemInput {
  question: string;
  /** 短标签(UI 小标题)。 */
  header: string;
  /** 候选项:可为对象 `{label, description?}`,也容错裸字符串(模型常给 `["A","B"]`)。 */
  options: Array<string | AskUserQuestionOptionInput>;
  multiSelect?: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItemInput[];
}

export interface AskUserQuestionResultEntry {
  question: string;
  header: string;
  /** 用户选中的 label 列表(单选时长度 1;自填 Other 文本也落在此数组)。 */
  selected: string[];
  /** 用户走 "Other" 自填时的原始文本(可选)。 */
  other?: string;
}

export interface AskUserQuestionOutput {
  answers: AskUserQuestionResultEntry[];
  /** 无 host 提问实现时的优雅降级标记(answers 为空)。 */
  unsupported?: boolean;
  /** 降级 / 校验失败时的提示文案。 */
  message?: string;
}

/**
 * 归一化模型常见变体(不抛,留给 validateInput 做最终严格校验)。装在 `inputSchema.parse`
 * 上,使 dispatch 走本修复路径而**跳过通用 walker**(dispatch.ts:135 仅在无 parse 时跑
 * walker);model-facing 的 `inputJSONSchema` 仍是严格三键必填,契约不削弱,只是执行期容错。
 *
 * 修的是:模型偶尔把「问题正文」塞进 `header` 而漏掉 `question`(或反之)——与已支持的
 * 「options 写成裸字符串」同类的模型变体。一律软兜:
 *   - question 缺失/空 但 header 在 → question = header
 *   - header 缺失/空 但 question 在 → header = question(截断,保持「短标签」语义)
 *   - options 不动(由 validateInput 归一裸字符串)
 * 无法兜的(两者皆空、questions 非数组)原样回,交 validateInput loud 报错。
 */
function repairInput(raw: unknown): AskUserQuestionInput {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { questions?: unknown }).questions)) {
    return raw as AskUserQuestionInput; // 不可兜 → 交 validateInput 报错
  }
  const src = raw as Record<string, unknown> & { questions: unknown[] };
  const questions = src.questions.map((q) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return q;
    const item = { ...(q as Record<string, unknown>) };
    const question = typeof item.question === 'string' ? item.question : '';
    const header = typeof item.header === 'string' ? item.header : '';
    if (question === '' && header !== '') item.question = header;
    else if (header === '' && question !== '') item.header = question.slice(0, 24);
    return item;
  });
  return { ...src, questions } as AskUserQuestionInput;
}

/** 最小入参校验(core boundary 禁 ajv/zod,自实现)。失败抛 Error,dispatch 归 validation 类。 */
function validateInput(input: AskUserQuestionInput): AskQuestionItem[] {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) {
    throw new Error('AskUserQuestion: input.questions must be a non-empty array');
  }
  if (input.questions.length === 0) {
    throw new Error('AskUserQuestion: input.questions must contain at least one question');
  }
  return input.questions.map((q, i) => {
    if (!q || typeof q !== 'object') {
      throw new Error(`AskUserQuestion: questions[${i}] must be an object`);
    }
    if (typeof q.question !== 'string' || q.question === '') {
      throw new Error(`AskUserQuestion: questions[${i}].question must be a non-empty string`);
    }
    if (typeof q.header !== 'string' || q.header === '') {
      throw new Error(`AskUserQuestion: questions[${i}].header must be a non-empty string`);
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      throw new Error(`AskUserQuestion: questions[${i}].options must be a non-empty array`);
    }
    const options = q.options.map((o, j) => {
      // 容错:模型常把选项写成裸字符串 ["A","B"](而非 [{label:"A"}])→ 归一化成 {label}。
      if (typeof o === 'string') {
        if (o === '') {
          throw new Error(`AskUserQuestion: questions[${i}].options[${j}] must be a non-empty string`);
        }
        return { label: o };
      }
      if (!o || typeof o !== 'object' || typeof o.label !== 'string' || o.label === '') {
        throw new Error(`AskUserQuestion: questions[${i}].options[${j}].label must be a non-empty string`);
      }
      const opt: { label: string; description?: string } = { label: o.label };
      if (typeof o.description === 'string') opt.description = o.description;
      return opt;
    });
    const item: AskQuestionItem = { question: q.question, header: q.header, options };
    if (q.multiSelect === true) item.multiSelect = true;
    return item;
  });
}

/** host 的 answers(与 questions 同序)→ 工具结果(回灌进上下文)。 */
function toEntries(questions: AskQuestionItem[], answers: AskQuestionAnswer[]): AskUserQuestionResultEntry[] {
  return questions.map((q, i) => {
    const a = answers[i];
    const selected = a && Array.isArray(a.selected) ? a.selected : [];
    const entry: AskUserQuestionResultEntry = { question: q.question, header: q.header, selected };
    if (a && typeof a.other === 'string') entry.other = a.other;
    return entry;
  });
}

/**
 * AskUserQuestion:向用户发结构化多选问题消歧。经注入的 askQuestion 接缝向 host
 * 转发,host 收集选择后回灌。无 host 实现 → 优雅降级(unsupported,提示需接线)。
 */
export function askUserQuestionTool(): AgentTool<AskUserQuestionInput, AskUserQuestionOutput> {
  return buildTool<AskUserQuestionInput, AskUserQuestionOutput>({
    name: 'AskUserQuestion',
    aliases: ['ask_user_question'],
    searchHint: 'ask the user a structured multiple-choice question to disambiguate',
    // 容错入参修复(挂 parse):dispatch 据此跳过通用 schema walker,改走 repairInput 软兜
    // 模型变体(漏 question/header)。下方 inputJSONSchema 仍是严格契约(发给模型),不削弱。
    inputSchema: {
      parse: (x): AskUserQuestionInput => repairInput(x),
      safeParse: (x) => ({ success: true, data: repairInput(x) }),
    },
    inputJSONSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask the user (1–4 questions).',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description:
                  'REQUIRED. The complete question to ask the user, as a full sentence. Should be clear, ' +
                  'specific, and end with a question mark. Example: "Which rendering backend should we use?" ' +
                  'This is the main prompt text shown to the user — it is NOT the same as `header`, and must ' +
                  'always be provided in addition to `header`.',
              },
              header: {
                type: 'string',
                description:
                  'REQUIRED. A very short label (≈1–3 words, max ~12 chars) displayed as a chip/tag above the ' +
                  'question — NOT the question itself. Examples: "Renderer", "Auth method", "Approach". Do not ' +
                  'put the full question here; the full sentence goes in `question`.',
              },
              options: {
                type: 'array',
                description:
                  'The available choices (2–4). Each option is an object {label, description?}; a plain string ' +
                  'is also accepted and treated as its label. Each choice should be distinct and mutually ' +
                  'exclusive (unless multiSelect). Do NOT add an "Other" option — the UI always offers a ' +
                  'free-text "Other" entry automatically.',
                items: {
                  // 容错并存:对象 {label, description?} 或裸字符串(模型常给后者)。
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        label: {
                          type: 'string',
                          description: 'The concise display text (1–5 words) the user selects; returned as the choice.',
                        },
                        description: {
                          type: 'string',
                          description: 'Optional helper text explaining this option or its trade-offs.',
                        },
                      },
                      required: ['label'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'Set true to let the user select multiple options instead of just one. Defaults to false.',
              },
            },
            required: ['question', 'header', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    maxResultSizeChars: 8_000,
    // 提问会向用户索取输入(交互式副作用) → 非只读 / 非并发安全(fail-closed,不 override 谓词)。
    async call(input, ctx): Promise<{ data: AskUserQuestionOutput }> {
      const questions = validateInput(input);
      const ask = getAskQuestion(ctx);
      // 优雅降级:host 未接线 → 不断流,回灌一条 unsupported 结果让模型改走别的路。
      if (!ask) {
        return {
          data: {
            answers: [],
            unsupported: true,
            message:
              'AskUserQuestion is not wired by the host (no askQuestion injected). Proceed without asking, or state your assumption explicitly.',
          },
        };
      }
      const answers = await ask(questions, ctx.signal);
      return { data: { answers: toEntries(questions, answers) } };
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: output.unsupported === true,
          answers: output.answers,
          ...(output.unsupported ? { unsupported: true } : {}),
          ...(output.message ? { message: output.message } : {}),
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) =>
      `AskUserQuestion (${Array.isArray(input?.questions) ? input.questions.length : 0} question(s))`,
  });
}
