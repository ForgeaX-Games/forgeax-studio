/**
 * seed-session —— 合成一个 per-session WAL(`events.jsonl`),用脚本预置一段足够长的
 * 对话历史,好让「`--resume` 这个会话 + 发一条消息」一上来就越过压缩水位、触发 compaction。
 *
 * 写出的事件形状严格对齐 loop 真正落进 store 的那几类(见 history/llm-fold-adapter.ts):
 *   - `user_prompt.submit`  payload `{ prompt, turn }`        → fold 成一条 user 消息
 *   - `assistant.message`   payload `{ role, content[] }`     → fold 成一条 assistant 消息
 * 磁盘布局对齐 cli/event-store-fs.ts:`<sessionsDir>/<sessionId>/events.jsonl`,每行一个
 * CoreEvent JSON。resume 时 `foldSessionHistory` 全量回放重建历史。
 *
 * 触发数学(与 context/deterministic-compact.ts 的 estimateTokens 一致:~chars/4):
 *   水位 effective = min(window, FORGEAX_COMPACT_WINDOW) - 20000;emergency = effective×0.92。
 *   把窗口用 `FORGEAX_COMPACT_WINDOW` 钳小(如 22000 → effective 2000、emergency 1840),
 *   再 seed 出 estTokens > emergency 的历史即可确定性触发(无需造 660KB 真实历史)。
 *
 * 既是**库**(导出 `seedSession`,供 e2e 复用,SSOT 一个 builder)又是**可跑脚本**:
 *   bun scripts/seed-session.ts --dir ./.forgeax/sessions --id demo --turns 20
 *
 * Boundary(脚本层,不在 src/ 内,不受 core 边界约束):node: + src 相对 import。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreEventType } from '../src/events/events';

/** loop 自吐的 assistant 会话事件类型(非 CoreEventType 成员,见 agent.ts 与
 *  history/llm-fold-adapter.ts 的 ASSISTANT_MESSAGE_TYPE)。 */
const ASSISTANT_MESSAGE_TYPE = 'assistant.message';

export interface SeedOpts {
  /** 会话 WAL 根目录(= --sessions-dir / FORGEAX_SESSIONS_DIR)。 */
  sessionsDir: string;
  /** 会话 id(= --resume 入参,也是 WAL 子目录名)。 */
  sessionId: string;
  /** 对话轮数(每轮 = 1 条 user + 1 条 assistant)。默认 20。 */
  turns?: number;
  /** 每条 user prompt 的字符数。默认 200。 */
  userChars?: number;
  /** 每条 assistant 文本的字符数。默认 800。 */
  assistantChars?: number;
}

export interface SeedResult {
  /** 写出的 WAL 文件绝对路径。 */
  file: string;
  /** 写入的事件条数(= turns × 2)。 */
  events: number;
  /** fold 后历史的粗估 token(镜像 estimateTokens:~chars/4),供调用方对比水位。 */
  estTokens: number;
}

/**
 * 写出合成 WAL。返回路径 + 事件数 + 粗估 token。幂等:整文件覆盖(非 append),
 * 重复跑同参得到同一份历史(架构原则 §6 Idempotency)。
 */
export function seedSession(opts: SeedOpts): SeedResult {
  const turns = opts.turns ?? 20;
  const userChars = opts.userChars ?? 200;
  const assistantChars = opts.assistantChars ?? 800;

  const dir = join(opts.sessionsDir, opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');

  const lines: string[] = [];
  let chars = 0; // 镜像 estimateTokens:user content 是字符串记长度,assistant content 是数组记 JSON 长度
  for (let i = 0; i < turns; i++) {
    const prompt = `turn ${i} user: ` + 'u'.repeat(userChars);
    lines.push(JSON.stringify({ type: CoreEventType.UserPromptSubmit, payload: { prompt, turn: i }, ts: 0 }));
    chars += prompt.length;

    const content = [{ type: 'text', text: `turn ${i} assistant: ` + 'a'.repeat(assistantChars) }];
    lines.push(JSON.stringify({ type: ASSISTANT_MESSAGE_TYPE, payload: { role: 'assistant', content }, ts: 0 }));
    chars += JSON.stringify(content).length;
  }
  writeFileSync(file, lines.join('\n') + '\n');

  return { file, events: lines.length, estTokens: Math.ceil(chars / 4) };
}

// ─── CLI 包装(手动用)──────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  const num = (flag: string, dflt: number): number => {
    const v = get(flag);
    return v != null ? Number.parseInt(v, 10) : dflt;
  };

  const sessionsDir = get('--dir', `${process.cwd()}/.forgeax/sessions`)!;
  const sessionId = get('--id', 'demo')!;
  const r = seedSession({
    sessionsDir,
    sessionId,
    turns: num('--turns', 20),
    userChars: num('--user-chars', 200),
    assistantChars: num('--assistant-chars', 800),
  });
  process.stdout.write(
    `seeded ${r.events} events → ${r.file}\n` +
      `~${r.estTokens} est tokens (chars/4). ` +
      `resume + send a message with a clamped window to trigger compaction, e.g.:\n` +
      `  FORGEAX_COMPACT_WINDOW=22000 bun src/cli/main.ts --demo --no-memory ` +
      `--sessions-dir ${sessionsDir} --resume ${sessionId} -p "continue"\n`,
  );
}
