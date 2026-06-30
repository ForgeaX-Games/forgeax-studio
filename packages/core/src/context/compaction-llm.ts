/**
 * LLM-backed compaction strategy (C7) — the §12 ③ injectable strategy that
 * produces a *real* conversation summary instead of the deterministic
 * placeholder from `FoldCompactionStrategy`.
 *
 * 设计稿: 最终实现方案 §12 (CTX 拥有 compaction 引擎；真摘要 strategy 作 ③ 注入)。
 *   - shouldCompact —— 同 auto-compact 水位:tokenCount 越过 autoCompactThreshold
 *     即触发(与 FoldCompactionStrategy 一致,见 compaction.ts)。
 *   - compact —— 调注入的 `summarize(messages) → Promise<string>` 产摘要文本,
 *     包成一条 user 摘要消息(`getCompactUserSummaryMessage` 的前缀模板),
 *     再把它与「保留尾部 N 条」拼成 replacement,覆盖 [coveredFrom..coveredTo]。
 *   - PTL retry —— summarize 命中 prompt-too-long(error.message 以
 *     PROMPT_TOO_LONG_MESSAGE 开头)时,从头部丢弃最旧消息(truncateHead)后重试,
 *     最多 MAX_PTL_RETRIES(=3)次。
 *   - getCompactPrompt —— 摘要 prompt 模板,9 段(BASE_COMPACT_PROMPT)。
 *
 * core 不内置任何 LLM 调用:`summarize` 由 host 用 C4 provider 实现并注入
 * (留注入函数,见 LLMCompactionConfig.summarize)。core 只负责水位判定、范围计算、
 * PTL 重试编排与摘要消息成形。
 *
 * 与 ledger fold 的契合(skip-and-replace，§3.8.3 / history/ledger.ts):
 *   compact() 产 {replacement, coveredFrom, coveredTo};host 据此发一条
 *   CompactionApplied(range = byIndex[coveredFrom..coveredTo]，replacement = 摘要
 *   user 消息)。foldEvents 在该 range 第一条吐 replacement,其余跳过(可逆、审计友好)。
 *   "保留尾部 N 条"由 caller 决定切片:本 strategy 只压缩传入的 messages 前缀,
 *   把最近 messagesToKeep 条原样追加进 replacement 之外不动 —— 见 compact() 注释。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import type { ProviderMessage, LLMProvider, ProviderRequest } from '../provider/types';
import type { CompactionStrategy, Watermarks } from './types';
import type { SummaryScenario, CompactSummarize } from './compaction-types';
import { startsWithToolResult } from './tool-pairing';
import { isPromptTooLong } from './reactive-recovery';

/** Max prompt-too-long retries for the compaction summary call. */
export const MAX_PTL_RETRIES = 3;

/** Synthetic marker prepended after a head-truncation PTL retry. */
export const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]';

/** Default number of recent messages preserved verbatim past the summary
 *  (a recent tail is kept post-compact; host may override via config). */
export const DEFAULT_MESSAGES_TO_KEEP = 0;

// ─── summarize injection ──────────────────────────────────────────────────────

/** Host-provided summarizer: turn a slice of messages into a summary string.
 *  Implemented by the host using a C4 provider (core never calls an LLM itself).
 *  Throw an Error whose `message` starts with PROMPT_TOO_LONG_MESSAGE to signal
 *  the compact request itself overflowed — the strategy will head-truncate and
 *  retry. Any other throw aborts compaction (propagated to the caller). */
export type Summarize = (messages: readonly unknown[]) => Promise<string>;

export interface LLMCompactionConfig {
  /** Host summarizer (required). */
  summarize: Summarize;
  /** Recent messages to preserve verbatim outside the summarized range.
   *  Default 0 — caller typically slices the prefix to compact and keeps the
   *  tail itself; set > 0 to have the strategy carve the tail internally. */
  messagesToKeep?: number;
  /** Optional custom compaction instructions appended to the summary prompt. */
  customInstructions?: string;
  /** Optional transcript path surfaced in the summary message footer. */
  transcriptPath?: string;
}

// ─── prompt template (BASE_COMPACT_PROMPT, 9 sections) ───────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.';

/** Partial-compaction preamble (#2):仅压最近一段,更早的保留不动。 */
const PARTIAL_COMPACT_PREAMBLE = `Your task is to summarize ONLY the RECENT portion of the conversation shown below. Earlier messages are being kept intact and do NOT need summarizing — focus solely on what was discussed, learned and accomplished in these recent messages. Use the same 9-section structure below.

`;

