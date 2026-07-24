# CHANGELOG · forgeax-studio  *(rebranded to ForgeaX Studio)*

> 用户视角的迭代日志。每条 1-2 行,普通人能看懂。
> 不写"refactor X module" — 写"X 这个东西现在变 Y 了"。
> 技术细节请去 [`forgeax-dev-diary/`](../forgeax-dev-diary/) 或仓库 `git log`。
>
> **2026-05-20 · Renamed ForgeaX / Forge → ForgeaX / Forge.** UI, env, user-dir,
> npm scopes, plugin ids 一刀切。当时白名单保留: GitHub repo URLs
> (`ForgeaX-Games/forgeax-*`) + 商业站 `forge.games` + `.gitmodules` 段名 + 历史
> CHANGELOG。**2026-05-21 · 第二刀**: GitHub 组织 `ForgeaX-Games` → `ForgeaX-Games`、
> 9 个 repo URL `forgeax-*` → `forgeax-*`、engine-assets submodule 路径 +
> `.gitmodules` 段名也一并改干净;最后只剩 `forge.games` 商业域 + 历史 CHANGELOG
> 这两类原名保留。下方历史条目保留 ForgeaX 原始措辞做存档。

---

## v0.3.22 — 2026-07-24

**Play 模式冻结彻底修复 + 新建游戏白屏彻底修复 + 编辑器 UX 多项修复 + 端口隔离 + 编辑器面板贡献 + 视频资源管理 + Onboarding Tour 增强 + Hellforge 垂直切片**

### Fixes
- fix(editor): Play 模式下切换界面再返回，3D 渲染不再冻结
- fix(interface): 新建/切换游戏不再白屏，引擎完全就绪后才加载视口
- fix(editor): Hierarchy 搜索双 X 按钮修复、折叠全部时保持 Scene 根节点展开
- fix(editor): Content Browser 键盘 Delete 键支持所有资源类型
- fix(studio): 编辑器 gateway 端口隔离，standalone editor 不再与 Studio 端口冲突
- fix(workbench): AI workspace 初始化方式优化
- fix: 引擎升级兼容性加固
- fix(cli): 修复打包后运行时找不到 zod 依赖的问题

### Features
- feat: 编辑器面板贡献（Editor Panel Contributions）— 支持插件注册自定义面板
- feat: 视频资源统一管理（Video Asset Management）
- feat: Activity Rail 导航 + 可调整大小的聊天面板
- feat(interface): Onboarding tour 支持多锚点区域联合
- feat(server): Game charter 改为资产驱动
- feat(harness): 在 `.forgeax` 目录安装 skills

### Hellforge
- 垂直切片打磨计划 + PR0-PR7 子计划落地
- PR1 品质房间相机、PR2a 闪避终结缝合、PR2b VFX 数据模型、PR2c 氛围与评分、PR3 模块化种子地牢

---

## v0.3.21 — 2026-07-22

**Play 模式渲染冻结修复 + 新建游戏白屏修复 + CLI zod 依赖补全**

### Fixes
- fix(editor): Play 模式下切换到 AI 界面再返回 Scene，3D 渲染不再冻结。`installVisibilityPause` 现在区分 editorApp 与 playApp，暂停/恢复正确的 app
- fix(interface): 新建/切换游戏不再白屏。`switchGame` 现在等待引擎 Vite 重启完成后再刷新视口，避免 502 导致 pack-index 加载失败
- fix(cli): 添加 `zod` 到 dependencies，修复打包后 `@forgeax/types` 内联代码运行时找不到 zod 的问题

---

## v0.3.20 — 2026-07-18

**场景数据丢失修复 + 错误信息结构化**

### Fixes
- fix: bump cli + editor pins for scene data-loss prevention
- fix(editor): loadSceneByGuid 失败不再清空场景（teardown 延迟到加载成功后）
- fix(editor): doSaveDocToDisk/beacon 新增 wouldDropAllEntities 保护，阻止空实体覆盖非空磁盘文件
- fix(editor): viewport assetsChanged 时清除 AssetRegistry 缓存，消除陈旧数据
- fix(cli): MCP 网关错误从 [object Object] 改为结构化 CommandError 透传
- fix: remove engine-font from engine entry packages list

### Other
- ci: route private Linux jobs to self-hosted
- feat: connect CLI registration to editor gateway
- fix(studio): resolve embedded Play game imports

---

## v0.3.1 — 2026-06-30

**Team 多 Agent 协作 + 引擎结构迁移 + 微信远程控制**

### New Features
- **多 Agent 协作**：Team multi-agent 默认开启，coordinator+peers 原子任务分发
- **微信远程控制**：/remote-control 扫码连微信 + 消息双向中转，迁移到 openclaw HTTP 网关
- **Mesh 面板**：单 mesh 场景资产持久化 + Asset Inspector 全资产类型
- **引擎内嵌**：engine 从顶层子模块移入 editor nested submodule，build/CI/scripts 统一
- **Nightly 桌面构建**：CI 流水线增加 security scan + desktop builds

### Fixes
- Windows 预览黑屏（server.restart 并发死锁）修复
- stop.ts 不再误杀自身 launcher 祖先链
- interface markdown parser 无限循环 + OOM 修复
- submodule 使用相对 URL，CI 子模块 checkout 稳定化

### Architecture
- scripts 全部从 bash 迁移到 Bun（cross-platform deploy/bootstrap/dev/run/stop）
- 命令入口统一为 `bun fx` 命名空间
- dependency-cruiser 分层边界 lint 接入 CI

---

## [Unreleased] refactor!

**Breaking change: wb-character workbench tool id migration.**

Three tool ids have moved to dedicated workbench plugins. AI agents using
`character:generate-spine`, `character:generate-video`, or
`character:generate-vfx` must update their tool calls.

### Tool id migration table

| Old id (removed) | New id | New plugin |
|:--|:--|:--|
| `character:generate-spine` | `anim:generate-spine` | `@forgeax-plugin/wb-anim` |
| `character:generate-video` | `anim:generate-video` | `@forgeax-plugin/wb-anim` |
| `character:generate-vfx` | `skill:generate-vfx` | `@forgeax-plugin/wb-skill` |

No deprecated aliases are provided. Calls to the old ids will return
`ToolResult { ok: false, code: "not_found" }` via the host ToolRegistry.

**Why**: `wb-character` was overloaded — animation (spine/video) and VFX
pipelines are now vertically split into `wb-anim` (animation workbench) and
`wb-skill` (skill & VFX workbench). Each plugin holds only the tools and
credentials it needs (Kling for `wb-anim`; Gemini/Claude/Azure for
`wb-skill`).

**Fixed: 工作台插件后端不再泄漏成"僵尸进程"占着端口。** `run.sh` 现在把每个
服务（server / interface / engine / 各 workbench 插件）都放进**独立进程组**启动，
`run.sh` 退出和 `stop.sh` 关停时按**整组**杀（连同 `pnpm` 底下的 `vite` /
`tsx --watch` 子孙进程）。此前只杀父进程，watcher 子进程被甩给 init 一直活着，
反复 start/stop 后越积越多，抢占 9567 等插件端口导致 lowpoly 后端 `EADDRINUSE`
崩溃重启死循环、左侧面板报 "Status unavailable"。`stop.sh` 带自身进程组保护，
绝不会误杀自己。

---

## v0.5.24.651 — 2026-05-24 · Phase 2 文档 14 GAP 全闭环 + drift gate + agent 体系扩张

**代码增量**:主仓 **+1,840 / -68**(净 +1,772)· 40 commits 当日

**主题**:Phase 2 演进文档收官——14 个 GAP 标记 closed、7 个 KNOWN_DRIFT 条目下架,00/01/02/03/14/15 多份 doc 更新到代码当前状态;新增 `doc-vs-code drift gate`(自动检测文档跟代码漂移,预防 KNOWN_DRIFT 再次堆积);agent 体系大幅扩张——marketplace 一次进 7 个新 agent personas、server 内建 `agent_manage` 工具、interface 在插件 host 加 agent picker + open-agent-detail bridge;engine 同时启动两个 closed-loop(skin-skeleton-animation feat、mesh-upload bug)。

### 用户可感知

- **【特性】** 工作台 plugin host 加 agent picker · 在 surface 顶栏直接切 agent,不用回侧栏(`interface da91a19` + `open-agent-detail bridge`)。
- **【特性】** marketplace 一次进 7 个新 agent personas · `agent-bc-coder` 等,商店一键安装;同时 `bc-coder` scope 收紧到 produces(`marketplace 7002f66`)。
- **【特性】** server 内建 `agent_manage` 工具 · agent 的增删改查作为 builtin tool,前端 / CLI 都能调用 + `marketplace-manifest` 辅助(`server fe04d7b`)。

### 内部 / agent 视角

