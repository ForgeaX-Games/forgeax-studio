/**
 * 扩展子系统巡检 (extensions-inspect) —— skill / plugin / hooks 三子系统的
 * 「列出 / 状态」只读 getter,提供 `/skills`
 * `/plugin` `/hooks`。
 *
 * 023 任务的 **A 层底层能力**:`listSkills()` / `listPlugins()` / `listHooks()`
 * 各返回一组 `{ name, source, status }` 行,供 serve method(给 Studio)+ TUI
 * 命令(给终端)共用渲染。本文件**纯函数 + 直接从各 loader 读**,不碰共享的
 * `runtime/assemble.ts`(后者只在装配时跑一遍、不留巡检面)——集成方把已有的
 * `skillDirs` / `pluginSources` / `hooks.settings` 入参转手喂进来即可,数据口径
 * 与装配期完全一致(同一组 loader)。
 *
 * 设计取舍:
 *   - skill 来源 = loader 三层目录序(builtin→user→project,first-wins),loader
 *     本身不回传「命中的是哪层」,故 source 用「default(默认激活)/conditional
 *     (有 paths,held back)」表征装载状态;名称冲突的 first-wins 去重已由 loader
 *     完成。
 *   - plugin 来源 = `PluginSourceKind`(builtin/marketplace/session),经
 *     `mergePluginSources` 做跨源 precedence 后取胜者;status 反映 enabled +
 *     有无 hooks/mcp 等组件。
 *   - hooks 有两个来源:settings 形状 hooks(②,事件名 → 匹配组)与 plugin 自带
 *     hooks(`hooksConfig`)。两者都列出,用 `from` 区分。
 *
 * Boundary: 仅 import core-local(各 loader + 类型)。不 spawn、不订阅 bus、不改
 * 装配层。
 */
import { loadSkillsDir } from './skill/loader';
import { loadPlugins, mergePluginSources, type PluginSource } from './plugin/loader';
import type { LoadedPlugin } from './plugin/loaded';
import type { HooksSettings } from './hooks/from-settings';

// ─── 统一行形状 ────────────────────────────────────────────────────────────────

/** 巡检行的通用三元组:名称 / 来源 / 状态。三子系统的列表项都收敛到这个形状。 */
export interface ExtensionRow {
  /** 展示名(skill 名 / plugin 名 / hook 事件名)。 */
  name: string;
  /** 来源标识(见各 inspect 的语义说明)。 */
  source: string;
  /** 一句话状态(已激活 / held back / enabled 等)。 */
  status: string;
  /** 可选补充描述(skill description / plugin 组件 / hook 命令摘要)。 */
  detail?: string;
}

// ─── skills ────────────────────────────────────────────────────────────────────

/**
 * 列出已加载的 skill。数据从 `loadSkillsDir`(与装配期同一 loader)取。
 *
 * - 默认激活(无 `paths`)的 skill:source='default',status='active'。
 * - 有 `paths` frontmatter、被 held back 的 conditional skill:source='conditional',
 *   status='conditional'(host 在文件命中时才激活)。
 *
 * 同名 / 同 realpath 去重已由 loader 按 first-wins 完成,这里不再二次去重。
 *
 * @param dirs skills 根目录列表(集成方原样传 assemble 的 `skillDirs`,按优先级序)。
 */
export function listSkills(dirs: readonly string[]): ExtensionRow[] {
  const { skills, conditional } = loadSkillsDir(dirs);
  const rows: ExtensionRow[] = [];
  for (const s of skills) {
    rows.push({
      name: s.name,
      source: 'default',
      status: 'active',
      detail: s.meta.description,
    });
  }
  for (const s of conditional) {
    rows.push({
      name: s.name,
      source: 'conditional',
      status: 'conditional',
      detail: s.meta.description,
    });
  }
  return rows;
}

// ─── plugins ───────────────────────────────────────────────────────────────────

/** 把一个 LoadedPlugin 规整成巡检行(status 反映 enabled + 组件概览)。 */
function pluginRow(p: LoadedPlugin): ExtensionRow {
  const kinds = p.componentKinds.length > 0 ? p.componentKinds.join(',') : 'none';
  const hasHooks =
    p.hooksConfig !== undefined && Object.keys(p.hooksConfig).length > 0;
  // detail 拼组件概览 + hooks 标记,便于 `/plugin` 一眼看出装了什么。
  const detailParts = [`components: ${kinds}`];
  if (hasHooks) detailParts.push('hooks');
  if (p.mcpServers && Object.keys(p.mcpServers).length > 0) {
    detailParts.push(`mcp(${Object.keys(p.mcpServers).length})`);
  }
  return {
    name: p.name,
    source: p.source,
    status: p.enabled ? 'enabled' : 'disabled',
    detail: detailParts.join(' · '),
  };
}

