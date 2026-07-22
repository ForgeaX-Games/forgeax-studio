<div align="center">

# ⚡ ForgeaX Studio

[English](./README.md) · **简体中文**

### 🌐 [forgeax.github.io](https://forgeax.github.io) — 官网 · 在线示例 · 文档

### 用对话,做出能跑的游戏。

用大白话描述你想要什么 —— AI agent 写出**真实引擎代码**,游戏在**实时 WebGPU 预览**里热重载,
所见即所得;再到可视化场景编辑器里手动打磨。同一个场景,同一台引擎,两种方式。

`Apache-2.0` · `Bun + Vite 单仓` · `WebGPU ECS 引擎` · `桌面 app(Tauri 2)`

</div>

---

**ForgeaX Studio 是一个 AI 原生游戏 studio。** 你跟编排 agent **Forge** 对话。她规划游戏,委派给
一支专精子 agent 团队(核心循环、系统设计、叙事、美术、编码),然后**用 ForgeaX 引擎写真实 ECS
代码**。中栏用 WebGPU 实时渲染、每次改动热重载——是真游戏,不是 mockup——你也随时可以进可视化
编辑器直接调整场景。

## ✨ ForgeaX 为何不同

- **它运行真实引擎,而非沙盒。** [`forgeax-engine`](https://github.com/ForgeaX-Games/forgeax-engine)
  是从零构建的 **ECS + WebGPU** 引擎(热路径 **Rust → wasm** 编译),AI 优先设计,并以对 Three.js
  的逐像素对齐做基准。agent 写的,就是发布的。
- **一整支工作室团队,而非一个聊天机器人。** agent 层是显式的内存中 **AgentTree**(router /
  admin / worker),具名人格各自*拥有*你项目文件的一部分——可见、可信的委派。
- **所编即所玩。** 可视化编辑器与运行中的游戏共享同一份落盘场景,没有「导出去测」的往返——切到
  Play 你就在真游戏里,切回来编辑原样还在。
- **一个进程,即时启动。** 整个运行时是单个 Bun server——无需 Docker、无需实例供给。`bun fx start`
  几秒就活。
- **一份代码,Web 与桌面通吃。** 同一个 UI 既跑浏览器,也通过 Tauri 2 作为原生桌面应用运行。

## 🆕 v0.3.21 更新

- **TUI:键盘驱动的 agent 终端** —— 直接在终端里驱动 Forge 与整个 agent 运行时(F1/F2/F3 验收通过);适合无头与 SSH 场景。
- **工作台全面国际化** —— 角色、AI 资产、3D 生成三个工作台在所有支持语言下完全翻译。
- **3D 资产管线修复** —— 生成的 3D 模型创建后即刻以正确 PBR 材质在实时视窗中渲染。
- **API Key 配置精简** —— Settings 改用单个 LiteLLM 代理端点路由到所有模型,不再逐个供应商配置密钥。
- **CLI 更稳** —— 工具调用自动注入项目 slug(告别「project not found」),处理器错误返回结构化错误码。
- **新游戏场景包** —— 共享游戏库新增 Slagdeep Hollow 可编辑场景与 Rogue Encampment 地板模型。

→ 完整说明见 [Releases](https://github.com/ForgeaX-Games/forgeax-studio/releases) 页。

## 🔁 闭环如何运转

1. 你告诉 **Forge** 想做什么游戏。
2. Forge 规划,并把设计 + 代码委派给专精子 agent。
3. agent 把 ECS 代码与资产写到磁盘;文件 watcher 通知引擎。
4. 引擎**热重载**,实时 WebGPU 预览即刻更新。
5. 你在聊天里操舵,或打开**可视化编辑器**手动调整场景——再按 Play 真实运行。

## 🚀 快速开始

```bash
git clone --recurse-submodules https://github.com/ForgeaX-Games/forgeax-studio.git
cd forgeax-studio
bun install         # 装依赖 + 构建引擎/wasm;生成 .env(填 ANTHROPIC_API_KEY)
bun fx start         # 启动 Studio 并打开默认 Web 客户端
# 打开 http://localhost:18920,告诉 Forge 你想做什么
```

本超级仓以 git submodule 形式把引擎、server、UI、编辑器、市场与游戏挂在 `packages/` 下。每个
子模块都是 [ForgeaX-Games](https://github.com/ForgeaX-Games) 组织里的独立仓,各自带有详尽 README。

## 📦 各包(子模块)

| 包 | 说明 |
|---|---|
| [`engine`](https://github.com/ForgeaX-Games/forgeax-engine) | AI 优先的 ECS + WebGPU 引擎,热路径 Rust → wasm,目标超越 Three.js |
| [`server`](https://github.com/ForgeaX-Games/forgeax-server) | 运行时核心——单 Bun 进程、进程内 agent 内核、文件/HMR 桥(:18900) |
| [`interface`](https://github.com/ForgeaX-Games/forgeax-interface) | 三栏 Studio 界面 + Tauri 2 桌面外壳 |
| [`editor`](https://github.com/ForgeaX-Games/forgeax-editor) | 可视化场景编辑器——Edit/Play 同享一份落盘场景 |
| [`orchestrator`](https://github.com/ForgeaX-Games/forgeax-orchestrator) | 多 agent 编排层——AgentTree、XML 账本、slot 提示 |
| [`marketplace`](https://github.com/ForgeaX-Games/forgeax-marketplace) | 人格 agent · 技能 · 可视化 workbench 插件(内容即数据) |
| [`games`](https://github.com/ForgeaX-Games/forgeax-games) | 真实、由 agent 编写的共享游戏库 |
| [`build`](https://github.com/ForgeaX-Games/forgeax-build) | 构建与打包——recipe + validator 流水线 |

## 🖥️ 运行形态

一份代码,靠注入环境变量呈现三种形态:**web/dev**(浏览器跑源码、HMR)、**桌面/dev**(Tauri 窗口
指向开发服务器)、以及**打包桌面 app**。详见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 🤝 参与贡献

欢迎 PR —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md);安全问题见 [SECURITY.md](./SECURITY.md)。

## 📄 许可

[Apache-2.0](./LICENSE) © 2026 ForgeaX Contributors。
