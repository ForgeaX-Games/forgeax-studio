<div align="center">

# ⚡ ForgeaX Studio

**English** · [简体中文](./README.zh-CN.md)

### 🌐 [forgeax.github.io](https://forgeax.github.io) — homepage · live examples · docs

### Chat your way to a running game.

Describe what you want in plain language — an AI agent writes **real engine
code**, and your game hot-reloads in a **live WebGPU preview** while you watch.
Then refine it by hand in a visual scene editor. Same scene, same engine, both ways.

`Apache-2.0` · `Bun + Vite monorepo` · `WebGPU ECS engine` · `Desktop app (Tauri 2)`

</div>

---

**ForgeaX Studio is an AI-native game studio.** You talk to **Forge**, an
orchestrator agent. She plans the game, delegates to a team of specialist
sub-agents (core-loop, systems design, narrative, art, coding), and writes
**actual ECS code against the ForgeaX engine**. The center pane renders it live on
WebGPU and hot-reloads on every edit — the real game, not a mockup — and you can
drop into a visual editor to tweak the scene directly at any time.

## ✨ Why ForgeaX is different

- **It runs the real engine, not a sandbox.** [`forgeax-engine`](https://github.com/ForgeaX-Games/forgeax-engine)
  is a from-scratch **ECS + WebGPU** engine (hot paths compiled **Rust → wasm**), built
  *AI-first* and benchmarked for pixel-parity against Three.js. What the agent writes is
  what ships.
- **A whole studio team, not one chatbot.** The agent layer is an explicit, in-memory
  **AgentTree** (router / admin / worker) with named personas that each *own* a slice of
  your project's files — delegation you can see and trust.
- **What you edit is what you play.** The visual editor and the running game share one
  on-disk scene, so there is no "export to test" round trip — flip to Play and you're
  inside the real game; flip back and your edits are intact.
- **One process, instant boot.** The entire runtime is a single Bun server — no Docker,
  no instance provisioning. `bun fx start` and you're live in seconds.
- **Web and desktop from one codebase.** The same UI runs in the browser and as a native
  desktop app via Tauri 2.

## 🆕 What's new in v0.2.0

- **Guided first-run onboarding** — pick a provider (OpenRouter by default) and start building in minutes.
- **Author games in the visual editor** — an open-project flow + guided game-creation entry; the editor writes scene assets straight to disk.
- **Extend the workbench in-studio** — a plugin-author panel + host SDK to build your own visual workbench plugins.
- **A bigger studio team** — new scene-pipeline agents (director / sino / mira) join Forge's crew.
- **Latest engine** — world-scoped plugin build + handle codec.
- **Cleaner asset pipeline** — workbench battery/template paths and preset assets are now ASCII-only, for cross-platform, contributor-friendly checkouts.

→ Full notes on the [Releases](https://github.com/ForgeaX-Games/forgeax-studio/releases) page.

## 🔁 How the loop works

1. You tell **Forge** what game you want.
2. Forge plans it and delegates design + code to specialist sub-agents.
3. The agents write ECS code and assets to disk; a file watcher notifies the engine.
4. The engine **hot-reloads** and the live WebGPU preview updates instantly.
5. You steer in chat, or open the **visual editor** to adjust the scene by hand — then
   hit Play to run it for real.

## 🚀 Quickstart

```bash
git clone --recurse-submodules https://github.com/ForgeaX-Games/forgeax-studio.git
cd forgeax-studio
bun fx setup         # deps + engine/wasm build; scaffolds .env (set ANTHROPIC_API_KEY)
bun fx start         # starts Studio and opens the default web client
# open http://localhost:18920 and tell Forge what to build
```

This superproject wires the engine, server, UI, editor, marketplace and games as
git submodules under `packages/`. Each submodule is its own repo in the
[ForgeaX-Games](https://github.com/ForgeaX-Games) org, with its own deep-dive README.

## 📦 Packages (submodules)

| package | what |
|---|---|
| [`engine`](https://github.com/ForgeaX-Games/forgeax-engine) | AI-first ECS + WebGPU engine, hot paths Rust → wasm, built to surpass Three.js |
| [`server`](https://github.com/ForgeaX-Games/forgeax-server) | runtime core — one Bun process, in-process agent kernel, file/HMR bridge (:18900) |
| [`interface`](https://github.com/ForgeaX-Games/forgeax-interface) | three-column Studio UI + Tauri 2 desktop shell |
| [`editor`](https://github.com/ForgeaX-Games/forgeax-editor) | visual scene editor — Edit/Play on one disk-backed scene |
| [`cli`](https://github.com/ForgeaX-Games/forgeax-cli) | multi-agent orchestration kernel — AgentTree, XML ledger, slot prompts |
| [`marketplace`](https://github.com/ForgeaX-Games/forgeax-marketplace) | persona agents · skills · visual workbench plugins (content-as-data) |
| [`games`](https://github.com/ForgeaX-Games/forgeax-games) | shared library of real, agent-authored games |
| [`build`](https://github.com/ForgeaX-Games/forgeax-build) | build & packaging — recipe + validator pipeline |

## 🖥️ Runtime forms

One codebase, three forms via injected environment: **web/dev** (browser on source, HMR),
**desktop/dev** (Tauri window on the dev server), and a **packaged desktop app**. See
[DEVELOPMENT.md](./DEVELOPMENT.md).

## 🤝 Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md); security via [SECURITY.md](./SECURITY.md).

## 📄 License

[Apache-2.0](./LICENSE) © 2026 ForgeaX Contributors.