- **【架构】** Phase 2 演进文档 GAP 全部闭环 · 14 个 GAP(3/5/6/7/9/11/12/13/15/16/17/18/19) + 7 个 KNOWN_DRIFT 整体清账,00/01/02/03/14/15 多份 doc 跟当前代码对齐(`docs(02-gap)` × 14)。
- **【基建】** doc-vs-code drift gate · 自动 lint architecture-evolution 文档跟代码的漂移,新 P2 类型 commit 上线(`feat(p2): doc-vs-code drift gate`)。
- **【实验】** engine 双 closed-loop 起步 · `feat-20260523-skin-skeleton-animation` 与 `bug-20260523-mesh-upload-floats-per-vertex` 同时进入 plan / worktree 阶段。
- **【文档】** 14-RESOLUTIONS §6 重计 · 关掉最后一个 🟡(2.2 dual-metering);01 ADR-EVO 草案表标注 supersedes 关系。
- **【文档】** 03 / 15 agent-missing-personaFile 对齐到代码 · soft-register 实际行为写回文档,P11 LiteLLM ⚠ → ✓(wb-character env 走 ctx.env)。

---

## v0.5.23.611 — 2026-05-23 · DUAL-MODALITY 9.x 收官 + tool-requireConfirm 闸门 + 插件作者面板 v0

**代码增量**:主仓 **+11,007 / -163**(净 +10,844)· 40 commits 当日

**主题**:DUAL-MODALITY 协议 9.4-9.9 全部落地(provides.surfaces[] zod schema → 商店端字段渲染 → ledger-backed replay);`tool.requireConfirm` 从 server runtime 一路打到 TopBar 通知,实现"敏感工具必须人确认才执行"的全链路闸门;插件作者面板 v0(in-app 文件树 + textarea 编辑器)接入 Studio;Phase A1+ 完成 types / host-sdk / agent-runtime 三包拆分 + 8 个 ADR;CHANGELOG inline-renderer 死循环 bug 修复(triple-backtick 在 Settings 面板触发卡死)。

### 用户可感知

- **【特性】** 敏感工具必须确认才执行 · 插件可标记 `tool.requireConfirm: true`,server runtime 拦住执行 → SSE 推到前端 → TopBar 弹通知,用户点确认才放行(`feat-20260522-tool-requireconfirm-gate`)。
- **【特性】** 插件作者面板 v0 · Studio 内直接看插件源码、改文件、保存重载,不用切回编辑器(`gap 7`,`@forgeax-plugin/wb-plugin-author`)。
- **【特性】** 商店端拿到 surface 元数据 · 插件 manifest `provides.surfaces[]` 经 zod 校验后传到商店,商店可按 surface 类型筛选/分组(`DUAL-MODALITY 9.4`)。
- **【体验】** 协议 surface 状态可重放 · ledger-backed replay 机制让 surface 在 reload 后能回到关闭前的状态(`DUAL-MODALITY 9.8`)。
- **【体验】** Sidebar manifest 注册表订阅化 · 插件挂载/卸载,左侧栏立即跟随,不用刷新(`B4`)。
- **【修复】** Settings → Changelog 标签页不再卡死 · MdLite `renderInline()` 在三反引号 + 未闭合 `**` 时无限循环已修(`packages/interface`)。

### 内部 / agent 视角

- **【架构】** Phase A1+ 包拆分 · `@forgeax/types` / `@forgeax/host-sdk` / `@forgeax/agent-runtime` 落地;8 个 ADR 配套 + boundary check 防越权 import(`feat(arch): Phase A1+ landing`)。
- **【架构】** Pack 签名 + installed.yaml ledger · fxpack 安装包 ed25519 签名验证;`installed.yaml` 记录每个包的 hash/version/signer(`packages/server runtime/permissions skeleton`)。
- **【架构】** Bus surface events · `surface:open` / `surface:close` / `surface:focus` 事件接入;ctx.env routing 让 wb-character / wb-narrative 拿到正确 env(`bus.ts surfaces`)。
- **【基建】** Nightly contract test workflow · GitHub Action 每晚跑 `@forgeax/types` 与 host-sdk / runtime / interface 三方契约测试(`D9`)。
- **【文档】** Architecture-evolution v3 9 个 gap 全闭环 · 含 Pause AI / flashElement 已实现核对 + 15-COVERAGE 矩阵刷新。
- **【文档】** Doc 15 P1-P12 design-principles coverage matrix · 把 12 条设计原则映射到具体 doc/章节,补全 7 行陈旧条目。
- **【实验】** harness forgeax-monitor ghmd-proxy · 监控面板拿到 GitHub markdown 渲染代理 + 单元测试。

---

## v0.5.22.571 — 2026-05-22 · wb-narrative 入商店 + upload-asset + 双窗格 sidebar

**代码增量**:主仓 **+5,094 / -56**(净 +5,038)· 15 commits 当日

**主题**:`wb-narrative` 插件并入 marketplace(剧情面板 surface);`upload-asset` 工具上线(插件可让用户拖拽图片到 surface);Sidebar 改为左中两窗 split-pane(manifest schema `surface: split` + `panes.{left,center}`);`stop.sh` 正式化(端口→服务名映射 + 优雅退出);引擎 `DirectionalLight` 阴影修复(`#193`);架构演进 v3 起草(15 个 doc)。

### 用户可感知

- **【特性】** wb-narrative 进商店 · 剧情面板插件可在商店一键安装,不再需要本地手动加包(`marketplace #C6`)。
- **【特性】** 插件可让用户上传图片 · 新工具 `upload-asset`,surface 内显示拖拽区,文件直接进 user-dir 并回传 URL。
- **【特性】** Sidebar 双窗 split-pane · manifest 写 `surface: split`,左中两窗各跑独立 iframe,适合"列表 + 详情"布局(`marketplace pane manifest`)。
- **【体验】** `stop.sh` 友好化 · 输出 port→service 映射(7860 → server,5173 → interface);定时打 "killing pid …" tick,5s 仍存活才报警告;再不写 "still running" 一行 noise。
- **【修复】** DirectionalLight 不再缺角阴影 · `engine #193` 修了 cascade 边界采样问题。

### 内部 / agent 视角

- **【架构】** `surface: split` + `panes.{left,center}` 协议位 · 见 `docs/06-WORKBENCH-THREE-PANE-V2.md`,商店端透传到 host。
- **【文档】** Architecture-evolution v3 起草 · 15-doc 草案,把 v2(2026-05-15)推进到 v3(packs/permissions/ledger + bus 协议位)。
- **【基建】** `run.sh` 接 nvm + 调用新 `stop.sh` · 启停脚本闭环;无 `nvm.sh` 时 graceful 跳过。

---

## v0.5.21.556 — 2026-05-21 · Rebrand 第二刀 + stop.sh 形式化 + motion-layout-icons

**代码增量**:主仓 **+4,278 / -1,590**(净 +2,688)· 30 commits 当日

**主题**:rebrand 第二刀(GitHub 组织 `ForgeaX-Games` → `ForgeaX-Games`、9 个 repo URL `forgeax-*` → `forgeax-*`、`.gitmodules` 段名一并改);`stop.sh` 从一次性脚本拎成正式工具(子模块 dev-server 也能干净杀掉);`motion-layout-icons` 插件入商店;harness 多个 closed-loop 状态机修复。

### 用户可感知

- **【特性】** motion-layout-icons 插件 · 在 surface 内放可拖动 / 旋转的 icon 组,做引导图、UI 演示用。
- **【体验】** 一键停止所有 dev server · `bash scripts/stop.sh` 把 5173/7860/8080 + 子模块的 dev-server 全收;之前需要多个终端各 ctrl-C。
- **【体验】** 第二刀 rebrand 后 git remote 完全干净 · `git remote -v` 看到的全是 `forgeax-*`,9 个 repo URL + `.gitmodules` 段名一致(GitHub 自动 301 老 URL)。

### 内部 / agent 视角

- **【架构】** Rebrand 完成度 · 仅剩 `forge.games` 商业域 + 历史 CHANGELOG 两类原名保留,见本文件顶部说明。
- **【基建】** `stop.sh` 通用化 · 端口探测 + 子模块 PID 收割;`run.sh` 启动失败时也调用它做清理。
- **【实验】** harness closed-loop 多 bug 修复 · `bug-20260522-session-default-dir-not-resolved-to-agent-cwd` 走完 7 步;`feat-20260522-tool-requireconfirm-gate` 闭环到 plan(实现在 5-23)。

---

## v0.5.21.537 — 2026-05-20→21 · Rebrand to ForgeaX (Breaking · 两刀)

### What changed
- **Brand**: ForgeaX / Forge → ForgeaX / Forge across UI, CLI, docs.
- **User data directory**: `~/.forgeax/` → `~/.forgeax/`. Server boot auto-renames the directory and the `agents/forge/` → `agents/forge/` subdirs; see `~/.forgeax/MIGRATION_LOG.md`.
- **Environment variables**: `FORGEAX_*` → `FORGEAX_*` (SERVER_PORT, INTERFACE_PORT, ENGINE_PORT, USER_DIR, MODEL, LANG, VERSION, COMMANDS_DIR, NO_WATCH, CLI_AUTOSTART). Update your `.env` accordingly.
- **CLI bin**: `forgeax-server` → `forgeax-server`; vendored `agenteam` → `forgeax`.
- **npm scope**: `@forgeax/*` → `@forgeax/*` (server, build, engine + 22 engine subpackages + ~10 apps/parity packages).
- **Bus plugin id**: `@forgeax-plugin/*` → `@forgeax-plugin/*` (20 plugin manifests). Manifest filename `forgeax-plugin.json` → `forgeax-plugin.json`.
- **Agent id**: orchestrator `forge` → `forge` in marketplace manifest. Server boot migrates session directories.
- **CSS classes**: `.forge-card` → `.forge-card`, `.forgeax-build-badge` → `.forgeax-build-badge`, `.kbe-boot-*` → `.fgx-boot-*`, `data-kbe-boot` → `data-fgx-boot`.
- **localStorage keys**: `forgeax.*` → `forgeax.*`. Auto-migrated on first boot of the new build (`forgeax.localstorage.migrated.v1` sentinel).
- **Window global**: `window.__forgeaxBoot` → `window.__forgeaxBoot`.