/** Pre-message-compaction preamble (#2/#11):压完后紧接一条新的用户消息,摘要要让模型无缝接上。 */
const PRE_MESSAGE_COMPACT_PREAMBLE = `Your task is to summarize the conversation so far. This summary will be placed at the start of a continuing session and a NEW user message will follow right after it (you do not see it here). Summarize thoroughly using the 9-section structure below so the work can continue seamlessly once the new message arrives.

`;

/** Build the compaction summary prompt (`getCompactPrompt`).
 *  按 scenario 选模板(#2):
 *   - 'full'        —— 全量 9 段(默认,行为同旧)。
 *   - 'partial'     —— 仅压最近段(保旧)。
 *   - 'pre-message' —— 压后紧跟新用户消息的预压场景。
 *  统一裹 no-tools preamble/trailer;可选 customInstructions 追加。 */
export function getCompactPrompt(scenario: SummaryScenario = 'full', customInstructions?: string): string {
  const scenarioPreamble =
    scenario === 'partial'
      ? PARTIAL_COMPACT_PREAMBLE
      : scenario === 'pre-message'
        ? PRE_MESSAGE_COMPACT_PREAMBLE
        : '';
  let prompt = NO_TOOLS_PREAMBLE + scenarioPreamble + BASE_COMPACT_PROMPT;
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

// ─── summary formatting (formatCompactSummary / userSummaryMessage) ─

/** Strip the <analysis> scratchpad and unwrap the <summary> block into readable
 *  text (`formatCompactSummary`). Falls back to the raw text when no tags. */
export function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const m = out.match(/<summary>([\s\S]*?)<\/summary>/);
  if (m) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(m[1] ?? '').trim()}`);
  }
  out = out.replace(/\n\n+/g, '\n\n');
  return out.trim();
}

/** Wrap a formatted summary into the post-compact continuation user message
 *  (`getCompactUserSummaryMessage`). */
export function getCompactUserSummaryMessage(summary: string, transcriptPath?: string): string {
  const formatted = formatCompactSummary(summary);
  let base = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formatted}`;
  if (transcriptPath) {
    base += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
  }
  return base;
}

// ─── PTL head-truncation (truncateHeadForPTLRetry) ──────────────

/** Fraction of the oldest messages dropped per PTL retry. Halving (vs the old
 *  20%) lets a summary prompt that overflows by several× the window converge
 *  within MAX_PTL_RETRIES instead of throwing: 0.5³ ≈ 0.125, so a ~5× overflow
 *  recovers in 3 retries. We only ever drop the OLDEST turns, and only when the
 *  summary prompt itself overflows — context loss there is unavoidable. */
export const PTL_HEAD_DROP_FRACTION = 0.5;

/** Drop the oldest ~50% of messages and prepend a synthetic marker so the next
 *  retry summarizes a smaller prefix. Returns null when nothing can be dropped
 *  without emptying the set (caller then gives up).
 *
 *  Provider-neutral simplification of api-round grouping: core treats the
 *  message list as flat. The marker is a `{ role:'user', content }` shape so the
 *  truncated prefix still starts with a user turn (API requires role=user first).
 */
export function truncateHeadForPTLRetry(messages: readonly unknown[]): unknown[] | null {
  // Strip our own marker from a prior retry so progress isn't stalled.
  const input =
    messages.length > 0 && isMarkerMessage(messages[0]) ? messages.slice(1) : messages.slice();
  if (input.length < 2) return null;

  const dropCount = Math.min(
    Math.max(1, Math.floor(input.length * PTL_HEAD_DROP_FRACTION)),
    input.length - 1,
  );
  const sliced = input.slice(dropCount);
  return [{ role: 'user', content: PTL_RETRY_MARKER }, ...sliced];
}

function isMarkerMessage(m: unknown): boolean {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { role?: unknown }).role === 'user' &&
    (m as { content?: unknown }).content === PTL_RETRY_MARKER
  );
}

// ─── strategy ─────────────────────────────────────────────────────────────────

/**
 * LLM-backed compaction strategy.
 *
 * shouldCompact: token-watermark gate identical to auto-compact / the default
 * fold strategy — fire once tokenCount reaches autoCompactThreshold.
 *
 * compact: summarize the compactable prefix via the injected `summarize`, retry
 * with head-truncation on prompt-too-long (≤ MAX_PTL_RETRIES), then build a
 * replacement covering that prefix. When `messagesToKeep > 0` the trailing N
 * messages are excluded from the summarized range (preserved verbatim by the
 * caller) and the covered range stops before them.
 */
export class LLMCompactionStrategy implements CompactionStrategy {
  readonly name = 'llm';

  private readonly summarize: Summarize;
  private readonly messagesToKeep: number;
  private readonly customInstructions?: string;
  private readonly transcriptPath?: string;

