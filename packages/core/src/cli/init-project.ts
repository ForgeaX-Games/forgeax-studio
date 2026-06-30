/**
 * /init 子流程的【A 层底层能力】(019)—— host-callable 的「项目 onboarding 生成器」。
 *
 * `/init`:扫描当前项目 → 产出项目级 `AGENTS.md`
 * (或 `CLAUDE.md`)文档,让 agent 后续带着项目约定/结构/命令上下文工作。
 *
 * 本质 = 一段**预置 prompt 的 agent 子流程**:不引入任何新底层工具,而是复用已有
 * read_file / grep / glob / write_file,委托 `runSubagent` 在隔离上下文里跑一轮——
 * 让模型自己读项目结构、再用 write_file 把草稿落到项目根。
 *
 * 分层(见 todos/019、025):
 *   - 本文件 = **A 层**:纯函数,接收 provider/model/tools/toolContext + 项目根作入参,
 *     不进 tui/、不碰 serve.ts / host-context.ts(由集成方接线)。
 *   - 覆盖确认 UX(已存在 AGENTS.md 时是否覆盖)= **B 层**(配合 008 AskUserQuestion)。
 *     本层只把「是否已存在」探测成可读结果(`detectExistingAgentsDoc`),交由上层决策;
 *     `runInitProject` 自身**不**做确认弹窗,只把决策结果(force)透传进 prompt。
 *
 * Boundary(HOST 层):仅 core 相对 import + node:。
 */
import { resolve as resolvePath } from 'node:path';
import { runSubagent, type SubagentResult } from '../agent/subagent';
import type { AgentTool, ToolContext } from '../capability/types';
import type { LLMProvider } from '../provider/types';
import type { SandboxFs } from '../inject/types';

/** 候选项目文档文件名(优先级从高到低;首个存在者即视为「已有项目文档」)。 */
export const AGENTS_DOC_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** 默认输出文件名(无既有文档时写这个)。 */
export const DEFAULT_AGENTS_DOC = 'AGENTS.md';

/** 已存在文档探测结果。供 B 层(覆盖确认 UX)决策,本层不做弹窗。 */
export interface ExistingAgentsDoc {
  /** 命中的文件名(如 'AGENTS.md');未命中为 undefined。 */
  fileName?: string;
  /** 命中文件的绝对路径;未命中为 undefined。 */
  path?: string;
  /** 是否已存在项目文档。 */
  exists: boolean;
}

/**
 * 探测项目根是否已有 AGENTS.md / CLAUDE.md。
 *
 * 纯探测、零副作用:供上层决定「新建 / 覆盖 / 补充」(覆盖确认属 B 层 008)。
 * 任何读盘异常都按「不存在」兜底(防御式,生成流程不应因探测失败而中断)。
 */
export function detectExistingAgentsDoc(sandboxFs: SandboxFs, projectRoot: string): ExistingAgentsDoc {
  for (const name of AGENTS_DOC_CANDIDATES) {
    const abs = resolvePath(projectRoot, name);
    try {
      if (sandboxFs.existsSync(abs)) return { fileName: name, path: abs, exists: true };
    } catch {
      // 探测失败按未命中处理,继续看下一个候选。
    }
  }
  return { exists: false };
}

/** `runInitProject` 入参(由集成方从已装配的 HostContext 喂)。 */
export interface InitProjectOptions {
  provider: LLMProvider;
  model: string;
  /**
   * 子 loop 可用工具集 —— 必须含 read_file / grep / glob(读结构)与 write_file(落盘)。
   * 直接复用 `assembleCapabilities` 产出的 `tools`(集成方传入,本层不自己装配)。
   */
  tools: AgentTool[];
  /**
   * 子 loop 的 toolContext(承载 sandboxFs / terminal / cwd 等 host 注入句柄)。
   * read/write 工具经此打真 IO;不传则子 loop 拿到空 ctx(工具会自报缺句柄)。
   */
  toolContext?: Omit<ToolContext, 'signal'>;
  /** 项目根目录(扫描范围 + AGENTS.md 落盘位置)。默认 `process.cwd()`。 */
  projectRoot?: string;
  /** 输出文件名。默认 'AGENTS.md';上层可指向既有文件名以做「补充」。 */
  outputFileName?: string;
  /**
   * 覆盖决策:为 true 时 prompt 显式允许覆盖既有文档(B 层确认通过后透传)。
   * 缺省 false:prompt 指示模型在文件已存在时**保留并增量补充**而非整篇覆写。
   */
  force?: boolean;
  /** 子 loop 最大轮数(扫描多文件需要若干轮)。默认 24。 */
  maxTurns?: number;
  /** 透传给子 loop 的中断信号。 */
  signal?: AbortSignal;
}