/**
 * 列出已加载的 plugin。数据从 `loadPlugins` 取,再经 `mergePluginSources` 做
 * 跨源 precedence(session > marketplace > builtin)后取胜者——口径与装配期一致
 * (装配也是先 loadPlugins;merge 这步显式做,保证同名 plugin 只列高优先级那份)。
 *
 * source 即 `PluginSourceKind`(builtin/marketplace/session);status=enabled/disabled。
 *
 * @param sources plugin 源(集成方原样传 assemble 的 `pluginSources`)。
 */
export function listPlugins(sources: readonly PluginSource[]): ExtensionRow[] {
  const { plugins } = loadPlugins(sources);
  // 按 source 分桶喂 mergePluginSources,得跨源去重后的胜者(已按名字母序)。
  const buckets: {
    session: LoadedPlugin[];
    marketplace: LoadedPlugin[];
    builtin: LoadedPlugin[];
  } = { session: [], marketplace: [], builtin: [] };
  for (const p of plugins) buckets[p.source].push(p);
  const merged = mergePluginSources(buckets);
  return merged.map(pluginRow);
}

// ─── hooks ───────────────────────────────────────────────────────────────────

/** listHooks 的入参:settings 形状 hooks + plugin 源(两者皆可选)。 */
export interface ListHooksInput {
  /** settings 形状 hooks(②):事件名 → 匹配组。集成方传 assemble 的 `hooks.settings`。 */
  settings?: HooksSettings;
  /** plugin 源:用于把 plugin 自带 hooks(`hooksConfig`)也列出。 */
  pluginSources?: readonly PluginSource[];
}

/**
 * 列出已注册的 hooks。两个来源都覆盖:
 *
 *  1. **settings hooks**(`source='settings'`):一份 settings 形状配置
 *     `{ PreToolUse:[{matcher,command}], ... }`,每条匹配组展开成一行,name=事件名,
 *     detail 拼 matcher + 命令摘要。
 *  2. **plugin hooks**(`source='plugin:<name>'`):每个 plugin 的 `hooksConfig`
 *     (event-name → 匹配组)展开,name=事件名,detail 标注所属 plugin。
 *
 * 两者口径与装配期一致:settings hooks 由 `loadHooksFromSettings` 订阅 bus、
 * plugin hooks 由 `pluginToCapabilityPack` 订阅 bus,本函数只是把同样的配置读出来
 * 列示,不订阅、不执行。
 */
export function listHooks(input: ListHooksInput): ExtensionRow[] {
  const rows: ExtensionRow[] = [];

  // ① settings 形状 hooks。
  if (input.settings) {
    for (const [event, entries] of Object.entries(input.settings)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry?.command) continue;
        rows.push({
          name: event,
          source: 'settings',
          status: 'registered',
          detail: hookDetail(entry.matcher, entry.command),
        });
      }
    }
  }

  // ② plugin 自带 hooks。
  if (input.pluginSources && input.pluginSources.length > 0) {
    const { plugins } = loadPlugins(input.pluginSources);
    // 同样过一遍 precedence,避免同名 plugin 的 hooks 重复列出。
    const buckets: {
      session: LoadedPlugin[];
      marketplace: LoadedPlugin[];
      builtin: LoadedPlugin[];
    } = { session: [], marketplace: [], builtin: [] };
    for (const p of plugins) buckets[p.source].push(p);
    for (const p of mergePluginSources(buckets)) {
      const cfg = p.hooksConfig;
      if (!cfg) continue;
      for (const [event, groups] of Object.entries(cfg)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const action of g.hooks) {
            rows.push({
              name: event,
              source: `plugin:${p.name}`,
              status: 'registered',
              detail: hookDetail(g.matcher, action.command),
            });
          }
        }
      }
    }
  }

  return rows;
}

/** 拼一行 hook 的 detail:`[matcher] command`(命令过长截断)。 */
function hookDetail(matcher: string | undefined, command: string): string {
  const cmd = command.length > 60 ? `${command.slice(0, 57)}...` : command;
  return matcher ? `[${matcher}] ${cmd}` : cmd;
}
