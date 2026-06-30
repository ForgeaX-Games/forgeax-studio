/**
 * CLI host bits — host 侧具体实现,喂给 core 的注入接缝:
 *   - makeSpawnSyncHookRunner:settings-hook 的**同步**命令执行器(Bun.spawnSync)。
 *     约定:hook 进程 exit code 2 = block;stdout 若是 JSON {decision,reason,modify} 亦解析。
 *   - makeHttpSearchBackend:web_search 后端 —— POST {query} 到一个 HTTP 端点拿结果。
 *   - makeAskUser:交互式权限回路(--yes 全允许;否则非交互一律 deny,fail-closed)。
 *
 * 这些是 cli→core 方向的 host 实现,core/src 机制层不依赖本文件(干净律不破)。
 * Boundary: 仅 core 相对 + node:/Bun 全局。
 */
import type { CoreEvent } from '../events/types';
import type { HookDecision, HookCommandRunner } from '../capability/hooks/from-settings';
import { parseHookOutput, eventToHookInput } from '../capability/hooks/protocol';
import type { WebSearchBackend, WebSearchResult } from '../capability/builtin-tools/web-tools';
import type { AskUserFn } from '../agent/dispatch';

/** 默认 hook 命令超时(ms),60s;可经 `FORGEAX_HOOK_TIMEOUT_MS` 覆写(>0)。 */
function hookTimeoutMs(): number {
  const raw = Number(process.env.FORGEAX_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * 用 Bun.spawnSync 同步跑 hook 命令。**全量** hook 协议:
 *  - stdin = wire JSON(eventToHookInput);
 *  - stdout JSON 经 `parseHookOutput` 解析:`decision/block` · `continue`(=false 停轮) ·
 *    `systemMessage` · `hookSpecificOutput.additionalContext` · `permissionDecision`(allow/deny/ask);
 *  - 额外支持 forgeax 扩展键 `modify`(对事件做 shallow patch,wire 协议之外);
 *  - exit code 2 = block(reason 取 stderr);
 *  - **超时 / 非 JSON / 空输出 → fail-open 放行**(坏 hook 不毒化总线)。
 */
export function makeSpawnSyncHookRunner(): HookCommandRunner {
  return (command: string, event: CoreEvent): HookDecision | void => {
    const wireInput = JSON.stringify(eventToHookInput(event));
    let res: ReturnType<typeof Bun.spawnSync>;
    try {
      res = Bun.spawnSync(['sh', '-c', command], {
        env: { ...process.env, FORGEAX_HOOK_EVENT: JSON.stringify(event) },
        stdin: new TextEncoder().encode(wireInput),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: hookTimeoutMs(),
      });
    } catch {
      return; // spawn 失败 → fail-open
    }
    // 超时:Bun 杀进程,exitCode 为 null / 带 signal → fail-open(不阻塞总线)。
    if (res.exitCode == null && res.signalCode != null) return;

    const stdout = res.stdout ? new TextDecoder().decode(res.stdout).trim() : '';
    const stderr = res.stderr ? new TextDecoder().decode(res.stderr).trim() : '';

    // stdout JSON 决议(advanced hook output)经全量解析器。
    const decision: HookDecision = parseHookOutput(stdout);
    // forgeax 扩展:`modify`(wire 协议之外的 shallow patch)单独取。
    if (stdout.startsWith('{')) {
      try {
        const j = JSON.parse(stdout) as { modify?: Partial<CoreEvent> };
        if (j.modify && typeof j.modify === 'object') decision.modify = j.modify;
      } catch {
        /* parseHookOutput 已 fail-open;此处忽略 */
      }
    }
    // exit code 2 = block,reason 取 stderr(stdout 未显式 block 时)。
    if (res.exitCode === 2 && !decision.block) {
      decision.block = true;
      if (decision.reason == null) decision.reason = stderr || `hook blocked (exit 2)`;
    }
    // 全空决议 → 放行(返回 void 与 {} 等价,但 void 更省)。
    return Object.keys(decision).length > 0 ? decision : undefined;
  };
}

/** web_search 后端:POST {query} 到 url,期望返回 `{results:[{title,url,snippet}]}` 或裸数组。 */
export function makeHttpSearchBackend(url: string): WebSearchBackend {
  return async (query: string, signal?: AbortSignal): Promise<WebSearchResult[]> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    });
    if (!res.ok) throw new Error(`search backend ${res.status}`);
    const data = (await res.json()) as { results?: WebSearchResult[] } | WebSearchResult[];
    return Array.isArray(data) ? data : (data.results ?? []);
  };
}

/** 交互式权限:approveAll(--yes)→ 全放行;否则非交互一律 deny(fail-closed)。 */
export function makeAskUser(approveAll: boolean): AskUserFn {
  return async () => approveAll;
}