### What is unchanged (after 5-21 第二刀)
- ~~GitHub repo URLs (`ForgeaX-Games/forgeax-*` × 9) — repo names kept.~~ → 已在 2026-05-21 第二刀里改成 `ForgeaX-Games/forgeax-*`,GitHub 自动 301 老 URL,git 协议照常拉。
- Commercial site `forge.games` — preserved (ForgeaX commercial edition).
- ~~Submodule entries in `.gitmodules` — kept (URL-bound).~~ → 段名 `[submodule "forgeax-X"]` → `[submodule "forgeax-X"]` 在 5-21 一起改了;路径 `packages/<X>` 没动。
- Historic CHANGELOG entries below — kept as-is for archival accuracy.

---

## 📐 规则(写日志的人 / agent 必读)

### 1. 版本号 · `v0.M.D.N`

| 段 | 含义 | 例 |
|---|---|---|
| **0** | pre-1.0 时期(没到 1.0 不会变) | `v0` |
| **M.D** | `main` 最新一次 commit 的月.日 | `5.18` |
| **N** | `main` 自第 1 天起累计 commit 数(永远 +1) | `486` |

例:`v0.5.18.486` = 5 月 18 日,主仓累计 486 个 commit。

**计算**:`bash scripts/version.sh`(底层 = `git rev-list --count main`)
**显示**:Studio UI 左下角恒显;`scripts/run.sh` 启动横幅;`/api/version` 端点。

> **为什么 N 用累计、不用"当日第 N 次"** —— 累计单调递增,不会跨日撞号,看到 `v0.5.18.486` 一眼知道"项目跑了 486 步"。
> 想看"当日第几次"用 `git log --since=YYYY-MM-DD --oneline | wc -l` 临时算。

### 2. 分类前缀

| 前缀 | 含义 | 怎么判断 |
|---|---|---|
| **【特性】** | 新功能,普通人能直接用上 | 用户能"点"到 / "切"到 / "看见"的东西 |
| **【体验】** | UI / 交互改善 | 旧功能,变快变好用变好看 |
| **【架构】** | 内部框架,用户感知不到但底层动了 | server / runtime / 包重构 |
| **【修复】** | bug 修复 | 旧版本会坏的事 |
| **【文档】** | 战略 / 设计 / 注释 | dev-diary / README / SPEC |
| **【基建】** | CI / build / 依赖 / 脚本 | scripts/ · `.github/` · package.json 重大变动 |
| **【实验】** | 跑通了但未发布 / 仅 daemon 用 | feature flag 后面 / `~/.forgeax/auto-dev/` 等 |

### 3. 每段顶部带"代码增量"行

> 每个版本段标题下面一行,放当日 git diff 统计:
>
> ```
> **代码增量**:9 仓 +X / -Y(净 ±Z)· 主仓 +A / -B · N commits 当日
> ```
>
> - **9 仓** = 主仓 + 8 个 submodule(cli / server / interface / engine / harness / build / marketplace / studio-harness)合计
> - **主仓** = 仅 `forgeax-studio` 自身(子模块 SHA bump 算这里)
> - **N commits** = 主仓当日 commit 数
> - 用 `bash scripts/version.sh stats <YYYY-MM-DD>` 自动算

### 4. 写法守则(参考 [Keep a Changelog](https://keepachangelog.com))

- **发布角度,不是 commit 角度** —— 合并相关 commits 到一条。
- **一行原则** —— 能 1 行讲清的不要 2 行。
- **避免内部术语** —— "Bus / Registry" 这种词必须前置"普通人能感知的后果"。例:❌「Bus PermissionEngine 落地」 ✅「插件能跨权限隔离了 · Bus PermissionEngine」。
- **倒序排列** —— 最新在最上面。
- **每天一段** —— `## v0.M.D.N — YYYY-MM-DD · 一句话主题` 作 section heading。
- **可以跳过琐碎** —— 拼错字 / lint / 一行格式化等 commit 不必入选。

### 5. 何时更新

- 每次"用户可感知"的发布前 / 每天日终 → 加一段。
- `bash scripts/version.sh check` 会比对 CHANGELOG 顶 vs `git log` 最新日期,差超过 3 天就 warn。
- CI 不强制 —— 但 PR 模板会问"需要 CHANGELOG 一行吗"。

---

## 🚧 [Unreleased] — 编辑中(下次发布写到这里)

<!--
  开发中累积放这。发版那一刻整段挪到下面带版本号的 section。
-->

---

## v0.3.19 — 2026-07-16 · Nightly Release

### 修复

