/**
 * Memory slot + index rebuild — resident MEMORY.md index injection.
 *
 * index 常驻
 * system:memory slot 注入 `MEMORY.md` 索引正文(常驻、每条一行供模型挑文件召回),
 * **封顶 MEMORY_BUDGET.entrypointMaxLines / entrypointMaxBytes**。topic 文件的选择性
 * 召回作 system-reminder 由 host 在 loop ingress 注入(走 memory_search),slot 只管常驻索引。
 *
 * `rebuildIndex` 扫盘重建 `MEMORY.md`(供 `remember` 写后调用),与索引读保持一致。
 * core 不解释 type taxonomy:索引行原样带 frontmatter 的 `[type]` 标签。
 * Boundary: 仅 import core-local 类型。
 */
import type { SandboxFs } from '../../inject/types';
import type { MemorySlot } from '../memory-seam';
import { MEMORY_BUDGET } from '../memory-seam';
import { scanMemoryFiles, formatManifest, MEMORY_INDEX_FILE } from './scan';

function join(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/** 把索引文本封到 entrypoint 预算(先行后字节)。 */
function clampEntrypoint(text: string): string {
  let out = text;
  const lines = out.split('\n');
  if (lines.length > MEMORY_BUDGET.entrypointMaxLines) {
    out = lines.slice(0, MEMORY_BUDGET.entrypointMaxLines).join('\n');
  }
  if (out.length > MEMORY_BUDGET.entrypointMaxBytes) {
    out = out.slice(0, MEMORY_BUDGET.entrypointMaxBytes);
  }
  return out;
}

/**
 * 扫盘重建 `MEMORY.md` 索引(每条一行:manifest 格式)。`remember` 写后调用以保持一致。
 * 经注入的 SandboxFs 写盘;封到 entrypoint 预算。
 */
export function rebuildIndex(fs: SandboxFs, memoryDir: string): void {
  const headers = scanMemoryFiles(fs, memoryDir);
  const manifest = clampEntrypoint(formatManifest(headers));
  const content = `# MEMORY index\n\n> Resident index: one line per file. Pick files to recall via memory_search.\n\n${manifest}\n`;
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeTextSync(join(memoryDir, MEMORY_INDEX_FILE), content);
}

export interface MemorySlotDeps {
  memoryDir: string;
  sandboxFs: SandboxFs;
}

/**
 * memory slot:注入常驻 `MEMORY.md` 索引(封顶 entrypoint 预算)。索引缺失 → 实时
 * 用 scan 派生一份(不写盘),仍空 → null(本轮不注入)。静态 slot(随 /clear|/compact
 * 失效,不每轮重算)。
 */
export function makeMemorySlot(deps: MemorySlotDeps): MemorySlot {
  const { memoryDir, sandboxFs } = deps;
  return {
    name: 'memory',
    dynamic: false,
    render() {
      const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
      let body = '';
      if (sandboxFs.existsSync(indexPath)) {
        try {
          body = sandboxFs.readTextSync(indexPath);
        } catch {
          body = '';
        }
      }
      if (!body.trim()) {
        // 索引缺失:实时从 scan 派生 manifest(不写盘),作 fallback。
        const manifest = formatManifest(scanMemoryFiles(sandboxFs, memoryDir));
        if (!manifest.trim()) return null;
        body = `# MEMORY index\n\n${manifest}\n`;
      }
      return clampEntrypoint(body);
    },
  };
}