/** `runInitProject` 结果:子 loop 终态 + 实际落盘的目标路径。 */
export interface InitProjectResult {
  /** 子 agent 子流程的原始结果(text/terminalReason/turns/toolCalls)。 */
  subagent: SubagentResult;
  /** 期望落盘的 AGENTS.md 绝对路径(由模型经 write_file 写入)。 */
  targetPath: string;
  /** 输出文件名。 */
  fileName: string;
  /** 跑前探测到的既有文档状态(供上层据此展示「新建/覆盖」)。 */
  existing: ExistingAgentsDoc;
}

/** init 子 agent 的角色首段(system leading)。 */
const INIT_LEADING =
  'You are forgeax-core 的项目 onboarding 助手。你的唯一职责:扫描当前项目并产出一份高质量的 ' +
  'AGENTS.md 项目说明文档,供后续 AI agent 带着项目上下文工作。';

/**
 * 构造 init 子流程的预置 prompt(user 输入)。
 *
 * 显式约束模型用 read_file/grep/glob 探明结构,再用 write_file 把成品写到 `targetPath`;
 * 并据 `force`/既有文档状态指示「整篇覆写」抑或「保留并增量补充」。导出便于上层定制 + 单测断言。
 */
export function buildInitPrompt(args: {
  targetPath: string;
  fileName: string;
  projectRoot: string;
  existing: ExistingAgentsDoc;
  force: boolean;
}): string {
  const { targetPath, fileName, projectRoot, existing, force } = args;
  const overwriteClause = existing.exists
    ? force
      ? `项目根已存在 ${existing.fileName}。已获授权覆盖:用更准确的内容整篇重写 ${fileName}。`
      : `项目根已存在 ${existing.fileName}。未获覆盖授权:先 read_file 读出其现有内容,在其基础上增量补充缺失部分,保留作者已有约定,不要整篇覆写。`
    : `项目根尚无项目文档,你将新建 ${fileName}。`;
  return [
    `请为位于 ${projectRoot} 的项目生成一份 ${fileName}。`,
    '',
    '步骤:',
    '1. 用 glob / grep / read_file 探明项目结构:顶层目录布局、技术栈(语言/框架/包管理)、',
    '   入口文件、构建/测试/启动命令(从 package.json、README、Makefile、脚本等推断)。',
    '2. 提炼项目约定与重要上下文:代码风格、目录职责、关键模块、不要做的事。',
    '3. 把成品文档用 write_file 工具写到绝对路径:' + targetPath,
    '',
    overwriteClause,
    '',
    `${fileName} 至少应包含以下小节:`,
    '- 项目是什么(一句话定位)',
    '- 项目结构概要(顶层目录职责)',
    '- 常用命令(安装 / 构建 / 测试 / 启动)',
    '- 项目约定 / 注意事项',
    '',
    '务必真的调用 write_file 把文件落盘到上面的绝对路径;不要只在回答里贴文档内容。',
    '写完后用一句话总结你生成了什么。',
  ].join('\n');
}

/**
 * 跑一轮 init 子流程:预置 prompt → `runSubagent` 隔离 loop → 模型自行 read 结构 + write AGENTS.md。
 *
 * 返回子 loop 终态 + 目标路径;**落盘由模型经 write_file 工具完成**(本函数不直接写盘),
 * 这样与「让 agent 用已有工具」的设计一致,且无需新底层能力。
 *
 * 覆盖确认(008)在 B 层完成后,集成方据结果设 `force` 再调本函数;本层不弹窗。
 */
export async function runInitProject(opts: InitProjectOptions): Promise<InitProjectResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const fileName = opts.outputFileName ?? DEFAULT_AGENTS_DOC;
  const targetPath = resolvePath(projectRoot, fileName);

  // 探测既有文档(供结果回报 + prompt 措辞);需要 sandboxFs 时从 toolContext 取。
  const sandboxFs = opts.toolContext?.sandboxFs as SandboxFs | undefined;
  const existing = sandboxFs ? detectExistingAgentsDoc(sandboxFs, projectRoot) : { exists: false };

  const prompt = buildInitPrompt({
    targetPath,
    fileName,
    projectRoot,
    existing,
    force: opts.force ?? false,
  });

  const subagent = await runSubagent(
    {
      input: prompt,
      model: opts.model,
      tools: opts.tools,
      leadingSystemText: INIT_LEADING,
      maxTurns: opts.maxTurns ?? 24,
    },
    {
      provider: opts.provider,
      toolContext: opts.toolContext,
      signal: opts.signal,
    },
  );

  return { subagent, targetPath, fileName, existing };
}