  constructor(config: LLMCompactionConfig) {
    if (typeof config.summarize !== 'function') {
      throw new Error('LLMCompactionStrategy requires a summarize() function (host injects it)');
    }
    this.summarize = config.summarize;
    this.messagesToKeep = Math.max(0, config.messagesToKeep ?? DEFAULT_MESSAGES_TO_KEEP);
    this.customInstructions = config.customInstructions;
    this.transcriptPath = config.transcriptPath;
  }

  shouldCompact(tokenCount: number, marks: Watermarks): boolean {
    return tokenCount >= marks.autoCompactThreshold;
  }

  async compact(
    messages: unknown[],
  ): Promise<{ replacement: unknown; coveredFrom: number; coveredTo: number }> {
    if (messages.length === 0) {
      throw new Error('Not enough messages to compact.');
    }

    // Carve the recent tail to preserve (messagesToKeep). The summarized
    // range covers only the prefix; the tail stays verbatim for the caller.
    const keep = Math.min(this.messagesToKeep, Math.max(0, messages.length - 1));
    let summarizeUpTo = messages.length - keep; // exclusive end of compacted prefix
    // ★ 边界安全(adjustIndexToPreserveAPIInvariants):保留尾部不得以孤儿
    //   tool_result 起头(其 tool_use 已被摘进 summary)。边界回退,把整对一起留进尾部,
    //   不劈开、不丢 tool_result。至少摘 1 条。
    while (
      summarizeUpTo > 1 &&
      summarizeUpTo < messages.length &&
      startsWithToolResult(messages[summarizeUpTo] as ProviderMessage)
    ) {
      summarizeUpTo--;
    }
    const toSummarize = messages.slice(0, summarizeUpTo);
    if (toSummarize.length === 0) {
      throw new Error('Not enough messages to compact.');
    }

    const summary = await this.runSummarizeWithPTLRetry(toSummarize);

    const replacement = {
      role: 'user' as const,
      content: getCompactUserSummaryMessage(summary, this.transcriptPath),
      // markers so downstream can recognize a real LLM summary message.
      _compactionSummary: true,
      _coveredCount: toSummarize.length,
    };

    return { replacement, coveredFrom: 0, coveredTo: summarizeUpTo - 1 };
  }

  /** Call summarize, head-truncating + retrying on prompt-too-long up to
   *  MAX_PTL_RETRIES. */
  private async runSummarizeWithPTLRetry(messages: readonly unknown[]): Promise<string> {
    let current = messages;
    let attempts = 0;
    for (; ;) {
      try {
        return await this.summarize(current);
      } catch (err) {
        if (!isPromptTooLong(err)) throw err;
        attempts++;
        const truncated = attempts <= MAX_PTL_RETRIES ? truncateHeadForPTLRetry(current) : null;
        if (!truncated) {
          throw err instanceof Error
            ? err
            : new Error('Conversation too long — compaction failed.');
        }
        current = truncated;
      }
    }
  }
}

// ─── provider-backed summarize / compaction(host 复用;干净律:用注入 provider,非硬编码 LLM)──

/** 用注入 provider 跑摘要(streamCompactSummary,maxTurns:1)。
 *  self-limit(#3):tools 为空(不会再调工具/触发子压缩)+ maxOutputTokens 固定上限,
 *  单次非 agentic 调用。`scenario` 选 prompt 模板(#2)。 */
export function makeProviderSummarize(
  provider: LLMProvider,
  model: string,
  scenario: SummaryScenario = 'full',
): Summarize {
  return async (messages) => {
    const req: ProviderRequest = {
      model,
      system: [{ type: 'text', text: getCompactPrompt(scenario) }],
      tools: [], // self-limit:无工具 → 摘要不会再触发任何工具/递归压缩
      messages: [{ role: 'user', content: messages.map((m) => JSON.stringify(m)).join('\n') }],
      maxOutputTokens: 4096,
    };
    let text = '';
    for await (const ev of provider.stream(req, { signal: new AbortController().signal })) {
      if (ev.type === 'assistant') {
        const content = (ev.message as { content?: Array<{ type: string; text?: string }> })?.content;
        if (Array.isArray(content)) for (const b of content) if (b.type === 'text' && b.text) text += b.text;
      }
    }
    return text;
  };
}

/** ★ Compaction V2 摘要器(管线版,带 scenario)——生产注入点直接喂给
 *  `compactionV2.summarize`。与 `makeProviderSummarize` 同源,差别仅在 scenario
 *  由**调用时**传入(管线据 CompactType 选 full / pre-message),core 仍不自调 LLM
 *  (走注入 provider)。 */
export function makeProviderCompactSummarize(
  provider: LLMProvider,
  model: string,
): CompactSummarize {
  return (messages, scenario) => makeProviderSummarize(provider, model, scenario)(messages);
}