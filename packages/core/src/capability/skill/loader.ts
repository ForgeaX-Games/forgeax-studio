/**
 * Skill 目录加载 (SKILL pack)。
 *
 * 扫 `<dir>/<name>/SKILL.md`，解析 frontmatter，造 Command。
 * 规则:
 *   - 只支持目录形态 `<name>/SKILL.md` (单 .md 不算 skill)。
 *   - **按 realpath 去重** (解析符号链接 / 重叠父目录；first-wins)。
 *   - 三层来源 (集成者按序给目录列表，先给者优先 = first-wins)。
 *   - conditional (有 paths frontmatter) 的 skill **held back** —— 不进默认
 *     激活集，由集成者在文件命中时再激活。
 *
 * Boundary: 仅 import core-local (frontmatter/command) + node:fs / node:path。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, toSkillMeta } from './frontmatter';
import { createSkillCommand, type Skill } from './command';

/** loadSkillsDir 的产出：激活的 + 被 held back 的 conditional skill。 */
export interface LoadSkillsResult {
  /** 默认激活的 skill (无 paths)，已按 realpath 去重 (first-wins)。 */
  skills: Skill[];
  /** 有 paths frontmatter、被 held back 的 conditional skill。 */
  conditional: Skill[];
}

/** 读单个 `<dir>/SKILL.md` → Skill；不存在/失败 → null。 */
function loadOne(skillDir: string, name: string): Skill | null {
  const file = join(skillDir, 'SKILL.md');
  let raw: string;
  try {
    if (!statSync(file).isFile()) return null;
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null; // 没有 SKILL.md / 不可读 → 跳过
  }
  try {
    const { frontmatter, body } = parseFrontmatter(raw);
    const meta = toSkillMeta(frontmatter, body, name);
    const command = createSkillCommand(meta, skillDir, body, name);
    return { name, meta, baseDir: skillDir, command };
  } catch {
    return null;
  }
}

/** 取文件 canonical 身份 (realpath)；解析失败返回 null。 */
function fileIdentity(skillDir: string): string | null {
  try {
    return realpathSync(join(skillDir, 'SKILL.md'));
  } catch {
    return null;
  }
}

/**
 * 扫多个 skills 根目录加载所有 skill。
 *
 * 目录序即优先级序 (集成者按 builtin→user→project 等给)：**first-wins** ——
 * 同一 realpath 的 SKILL.md 只取首次遇到的 (符号链接 / 重叠父目录去重)。
 * 同名但不同 realpath 的 skill 也按 first-wins 去重 (后来的同名被丢弃)。
 *
 * 有 `paths` frontmatter 的 conditional skill 不进 `skills`，归到 `conditional`。
 *
 * @param dirs skills 根目录列表 (每个目录下是 `<name>/SKILL.md`)
 */
export function loadSkillsDir(dirs: readonly string[]): LoadSkillsResult {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const skills: Skill[] = [];
  const conditional: Skill[] = [];

  for (const dir of dirs) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 根目录不存在 → 跳过
    }
    for (const e of entries) {
      // 只认目录 / 指向目录的符号链接。
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.')) continue;

      const skillDir = join(dir, e.name);

      // realpath 去重 (first-wins)：同一物理文件经多路径只取一次。
      const id = fileIdentity(skillDir);
      if (id !== null) {
        if (seenIds.has(id)) continue;
      }

      const skill = loadOne(skillDir, e.name);
      if (!skill) continue;

      // 同名去重 (first-wins)。
      if (seenNames.has(skill.name)) continue;

      if (id !== null) seenIds.add(id);
      seenNames.add(skill.name);

      if (skill.meta.paths && skill.meta.paths.length > 0) {
        conditional.push(skill);
      } else {
        skills.push(skill);
      }
    }
  }

  return { skills, conditional };
}
