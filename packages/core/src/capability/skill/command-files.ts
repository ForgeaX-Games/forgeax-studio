/**
 * 单文件 markdown 指令加载(`<dir>/commands/` 下递归 `*.md`)—— SKILL pack 的「纯 markdown 指令」面。
 *
 * 与 `loader.ts`(目录形态 `<name>/SKILL.md` 的 skill)互补:这里加载**单 .md = 一条指令**
 * 的轻形态。两者都规整成同一个 `Command`(prompt 型),
 * 经 `buildSkillTool` 出墙到统一的 Skill 工具。
 *
 * 规则:
 *   - 递归扫 `<dir>` 下所有 `*.md`;指令名 = 相对 `<dir>` 的路径去 `.md`,子目录用 `:` 连
 *     (`git/commit.md` → `git:commit`)。
 *   - frontmatter 可选;缺省即 `user-invocable:true` + `disable-model-invocation:false`
 *     (既是 slash 也是 model 可调,沿用 `toSkillMeta` 默认)。
 *   - 多目录按序给 = 优先级序,**first-wins**(同名指令只取首次遇到的)。
 *   - 单文件畸形只记 stderr 并跳过,**绝不**让异常冒出 loadCommandDirs。
 *
 * Boundary: 仅 import core-local(frontmatter/command)+ node:fs / node:path。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFrontmatter, toSkillMeta } from './frontmatter';
import { createSkillCommand, type Command } from './command';

/** 递归收集 `<dir>` 下所有 `.md` 的绝对路径(深度优先,目录名字典序稳定)。 */
export function collectMdFiles(dir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 → 跳过
  }
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectMdFiles(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(full);
    } else if (e.isSymbolicLink()) {
      // 符号链接:解析其指向(目录则递归、.md 文件则收)。
      try {
        const st = statSync(full);
        if (st.isDirectory()) out.push(...collectMdFiles(full));
        else if (st.isFile() && e.name.endsWith('.md')) out.push(full);
      } catch {
        /* 悬空链接 → 跳过 */
      }
    }
  }
  return out;
}

/** 由文件绝对路径 + 其所属根目录算指令名:相对路径去 `.md`、`/`→`:`。 */
function commandName(rootDir: string, file: string): string {
  const rel = file.slice(rootDir.length).replace(/^[/\\]+/, '');
  return rel.replace(/\.md$/i, '').replace(/[/\\]+/g, ':');
}

/** 读单个指令 .md → Command;不可读/畸形 → null(记 stderr)。 */
function loadOne(rootDir: string, file: string): Command | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const name = commandName(rootDir, file);
    const { frontmatter, body } = parseFrontmatter(raw);
    const meta = toSkillMeta(frontmatter, body, name);
    // baseDir = 该 .md 所在目录(相对资源解析 / ${BC_SKILL_DIR})。
    return createSkillCommand(meta, dirname(file), body, name);
  } catch (e) {
    process.stderr.write(`[command-files] skip ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/**
 * 扫多个 commands 根目录,加载所有指令为 `Command[]`。
 * 目录序即优先级序:**first-wins**(同名指令只取首次遇到的)。
 *
 * @param dirs commands 根目录列表(每个目录下是 `*.md` / `<ns>/*.md`)
 */
export function loadCommandDirs(dirs: readonly string[]): Command[] {
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const dir of dirs) {
    for (const file of collectMdFiles(dir)) {
      const cmd = loadOne(dir, file);
      if (!cmd) continue;
      if (seen.has(cmd.name)) continue; // first-wins
      seen.add(cmd.name);
      out.push(cmd);
    }
  }
  return out;
}
