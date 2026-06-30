# forgeax-core

forgeax 的**自研原生内核**(`@forgeax/forgeax-core`)—— 自包含的单 agent 运行时:agent loop / events / history / capability / provider / compaction / 记忆内核。**可原生内嵌**,也以 drop-in 方式实现 `@forgeax/agent-runtime` 的 `AgentKernel` 契约,作为 cli 编排层的**推荐内核**。

## 与 cli 的关系(DIP,非硬依赖)

`forgeax-cli` 是**内核无关**的编排层:它只 import 中立注册表 `@forgeax/agent-runtime`,绝不静态 import 本包。core 通过 **`forgeax-core --serve` 子进程 + unix-socket JSON-RPC** 被接入(产品壳在 boot 时把「连接式 adapter」注册进共享 registry;serve 入口经 `@forgeax/forgeax-core/cli` 包解析定位)。因此:

- 想用**自研原生内核** → 拉本仓,产品壳注册它(参考 forgeax-server 的 `forgeax-core-adapter`),`FORGEAX_KERNEL_IMPL=forgeax-core`(默认)。
- 不拉本仓 → cli 仍能用内置 spawn 系内核(claude-code / codex / cursor / codebuddy),自动 fallback,不失能。

## 依赖闭包

core 的 `@forgeax` 依赖 = **`@forgeax/contracts`**(`@forgeax/agent-runtime` + `@forgeax/types`)。消费时与 `forgeax-contracts` 一起以 `packages/*` 同层布局拉齐(tsconfig 源路径覆盖按 `../../contracts/...` 解析)。

## 形态

全裸 TS,无 build,bun 直跑源码。`bin: forgeax-core`(`src/cli/main.ts`);serve 入口 export `./cli`。

## 验证

```bash
# 需在含 packages/contracts 同层布局的工作区内
bun run typecheck
bun run test
```