- fix(studio): inject catalog asset roots so Assets panel is not empty
- fix: reload viewport on asset changes during play (#442)

### 其他

- docs(plan): distribution mechanism decided — standalone npm package (2026-07-16)
- docs(plan): milestones → 24-item WBS, max 1d granularity, binary acceptance
- docs(plan): annotate work sides per milestone (🟦 forgeax / 🟧 arrival / ⬜ shared)
- docs: 双基座归一执行计划 — forgeax × arrival agentstudio 插件底座合并(里程碑 + 排期)
- chore: bump editor for light color picker
- chore(editor): bump submodule pin to main (8b60dd3c)
- chore: pin merged games session cleanup
- chore: bump games pin for session cleanup
- release: v0.3.18 nightly release (#439)


---


## v0.3.18 — 2026-07-15 · Nightly Release

### 新特性

- feat(extension): M4 root closeout — manifest-derived inline panels + pins + docs (ADR 0025)

### 修复

- fix(editor): use live play-world viewport
- fix(submodules): realign pins to main after merge; games → 168930a
- fix: align architecture gates with runtime
- fix: integrate viewport input ownership
- fix: complete Marketplace kind-layout rollback

### 其他

- Bump editor and interface pins
- docs(architecture): full per-extension roster — 62 items with mount form (ADR 0025 盘点补全)
- docs(architecture): rewrite盘点 as Extension inventory from live registry (post ADR 0025)
- chore(editor): bump live play editing fix
- chore(games): bump pin to fbf4b1a (BGM uiRoot unlock)
- chore(games): bump pin to 30ca36d (hellforge tsc ShadowCaster fix)
- refactor(extension): 词汇清尾 root closeout — host-sdk API + scripts + docs + pins (ADR 0025)
- chore(games): bump submodule for hellforge contact shadows
- chore(games): bump submodule for hellforge scene BGM + volume knobs
- chore(games): bump submodule for hellforge Song UI + CharList align
- chore: integrate lowpoly agent-native delivery
- chore: pin merged extension fixes
- chore(games): bump submodule for hellforge char-list preview ring
- chore: bump editor viewport chrome controls
- chore(games): bump submodule for hellforge den floor + material fix
- chore(games): bump submodule for hellforge ground tile-break
- chore(games): bump submodule for hellforge dead-tree densify
- chore(session): bump chat/cli/server pins to merged session-live-sync
- chore(games): bump submodule for hellforge forge-gold UI theme
- Refresh viewport from asset disk events
- chore(games): bump submodule for hellforge blood-moon sky bake
- chore: align pins after kind-layout rollback
- chore(games): bump submodule for camp/den lava-cone horizon
- chore(games): bump submodule for CharSelect 360° hero preview


---


## v0.3.17 — 2026-07-13 · Nightly Release

### 新特性

- feat(studio): wire gateway-live bridge into `bun fx start` (#389)
- feat(onboarding): connect cards + project step polish (#364)
- feat: kernel model catalog + request-path perf fix

### 修复

- fix(studio): wire keyboard-router deps + proxy /__pack; bump editor pin (#385)
- fix(deploy): restore outbound SSH defaults
- fix(deploy): surface cloud init failures
- fix(studio): whitelist registered workspace roots in vite fs.allow

### 其他

- chore(submodules): bump pins to latest main (+cli toWireEvents drift fix) (#391)
- perf(studio): fix viewport stuck on "loading game" for cold-start + all games (#390)
- chore(interface): bump submodule to interface main (e7b80e2) (#388)
- perf(studio): fix heavy-game load starving the shell + viewport loading UI (#384)
- chore: bump interface pin for onboarding tour shell prep
- chore(submodules): bump editor → f0fdc83c (play→ECS reads via gateway) (#380)
- chore(submodules): bump games → 4d2ed36 (hellforge sky darken) (#379)


---


## v0.3.16 — 2026-07-12 · Nightly Release

### 其他

- chore(deps): bump forgeax-editor submodule to 5163d769


---


## v0.3.15 — 2026-07-10 · Nightly Release

### 修复

- fix(games): black-screen schema migration + full typecheck gate + editor uiRoot/stop-cleanup (#361)
- fix(prepare): treat incomplete wgpu/codec pkg/ as stale (gate on the glue)
- fix(studio): declare engine-assets-runtime + engine-picking deps for bundle resolution
- fix(setup): build @forgeax/engine-vite-plugin-rhi-debug dist in engine step
- fix(deps): hoist cli-source @forgeax deps at workspace root
- fix(mirror): tighten github_pat_ gate to token-body form (drop false positive)

### 其他

- chore(marketplace): bump for wb-gen3d legacy meta migration (#367)
- chore(platform-io): bump pin 1cd068e→08462b1 (array-TRS glTF import) (#366)
- docs(gaps): record Windows startup rebuild and editor blackscreen issues
- chore: bump vite to ^8.0.0, @vitejs/plugin-react to ^6.0.3 (#362)
- refactor(studio): pass active game to editor via props, drop URL round-trip (#363)
- chore: bump editor + games pins → box-man ChildOf-native (Edit=Play)
- docs(handoff): record Hellforge visual + array-TRS ship (#359)
- chore(deps): ship Hellforge visual upgrade (#357)
- chore(interface): bump pin c932c9b → 956697a (onboarding: open an existing project) (#355)
- chore(deps): bump editor/games/server/build pins → engine array-TRS (feat-20260709) + Tier-2
- chore(submodules): bump agent-host pin for RpcConnection.isOpen
- chore(submodules): bump core pin for RpcConnection.isOpen
- chore(submodules): bump server pin for cli-source @forgeax dep mappings
- chore(submodules): bump server pin to include cli-subpath tsconfig fix
- release: v0.3.14 nightly release (#353)
- chore(editor): bump pin → flat scene open (no synthetic hierarchy root) (#352)
- chore(submodules): bump 5 pins for create-role unified role/game actions
- docs(handoff): game mouse input fixes + keyboard-router studio wiring (#350)


---


## v0.3.14 — 2026-07-09 · Nightly Release

### 新特性

- feat: first-run onboarding (welcome → project → home tour) (#329)

### 修复

- fix(ci): interface drops self-nested design dep — frozen-lockfile gate now passes
- fix(ci): rebase bun.lock on main's lock + minimal branch delta; editor pin → editor main tip
- fix(ci): refresh bun.lock post-merge + bump settings/editor pins
- fix(fx): detect + report engine startup failure instead of silent 500s (#335)

### 其他

- docs(handoff): game mouse input fixes + keyboard-router studio wiring (#350)
- chore(deps): bump interface pin → guard allowlist fix (lint:agnostic green)
- chore(editor): bump pin 930561a → 0d425b9 (viewport pointer-lock fix + shared keyboard-router deps) (#349)
- chore(interface): bump pin → e1039cc (host-sdk decouple + graceful session/workbench clients)
- chore(deps): bump settings pin → 2872f8a (back on main lineage + mirror-gate fix)
- chore(submodules): bump pins to latest main
- docs(spec): add wb-game-video plugin extension protocol (SPEC)
- chore(deps): bump chat pin → f3b7829 (i18n agent status labels merge)
- chore(editor): bump pin → 930561a (wire the pointer-capture/template engine fix) (#338)
- chore(editor): bump pin → 72bb82a (hello5 pointer-capture + material-strip fixes) (#337)
- chore: drop ENGINE-ISSUES-for-ubpa.md + orphan archive PNGs + dead gitignore rules (#332)
- chore(submodules): bump pins to latest main
- Revert "chore(pins): point interface pin to interface origin/main"
- chore(pins): point interface pin to interface origin/main (e946dc1c)
- docs: app-host plugin-foundation plan/spec + comm-mechanism analysis
- chore(editor): bump pin → 367a23b0 (don't auto-bind unmarked scene pack) (#331)
- docs: branch-diff 快照刷新(2026-07-09)+ 改为无日期活文档
- chore(deps): bump interface + chat + workbench + dashboard + settings pins — useAppStore → useShellStore rename
- refactor: rename useAppStore → useShellStore
- chore(pins): re-align all submodule pins to forgeax-studio origin/main
- chore(pins): point all off-main submodule pins to their origin/main
- chore(deps): bump interface pin — AppHost + plugin-foundation refactor (ADR 0024)
- chore(editor): bump pin 45bd6fb → 30c136a (G/Esc exit game view in edit mode) (#330)
- chore(pins): re-land agent-host 0.1.4 + server main together (coordinated)
- chore(editor): bump pin → 45bd6fb (▶ Play animationPlugin AnimationAssetResolver SSOT) (#328)


---


## v0.3.13 — 2026-07-08 · Nightly Release

### 新特性

- feat(deploy/dev): container image + init.sh for cloud dev environments
- feat(blueprint): implement foundational components for wb-game-video orchestration

### 修复

- fix(pin): repoint server to agent-host-0.1.3-compatible merge; revert agent-host bump
- fix(studio): also update vite.config engine→viewport + bump editor pin
- fix(studio): follow edit-runtime rename — viewport-component moved to viewport/
- fix: error

### 其他

- chore(marketplace): bump narrative EN tag options & confirm buttons (#311)
- chore(marketplace): bump pin to 6cfe1ee (add wb-game-video bundled videos)
- chore(editor): bump editor pin to game-template double-scene fix (#309)
- chore: bump agent-host to 0.1.4 (RpcConnection.isOpen) for server sidecar eviction
- chore: bump marketplace pin for wb-narrative i18n zh fix
- chore: bump marketplace submodule to conflict-resolved tip
- chore: bump submodules for bilingual memory, UI asset & preview work
- chore: bump interface/server/marketplace pins for wb-items workbench
- chore(studio): bump build pin for iOS WKWebView inspectable (DEBUG) (#302)
- chore: bump marketplace to local wb-items v0.1.5 (道具生成)
- chore(games): bump forgeax-games for hellforge scene and sky (#300)
- chore(interface): bump pin to cb46c20 — composer insert typecheck fix
- chore(interface): bump pin for workbench gallery icon and theme fix
- chore(studio): remove dead ReelPlaySurface.tsx (#296)
- chore(studio): bump build + server pins for iOS export fixes (#294)
- chore(submodules): bump pins for agent UI i18n and English personas
- chore(submodules): bump chat + interface pins — composer image paste (#293)
- chore(core): bump forgeax-core pin to 0.1.4 — tool_use 优先于 end_turn 修复 (#292)
- release: v0.3.12 nightly release (#291)
- chore(submodules): bump editor + build pins for shared sky.hdr import fix (#290)


---


## v0.3.12 — 2026-07-07 · Nightly Release

### 新特性

- feat: editor multi-select, Inspector fixes, and Assets tooltip portal (#285)
- feat(fx): add `bun fx clean` — restore fully-clean git status across root + submodules (#281)
- feat(studio): 落盘产品AI化语义操作层 — bump 4 pins + 接线 bootUiBridge (#272)

### 修复

- fix(setup): no username/password prompts on fresh HTTPS clone + spec
- fix(fx): print server/UI/engine URLs to foreground stdout on start
- fix(setup): make bun fx setup/start work on headless Linux
- fix(setup): self-heal engine tsc -b on stale/corrupt incremental cache (#279)
- fix: use fetchable submodule main heads
- fix: bump CLI provider submodule pins to main

### 其他

- chore(submodules): bump editor + build pins for shared sky.hdr import fix (#290)
- chore(marketplace): bump pin to include wb-reel canonical-bun cleanup
- chore(submodules): bump 7 submodules to their origin/main tips
- chore(editor): bump pin to include harness-sync credential fix (#70)
- chore(editor): bump editor for gltf serializeMetaJson boot fix (#283)
- chore(studio): re-point interface pin to cloud-rename fix (#70)
- chore(studio): bump 4 submodule pins — publish module + agent reply-language
- chore: bump marketplace, editor, interface pins for backlog fixes (#277)
- docs(packaging): mark iOS as implemented (Xcode project export)
- chore: sync harness and marketplace submodule pins to origin/main (#276)
- docs(gaps): update fps-viewmodel / gym-physics / windows-boot / gym-runtime gaps (#275)
- release: v0.3.11 nightly release (#271)
- chore(submodules): bump core+cli to os2 HITL callId fix
- chore(editor): bump pin to save-empty-meshrenderer fix (#57) (#268)


---


## v0.3.11 — 2026-07-06 · Nightly Release

### 新特性

- feat(studio): per-stack agent-host socket + reap the run.ts launcher on stop

### 修复

- fix(scripts): fail fast when `bun fx start` background stack dies
- fix(sky): bump editor pointer for hellforge equirect sky export fix
- fix(export): bundle HDR sky into standalone game exports

### 其他

- chore(submodules): bump core+cli to os2 HITL callId fix
- chore(editor): bump pin to save-empty-meshrenderer fix (#57) (#268)
- chore(marketplace): bump for wb-gen3d rig mesh fix (#266)
- ci(games): add engine-import resolution gate + bump games pin (#262)
- chore(studio): bump editor pin — city GLB fail-fast fix (#56/#620) (#263)
- chore(studio): bump CLI provider model picker pins
- chore(studio): bump core + cli pins
- chore(games): bump pin — hellforge createCylinderGeometry import fix (#258)
- docs(studio): GLB mount ghost-node progress + large-GLB fetchBinary handover (#257)
- chore(studio): bump cli + interface pins (model-picker sort + uniform live badge)
- chore(studio): bump submodule pins to origin/main latest (#254)
- docs(readme): update Status + public mirror What's new to v0.3.10 (#242)
- chore(studio): bump agent-host + interface pins (R3 reap + .app socket)
- chore(studio): bump cli+server — stateRoot project scoping + to-less message routing fix
- chore(studio): bump editor→1b7d366 + build→17b68b1 + interface→b38c543 (GLB import UX fixes) (#249)
- chore(games): bump forgeax-games pin → 2c53eef (cow-level scene fix + viewport clip-guards) (#247)


---


## v0.3.9 — 2026-07-03 · Nightly Release

### 新特性

- feat(run): opt-in FORGEAX_DEBUG_PROXY to capture LLM egress

### 修复

- fix(studio-qa): force EN locale and CJK QA for marketplace previews
- fix(setup): stop checking out submodule branches

### 其他

- chore(marketplace): bump submodule for English preview i18n (4958ff9)
- chore(games): bump — hellforge Act 1 loot-ARPG (GLB monsters, itemization, combat feel)
- docs(readme): refresh directory tree, commands, architecture and endpoints
- docs: add update-readme skill for README maintenance
- chore(deps): bump core/interface submodule pins to merged main
- chore: auto-update README version on each nightly release
- Revert "release: v0.3.9 nightly release (#220)"
- release: v0.3.9 nightly release (#220)
- docs(specs): reel-game runtime 引擎化设计 — 影游作为引擎上的 game runtime 子类 (#210)
- chore(server): bump submodule for Edit Play projectRootAbs
- chore(editor): bump submodule to Windows Play + Socket stack (5b49245) (#216)
- docs(gaps): add Windows first-boot and gym game development gap reports
- chore(interface): bump submodule pin (fix Windows desktop build) (#214)
- chore(editor): bump submodule pin (fix Socket export for desktop build) (#212)
- chore(mirror): update public README Whats new section to v0.3.8 (#211)


---


## v0.3.8 — 2026-07-02 · Nightly Release

### 新特性

- feat(android): add Android packaging backend (build android-template + server AndroidPackager) (#178)
- feat(studio): bump editor+games pins for Play/Stop UI teardown (#183)
- feat(studio): inject game layout to the editor (editor no longer bakes .forgeax/games) (#180)
- feat(r4): land frontend app extraction + interface store slimming

### 修复

- fix(mirror): keep R4 UI packages in public workspace closure (#206)
- fix(ci): build macOS DMG via hdiutil in mirror Desktop release (#201)
- fix(mirror): drop internal workspace packages from mirror package.json (#196)
- fix(mirror): whitelist R4 frontend submodules + gate mirror install-ability

### 其他

- release: v0.3.7 nightly release (#203)
- chore: unify release version across package.json and Tauri manifests (#202)
- chore: set package version to 0.3.7 (#199)
- release: v0.3.5 nightly release (#197)
- chore(node-runnable): bump 子模块指针到已合并 main + check-node-runnable 护栏
- chore: set package version to 0.3.4 (#194)
- chore(submodules): bump cli/server/marketplace for LiteLLM image route (#193)
- chore(core): bump packages/core submodule pin → 535717e(autobug 6 批修复) (#189)
- chore(marketplace): bump submodule 8042ec0→0f00965 (propagate wb-reel「新的故事」pollution self-heal) (#190)
- release: v0.3.5 nightly release (#188)
- release: v0.3.4 nightly release (#186)
- chore(editor): revert flatten pin d022e40 → 86f21b6 (#185)
- chore(editor): bump submodule pin 196d2c9 → d022e40（多 mesh GLB 展平） (#184)
- website(games): add a whitelist for the public games gallery (block all by default) (#181)
- chore(marketplace): bump submodule to LiteLLM gateway routing (#16) (#174)
- chore(desktop): cross-platform build-desktop.ts + Windows-compat hardening (#158)


---


## v0.3.7 — 2026-07-02 · Nightly Release

### 新特性

- feat(android): add Android packaging backend (build android-template + server AndroidPackager) (#178)
- feat(studio): bump editor+games pins for Play/Stop UI teardown (#183)
- feat(studio): inject game layout to the editor (editor no longer bakes .forgeax/games) (#180)
- feat(r4): land frontend app extraction + interface store slimming
- feat(viewport): 2x2 run x display redesign (#159)

### 修复

- fix(ci): build macOS DMG via hdiutil in mirror Desktop release (#201)
- fix(mirror): drop internal workspace packages from mirror package.json (#196)
- fix(mirror): whitelist R4 frontend submodules + gate mirror install-ability
- fix(submodules): repoint editor to pushed remote tip (fix #173) (#175)

### 其他

- chore: set package version to 0.3.7 (#199)
- release: v0.3.5 nightly release (#197)
- chore(node-runnable): bump 子模块指针到已合并 main + check-node-runnable 护栏
- chore: set package version to 0.3.4 (#194)
- chore(submodules): bump cli/server/marketplace for LiteLLM image route (#193)
- chore(core): bump packages/core submodule pin → 535717e(autobug 6 批修复) (#189)
- chore(marketplace): bump submodule 8042ec0→0f00965 (propagate wb-reel「新的故事」pollution self-heal) (#190)
- release: v0.3.5 nightly release (#188)
- release: v0.3.4 nightly release (#186)
- chore(editor): revert flatten pin d022e40 → 86f21b6 (#185)
- chore(editor): bump submodule pin 196d2c9 → d022e40（多 mesh GLB 展平） (#184)
- website(games): add a whitelist for the public games gallery (block all by default) (#181)
- chore(marketplace): bump submodule to LiteLLM gateway routing (#16) (#174)
- chore(desktop): cross-platform build-desktop.ts + Windows-compat hardening (#158)


---


## v0.3.5 — 2026-07-02 · Nightly Release

### 新特性

- feat(android): add Android packaging backend (build android-template + server AndroidPackager) (#178)
- feat(studio): bump editor+games pins for Play/Stop UI teardown (#183)
- feat(studio): inject game layout to the editor (editor no longer bakes .forgeax/games) (#180)
- feat(r4): land frontend app extraction + interface store slimming
- feat(viewport): 2x2 run x display redesign (#159)
- feat(build): enhance desktop build script and add tests
- feat(fx): add startBusyPorts function to check for running stack ports

### 修复

- fix(mirror): drop internal workspace packages from mirror package.json (#196)
- fix(mirror): whitelist R4 frontend submodules + gate mirror install-ability
- fix(submodules): repoint editor to pushed remote tip (fix #173) (#175)
- fix(build-desktop): vendor @forgeax/platform-io + agent-host, bake version via lib/version.ts (#165)

### 其他

- chore: set package version to 0.3.4 (#194)
- chore(submodules): bump cli/server/marketplace for LiteLLM image route (#193)
- chore(core): bump packages/core submodule pin → 535717e(autobug 6 批修复) (#189)
- chore(marketplace): bump submodule 8042ec0→0f00965 (propagate wb-reel「新的故事」pollution self-heal) (#190)
- release: v0.3.5 nightly release (#188)
- release: v0.3.4 nightly release (#186)
- chore(editor): revert flatten pin d022e40 → 86f21b6 (#185)
- chore(editor): bump submodule pin 196d2c9 → d022e40（多 mesh GLB 展平） (#184)
- website(games): add a whitelist for the public games gallery (block all by default) (#181)
- chore(marketplace): bump submodule to LiteLLM gateway routing (#16) (#174)
- chore(desktop): cross-platform build-desktop.ts + Windows-compat hardening (#158)
- chore(submodules): update submodule commits for build, interface, and server
- chore(git): update submodule to latest commit d1e2843
- chore(submodules): bump build/server/interface to Android packaging (#171)
- chore(website): add agent-reia to marketplace page reference list


---


## v0.3.5 — 2026-07-02 · Nightly Release

### 新特性

- feat(android): add Android packaging backend (build android-template + server AndroidPackager) (#178)
- feat(studio): bump editor+games pins for Play/Stop UI teardown (#183)
- feat(studio): inject game layout to the editor (editor no longer bakes .forgeax/games) (#180)
- feat(r4): land frontend app extraction + interface store slimming
- feat(viewport): 2x2 run x display redesign (#159)
- feat(build): enhance desktop build script and add tests
- feat(fx): add startBusyPorts function to check for running stack ports
- feat(git): enhance submodule update process with detailed reporting
- feat(fx): enhance update report formatting with color and improved structure
- feat(fx): add update result formatting and enhance update reporting

### 修复

- fix(submodules): repoint editor to pushed remote tip (fix #173) (#175)
- fix(build-desktop): vendor @forgeax/platform-io + agent-host, bake version via lib/version.ts (#165)

### 其他

- release: v0.3.4 nightly release (#186)
- chore(editor): revert flatten pin d022e40 → 86f21b6 (#185)
- chore(editor): bump submodule pin 196d2c9 → d022e40（多 mesh GLB 展平） (#184)
- website(games): add a whitelist for the public games gallery (block all by default) (#181)
- chore(marketplace): bump submodule to LiteLLM gateway routing (#16) (#174)
- chore(desktop): cross-platform build-desktop.ts + Windows-compat hardening (#158)
- chore(submodules): update submodule commits for build, interface, and server
- chore(git): update submodule to latest commit d1e2843
- chore(submodules): bump build/server/interface to Android packaging (#171)
- chore(website): add agent-reia to marketplace page reference list
- refactor(fx): improve table formatting in update report


---


## v0.3.4 — 2026-07-02 · Nightly Release

### 新特性

- feat(studio): bump editor+games pins for Play/Stop UI teardown (#183)
- feat(studio): inject game layout to the editor (editor no longer bakes .forgeax/games) (#180)
- feat(r4): land frontend app extraction + interface store slimming
- feat(viewport): 2x2 run x display redesign (#159)
- feat(build): enhance desktop build script and add tests
- feat(fx): add startBusyPorts function to check for running stack ports
- feat(git): enhance submodule update process with detailed reporting
- feat(fx): enhance update report formatting with color and improved structure
- feat(fx): add update result formatting and enhance update reporting

### 修复

- fix(submodules): repoint editor to pushed remote tip (fix #173) (#175)
- fix(build-desktop): vendor @forgeax/platform-io + agent-host, bake version via lib/version.ts (#165)
- fix(mirror): fix MIRROR_TOKEN leak + add PR-time mirror dry-run gate (#160)

### 其他

- chore(editor): revert flatten pin d022e40 → 86f21b6 (#185)
- chore(editor): bump submodule pin 196d2c9 → d022e40（多 mesh GLB 展平） (#184)
- website(games): add a whitelist for the public games gallery (block all by default) (#181)
- chore(marketplace): bump submodule to LiteLLM gateway routing (#16) (#174)
- chore(desktop): cross-platform build-desktop.ts + Windows-compat hardening (#158)
- chore(submodules): update submodule commits for build, interface, and server
- chore(git): update submodule to latest commit d1e2843
- chore(submodules): bump build/server/interface to Android packaging (#171)
- chore(website): add agent-reia to marketplace page reference list
- refactor(fx): improve table formatting in update report


---


## v0.3.3 — 2026-06-30 · Nightly Release

### 新特性

- feat(mirror): superproject push goes through PR + auto-merge (no more direct-to-main) (#143)
- feat(mirror): real build CI on the public superproject (typecheck + setup + smoke) (#139)
- feat: add desktop-build workflow + forgeax-release skill + mirror fix (#130)

### 修复

- fix(vite): repath @forgeax/types vite aliases to forgeax-contracts
- fix(mirror): drop platform-io unit test from public build CI (scrub breaks its fixture) (#141)
- fix(mirror): strip patchedDependencies from mirrored package.json (no patches/ or bun.lock shipped -> bun install failed) (#133)
- fix(mirror): create child mirror repos as public so recursive clone resolves them (#129)
- fix(submodules): point marketplace at bfc8af7 (mp main tip) to restore wb-character
- fix(mirror): publish agent-host/core/kernel to the OSS mirror
- fix(mirror): make mirror CI green + protect ForgeaX-Games/forgeax-studio main (#121)
- fix(scripts/proc): Windows resolveCmd 优先选 .cmd/.exe 可执行文件,避免无扩展名 shim 触发 ENOENT
- fix(ci): use 'bun fx setup' in nightly release pipeline (#116)
- fix(stop): never reap stop.ts's own launcher chain on Windows
- fix(packaging): bump cli/interface 指针 — 引擎重编修复 + 本地缓存清理
- fix(export): bump build pin + lock engine-gltf edge — fps export resolves on engine-src too
- fix(export): bump build pin — standalone export bootstrap + asset-first fix

### 其他

- refactor(deps): extract @forgeax/forgeax-core into standalone forgeax-core submodule
- refactor(deps): extract cli dependency closure into standalone submodules
- chore(stage-a): bump marketplace pointer (Meshy AI wb-ai-asset plugin) + add feature design docs
- chore(stage-a): bump cli/server submodule pointers to merged business-agnostic decouple
- chore(studio): bump server for wb-ai-asset static route
- release: v0.3.2 (#128)
- chore(studio): 更新 marketplace 子模块以纳入 wb-ai-asset
- chore(submodules): point editor + marketplace at relative-URL main HEADs
- release: v0.3.1 + fix interface submodule (#117)
- chore: update submodule references for interface and marketplace packages
- chore(studio): bump interface 指针到 e5e3635（Mesh 面板双击聚焦）+ 新增 UE5.8 对标设计文档
- chore: realign submodule pointers to pushed main SHAs
- refactor: drop dead top-level-engine branch in check-layers
- docs: reflect engine move to editor nested submodule


---


## v0.3.2 — 2026-06-30 · Release

### 新特性

- feat: enhance update command with submodule support
- feat(core/tui): migrate WeChat remote channel from wechaty to openclaw HTTP gateway

### 修复

- fix(mirror): publish agent-host/core/kernel to the OSS mirror
- fix(mirror): make mirror CI green + protect ForgeaX-Games/forgeax-studio main (#121)
- fix(scripts/proc): Windows resolveCmd 优先选 .cmd/.exe 可执行文件,避免无扩展名 shim 触发 ENOENT
- fix(ci): use 'bun fx setup' in nightly release pipeline (#116)
- fix(stop): never reap stop.ts's own launcher chain on Windows
- fix(packaging): bump cli/interface 指针 — 引擎重编修复 + 本地缓存清理
- fix(export): bump build pin + lock engine-gltf edge — fps export resolves on engine-src too
- fix(export): bump build pin — standalone export bootstrap + asset-first fix
- fix: realign asset GUID refs across all sample games + seed-once (#99)
- fix(autobug): 状态栏耗时计时器跳变(应墙钟平滑) (bug 001-status-elapsed-jumpy)
- fix(packaging): bump build/cli 指针 — standalone 导出 + 启动器关闭翻译

### 其他

- chore(studio): 更新 marketplace 子模块以纳入 wb-ai-asset
- chore(submodules): point editor + marketplace at relative-URL main HEADs
- release: v0.3.1 + fix interface submodule (#117)
- chore: update submodule references for interface and marketplace packages
- chore(studio): bump interface 指针到 e5e3635（Mesh 面板双击聚焦）+ 新增 UE5.8 对标设计文档
- chore: realign submodule pointers to pushed main SHAs
- refactor: drop dead top-level-engine branch in check-layers
- docs: reflect engine move to editor nested submodule
- build: add engine-src to root workspaces (export resolves nested engine)
- chore(build): bump pointer for engine path doc fixes
- mirror: source engine from editor nested submodule
- chore(cli): bump pointer for engine nested path migration
- build: repoint build/deploy scripts to editor nested engine
- build: remove top-level engine submodule, resolve via editor nested
- chore(editor): bump pointer for nested engine align 528b3ba → cbd4090
- chore: update changelog to reflect command structure changes
- chore: update changelog and refine command structure
- chore: consolidate command entry points and enhance update functionality
- refactor: enhance update command behavior and tests
- refactor: update stash handling in fx scripts
- refactor: unify command entry points with `bun fx` for setup and start
- ci: upgrade to nightly release pipeline with security scan + desktop builds (#92)
- chore(ui): bump marketplace for wb-character themed-exception docs
- chore(ui): bump marketplace for wb-character SpriteEditPanel outline fix
- refactor(ui): bump marketplace for wb-character/wb-gen3d CSS tokenization
- chore(submodules): bump marketplace — wb-character catch-up + UI LOOP handoff
- chore(submodules): bump marketplace — wb-gen3d UI optimization LOOP plan



## v0.3.0 — 2026-06-29 · 公开发布 · Visual Editor + ECS 引擎默认 + 全栈 i18n

> 面向公开镜像 [ForgeaX-Games/forgeax-studio](https://github.com/ForgeaX-Games/forgeax-studio) 的语义化版本。
> 内部细粒度版本见下方 `v0.5.xx.xxx` 条目。

### 用户可感知

- **【特性】可视化场景编辑器（Edit/Play）** — dock-panel 编辑器,gizmos / inspector / hierarchy / assets 面板 / undo-redo。Edit 和 Play 共享同一份落盘场景,切换无需导出。
- **【特性】ECS 引擎成为默认** — 预览运行时从 Three.js 切换到 forgeax-engine ECS + WebGPU 渲染器。CSM 阴影、PBR、MSAA、粒子系统、sprite atlas 动画全部上线。
- **【特性】全 UI i18n** — 英文 / 中文,运行时可切换;编辑器面板跟随宿主语言。
- **【特性】新示例游戏** — cow-survivor、hellforge、fps、spin-cube、shoot-opt 作为共享示例发布。
- **【特性】wb-anim & wb-skill 工作台** — 动画（Spine/视频）和 VFX 管线从 wb-character 拆出为独立插件。
- **【特性】wb-reel 交互影片工作台** — 叙事/影片工作台,含分镜、3D 镜头编辑器、视频生成管线。
- **【特性】Agent 人格扩展** — 27 个命名 agent personas,含 portrait 状态机（WEBM）;ADR-0019 same-portrait grouping。
- **【特性】Console & Network 面板** — 游戏/编辑器控制台流捕获 + Network 面板（fetch/XHR/WS）。
- **【体验】进程组生命周期管理** — 服务在独立进程组中启动;`stop.sh` 按组清理,不再有僵尸进程。
- **【体验】桌面端稳定性提升** — Tauri 2 应用接管完整 dev-stack 生命周期;WebKit IBL/pointer-lock 防护。

### 内部 / 架构

- **【架构】BREAKING: Preview 运行时引擎从 Three.js 切换到 forgeax-engine ECS** — 存量 `.forgeax/games/<slug>/` 中的 THREE.js 游戏代码合并后将无法运行,需按新 scaffold 重写为 ECS 范式。
- **【架构】最新引擎** — world-scoped plugin build、handle codec、FBX importer、render-graph、wgpu-wasm deterministic mangling。
- **【架构】wb-character tool id 迁移** — `character:generate-spine` → `anim:generate-spine`、`character:generate-video` → `anim:generate-video`、`character:generate-vfx` → `skill:generate-vfx`。

---

## v0.5.20.498 — 2026-05-20 · 引擎多光源 + Tonemap MVP + harness 轻量模式

**代码增量**:9 仓 **+61,464 / -8,244**(净 +53,220)· 主仓 +3 / -3 · 1 commit 当日
**主题**:从上游同步 engine + harness + server 三个 submodule。引擎拿到 PointLight/SpotLight + Reinhard tonemap + 1.5/1.6/1.7 教程对齐;harness 把 bug-fix / small-feat 模式合并成统一的"轻量模式";server runtime v3 落地下三层(fs / llm / message-prep)+ smoke 测试。

### 用户可感知

- **【特性】** 引擎多光源支持 · `PointLight` + `SpotLight` 上线,衰减用 PBR 物理正确公式(`engine #164`)。
- **【特性】** HDR Tonemap MVP · `Camera` 增加 Reinhard-extended 三件套 + HDR render target,新示例 `apps/hello-tonemap`(`engine #165`)。
- **【特性】** learn-render 教程 1.5/1.6/1.7 对齐 · 配合 V-2/V-3 折叠,渲染入门教程更连贯(`engine #163`)。
- **【修复】** 引擎不再强制编译 PBR/unlit shader · clear-pass-only 路径下不必要的编译已去掉(`engine #166`)。

### 内部 / agent 视角

- **【架构】** harness 把 `bug-fix` 和 `small-feat` 模式合并成统一的"轻量模式" · 用 `tweak-*` tag 替代旧 `feat-small`,scaffold 单一化。
- **【架构】** server runtime v3 五层架构落地下三层 · `fs` / `llm` / `message-prep` 三个新模块 + smoke 测试。
- **【修复】** harness `cleanup-post-merge` 加三层 CWD gate · 防止误删非 worktree 路径。

---

## v0.5.18.486 — 2026-05-18 · Bus 接进 UI · wb-* 工作台铺底

**代码增量**:9 仓 **+10,246 / -1,741**(净 +8,505)· 主仓 +251 / -54 · 7 commits 当日
**主题**:把 server 端的 Bus 抽象接进 UI(Sidebar / TopBar / Composer / Dashboard / ChatPanel 5 处都能看见)+ wb-* 工作台开了 11 个坑位 + 角色锻造工坊(wb-character-forge)作为第一个完整插件落地。

### 用户可感知

- **【特性】关掉浏览器,AI 继续做游戏** · 以前关页面 agent 就停了,现在它在后台一直跑,下次打开看进度。
- **【特性】聊天框升级 `@` 召唤队友 / `/` 触发技能** · `@` 弹出团队成员选择(策划员/美术/写代码),`/` 弹出技能(关卡/数值/角色锻造)。
- **【特性】4 家 AI 一键切换** · Composer 左下角下拉,Claude / ChatGPT / Cursor / 自家 forgeax 随便切。
- **【特性】历史聊天完整回放** · 重开同一会话,AI 之前所有动作(含子 agent 子任务)按时间线播一遍。
- **【特性】角色锻造工坊上线** · 填名字 + 一句描述 → 立绘 + 三视图 + 4 向行走 sprite + mini canvas 试玩,3 家图像 AI 自动 fallback(Seedream → Gemini → Azure)。
- **【特性】任意文件夹打开当工坊** · TopBar 项目切换器 + FsBrowser + `_default` 模板,不再绑死特定目录。
- **【特性】wb-* 工作台 11 个坑位** · 角色 / 立绘锻造 / 动画 / 数值 / BGM / 场景 / 代码 / 道具 / UI / 技能 / 外观。
- **【体验】顶部 6 个状态灯 + 底部实时事件流** · skill / tool / agent / cli-provider 红绿灯随时可见,事件流不再黑盒。
- **【体验】Dashboard 加 Agents Hub 面板** · session 内所有 sub-agent 实时进度 + role-tribe 着色。
- **【体验】Settings 浮层 · 一处填多种 AI key** · 不再 ssh 改 .env;7 把 key 实时生效(ANTHROPIC / OPENAI / GEMINI / ARK_IMAGE / ARK_VIDEO / AZURE_GPT_IMAGE / LITELLM_PROXY)。
- **【体验】三栏自由拖宽度 + 右键菜单 + 项目左上切换器**。
- **【体验】Session / Thread / Agents 三合一视图** · AgentsPanel 现在是"本 session 在用的 agent",不是全局。

### 内部 / 架构

- **【架构】ForgeaXBus 总线 v1 跑通** · Plugin Registry / EventBus (in-memory pubsub) / Permission Engine (minimatch) / SandboxedFsAPI + advisory file-lock · 25 颗粒 · 425 单测。第三方 plugin 能被沙盒地 load 进 server 跑。
- **【架构】UI 5 路 surface 接进 Bus** · Sidebar / TopBar / Composer / Dashboard / ChatPanel,任一 chip / row 反查 plugin。
- **【架构】4 个 cli-provider entry 落地** · `cli-bc` / `cli-codex` / `cli-cursor-agent` / `cli-forgeax`,后两者通过 subprocess,forgeax 是 long-running daemon。
- **【架构】RichInput + PillChip + menuRegistry** · Composer 从 textarea 改成富文本 + pill 实体引用。
- **【基建】CHANGELOG 制度上线 · `v0.M.D.N` 版本号** · 本文件 + `scripts/version.sh` + `/api/version` + 左下角徽章。
- **【基建】.env.example 加 5 把多模态 key + deploy.sh 交互式询问**。

### 文档

- **【文档】ForgeaX v1 always-on 平台 10 篇 STABLE 锁定** — `00-GOALS` always-on / `01-ARCHITECTURE` / `02-DECISIONS` / `03-WORKBENCH-CATEGORIES`(11 类 wb)/ `04-SELF-EVOLUTION` / `05-ROADMAP`(215 颗粒)/ `06-PLATFORM-DESIGN` / `07-REVIEW-FINDINGS` / `08-V2-VISION` / `09-ACCEPTANCE-CRITERIA`。
- **【文档】UI-FRAMEWORK-PROPOSAL + DUAL-MODALITY-UI + AGENTS-HUB-PROPOSAL** — P5-P8 UI 颗粒 + 玩家/AI 共操作 + agent 中枢面板。

### 引擎线(Forgeax · 独立云端开发)

- **【特性】LearnOpenGL §1.getting-started 7 个 demo** + 引擎内化 image / textures / input。
- **【架构】单数 MeshRenderer + Handle\<MaterialAsset\>** — 原来 MeshRenderer + MaterialRenderer 两个 component,现在合并。
- **【架构】Console 依赖反转 via Registry interface + ECS plugin 抽取(kubectl 第 4 路)** — 引擎工具链可插拔。
- **【架构】ECS spawn / addComponent 三层 default-value fallback chain**(PR #134) + 'string' schema vocab + 内置 Name component。
- **【特性】glTF 2.0 Tier-B loader via asset system** — 直接载入业界标准 `.glb` 模型(PR #123)。
- **【架构】SceneAsset(AssetUnion 第 6) + world.sceneInstances 机制**(PR #116)。
- **【架构】Renderer.readPixels() 收口 9-app `__captureXxx` 重复代码**。
- **【架构】Two-channel quality gate(Biome + ts-morph @internal)**(PR #117)。
- **【文档】Harness:closed-loop charter v2(F1-F4 / P1-P5 两段式)+ step-plan §3 mandatory → opt-in + lint_plan_strategy.py 量化 gate**。

---

## v0.5.17.479 — 2026-05-17 · UI 第一公民化 · 7 件能感知到的新东西

**代码增量**:9 仓 **+79,731 / -8,706**(净 +71,025)· 主仓 +212 / -152 · 140 commits 当日
> ⓘ 5-17 单日 140 commit,大多是 phase3.x / phase4.x 增量收口 — 主要交付已合并到上面 5-18 段。

**这天交付了:** 任意文件夹开 workspace · Settings 浮层取代 Bus mode tab · Session/Thread/Agents 三合一 · wb-character-forge 首个 e2e 插件落地 · AgentsHub 面板上线 · TopBar / Composer / ChatPanel 状态灯成体系。详细参考 [`forgeax-dev-diary/2026-05-18/SUMMARY.html`](../forgeax-dev-diary/2026-05-18/SUMMARY.html)。

---

## v0.5.16.339 — 2026-05-16 · UI 颗粒图 + Bus 上 UI + AgentsHub

**代码增量**:9 仓 **+44,965 / -4,144**(净 +40,821)· 主仓 +73 / -73 · 67 commits 当日
**主题**:ForgeaX 自身的产品形态确认(EA 装机 + 源码两种装法)+ UI / 双模态 / AgentsHub 三份配套设计稿。当晚 AgentsHub 落代码。

- **【文档】STRATEGY-PLAN-v3.md/.pdf/.html** · ForgeaX 产品形态收敛:本地深度版 · EA 装机 + 源码两种装法 · 3 段用户漏斗(网页入口 → EA → 源码)。
- **【文档】UI-FRAMEWORK-PROPOSAL.md** · P5/P6/P7/P8 颗粒图(Primitives → Command Registry → Theme + LayoutService → Plugin Runtime)。
- **【文档】DUAL-MODALITY-UI.md** · 玩家手点 / AI 通过 Bus emit 改的是同一份 game,host + plugin 同构 surface。
- **【文档】AGENTS-HUB-PROPOSAL.md** · agent 中枢面板设计 → 当晚落 `AgentsHub.tsx`。
- **【架构】Bus 第一公民化第一步** · Sidebar bus health 灯 + BusAdminPanel 顶级 mode tab + filter bar + row expand + chip → kind flash deep-link。
- **【特性】TopBar bus / skill / tool / agent LED count chip(role-tribe 着色)**。
- **【特性】Composer cli bus pill + `@` button → bus+marketplace agent mention popover + `/` slash → bus skills**。
- **【特性】Dashboard Overview Bus card + plugins-by-kind bars + ThreadsList/RunsList provider role dot**。
- **【实验】v3 daemon(`~/.forgeax/auto-dev/`)跑 7h ~40 commit 全 visible delta** · 已暂停,等 P5 UI Primitives 阶段重启。

---

## v0.5.15.272 — 2026-05-15 · v1 工程目标锁定 · 10 篇 STABLE 文档

**代码增量**:9 仓 **+75,282 / -3,692**(净 +71,590)· 主仓 +147 / -75 · 33 commits 当日
**主题**:把 ForgeaX v1 重新定位写成 10 篇文档,后两天 700+ commit 都在按这套兑现。

- **【文档】10 篇 v1 STABLE 锁定** · `00-GOALS`(always-on / 三层全插件化)/ `01-ARCHITECTURE`(ForgeaXBus 单进程 + 沙盒)/ `02-DECISIONS` / `03-WORKBENCH-CATEGORIES`(11 类 wb)/ `04-SELF-EVOLUTION` / `05-ROADMAP`(215 颗粒)/ `06-PLATFORM-DESIGN` / `07-REVIEW-FINDINGS` / `08-V2-VISION` / `09-ACCEPTANCE-CRITERIA`。
- **【架构】ForgeaXBus 总线代码骨架** · `bus skeleton + types(identity/events/perms/registry)` · `phase1.10 EventBus in-memory(13 单测)` · `phase1.14 PermissionEngine + minimatch(22 单测)` · `phase1.17/18 SandboxedFsAPI + advisory file-lock(17 单测)` · `phase1.19/20 公共 export + @forgeax/bus paths alias`。
- **【特性】(GitHub PR)聊天工具调用嵌在 in-progress todo 下面**(#11)· **SubAgentCard parity + 抽出 message-parts/**(#10)· **统一流式管道 live + replay 共享 callbacks**(#9)。
- **【体验】resizable sidebar / chat / wb-bottom panels** · 三栏自由拖宽度。

---

## v0.5.14.239 — 2026-05-14 · 工作台分类提案 + 引擎架构提案

**代码增量**:9 仓 **+77,294 / -4,986**(净 +72,308)· 主仓 +1,048 / -3 · 4 commits 当日

- **【文档】WORKBENCH-PROPOSAL.html** · 列 11 类工作台(后续 `wb-*` 矩阵蓝图):角色 / 立绘锻造 / 动画 / 数值 / BGM / 场景 / 代码 / 道具 / UI / 技能 / 外观。
- **【文档】ARCH-PROPOSAL.html** · 引擎架构分层提案(rhi / ecs / math / wgpu)。
- **【基建】bump packages/cli 接 upstream agentteam-os-future + chat --stream-json** · cli 跟上游 1466 commit 同步完成。
- **【特性】Dashboard 加本地监控面板** · 第一次能在 studio 里看 daemon 状态。
- **【特性】多 agent 并行长跑成真** · 同时开多个对话窗口,关浏览器 agent 不死,重开继续看回复。

---

## v0.5.13.235 — 2026-05-13 · 开源准备 + studio HMR 独立化 + bc-game cron

**代码增量**:9 仓 **+51,904 / -6,584**(净 +45,320)· 主仓 +2,186 / -390 · 22 commits 当日
**主题**:为 Apache 2.0 公开化做最后准备 + 大重构把 studio 从 `packages/forgeax/` 解耦。

- **【基建】Apache 2.0 LICENSE + NOTICE + 4 个公开 ADR** · 让开源有"为什么这么做"的依据。
- **【基建】`.github/` PR + 3 issue 模板 + CODEOWNERS**。
- **【架构】refactor: studio HMR 独立化** · games 移到 instance `.forgeax/`,`packages/forgeax/` 变成纯发布产物目标。
- **【实验】bc-game cron** · 自动跑 27 步 vibe-coding 把 MVP 跑通(每分钟推进一步)。
- **【文档】MISSION.md** · 把 ForgeaX 的使命用一页讲清。
- **【基建】Playwright MCP project-level override** · 输出落 `.forgeax/playwright-mcp` 不污染主仓。
- **【修复】sanitize public references** · 去掉所有内部竞品 / 项目 / 技术名(为开源)。

---

## v0.5.12.213 — 2026-05-12 · server 测试覆盖 + cli-provider UX 整合

**代码增量**:9 仓 **+88,452 / -11,865**(净 +76,587)· 主仓 +1,358 / -635 · 168 commits 当日
**主题**:server 单元测试从 64 → 105 个,配套小修小补和 UI 抽取复用。

- **【体验】ProviderBadgePill 抽出复用** · 多处显示 provider 徽章不再重复实现。
- **【架构】cli-providers 测试覆盖大跃进** · server 单测 64 → 105 / expects 166 → 227 / probes 10 → 11。
- **【修复】SAFE_ENV_KEYS 白名单 + maskKey shape 契约测试** · 防误吐 key 进 SSE。
- **【修复】GET /api/files dir-vs-missing 区分** · 老版本目录被当成"文件不存在"。
- **【修复】writeFileSafe dir-target guard** · 防把目录路径误传成文件写。
- **【修复】subagent.ts sessionId guard** · 子 agent 边界 session 丢失。
- **【修复】silent-done detector 计 tool-call 为 work** · 子 agent 静默判定误判。
- **【修复】friendlyPath normalize trailing slash** · path 显示一致性。
- **【体验】interface cross-tab sync** · 多 tab 打开 Studio 时 agent 状态同步。

---

## v0.5.11.48 — 2026-05-11 · DAY 1 · forgeax-studio monorepo 诞生 🎂

**代码增量**:9 仓 **+119,816 / -18,827**(净 +100,989)· 主仓 +1,001 / -311 · 45 commits 当日(含 8 子模块 init import)
**主题**:仓库出生。27 步 cron 自动建出 MVP,浏览器开网页跟 AI 聊天能做出旋转立方体。

- **【特性】ForgeaX MVP `./run.sh` 跑通** · 27 步自动化 cron 一个晚上把 7 仓 build 出来,浏览器开网页跟 AI 聊天就出一个 Three.js 旋转立方体。
- **【架构】forgeax-studio monorepo 初始化 + 8 子模块 SHA pin 机制** · cli / server / interface / engine / harness / build / marketplace / studio-harness。
- **【架构】scripts/deploy.sh 一键设置 + scripts/run.sh 4 服务并行启动 + scripts/build.sh 产物打包(recipe → output → publish 三段)**。
- **【特性】第一波 UI 框架** · ProjectSwitcher / SessionSwitcher / GameSwitcher / SubAgentSwitcher / Console tab(右侧引擎控制台)。
- **【特性】SubAgentCard team rail** · 多 agent 同 session 横向可见。
- **【架构】sessions agents / delete + emitterId on SSE** · 多 agent 路由的底层。
- **【体验】TopBar dropdown clipping fix** · 下拉不再被截。
- **【体验】Markdown editable preview** · 文档预览支持编辑。
- **【体验】项目 = 游戏 UX 统一** · "项目"在用户语义 / UI / 磁盘三处指向同一个 `games/<slug>/`。
- **【文档】INTERFACES.md / MISSION.md / SPEC.md / SKILL.md** · 第一版工程文档。

---

## 之前 · 2026-05-09 → 10 · 前史 / 设计阶段(无 commit)

仓库 5-11 才建,之前是设计期产出文档:

- **2026-05-09 · 全栈架构 v1** · Director / CLI / Harness / Engine / Game 四层 + HARNESS-BOOTSTRAP + 4 个 repo-map(agents / backend / cli / engines)+ FORGEAX mission。
- **2026-05-10 · architecture-build-runtime** · 把 build-time 跟 runtime 分开 → `packages/build` 的 recipe → output → publish 设计模式诞生。

---

## 📦 自动化

| 命令 | 用途 |
|---|---|
| `bash scripts/version.sh` | 输出当前版本 `v0.5.18.486` |
| `bash scripts/version.sh json` | 输出 `{ version, sha, date, totalCommits }` |
| `bash scripts/version.sh banner` | 启动横幅(`scripts/run.sh` 用) |
| `bash scripts/version.sh check` | 比对 CHANGELOG 顶版本 vs git 最新,差太多警告 |
| `bash scripts/version.sh stats YYYY-MM-DD` | 当日跨 9 仓 +X/-Y 统计(填"代码增量"行用) |
| `GET /api/version` | server 启动后查 |

