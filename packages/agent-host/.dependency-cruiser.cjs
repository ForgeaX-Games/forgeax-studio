/** @type {import('dependency-cruiser').IConfiguration} */
//
// Boundary lint for forgeax-agent-host (@forgeax/agent-host) — ring-0 sidecar / TCB.
//
// 设计铁律 (评审稿 §3 + 四层架构核查): agent-host 是**协议无关的进程管家**,
// 自含 (self-contained) —— 它**零 @forgeax 业务依赖**:消费方 (server/cli) 依赖它,
// 它不反依赖任何 @forgeax 包。它也**绝不碰 LLM SDK** (内核在子进程里讲协议,
// host 只搬字节)。agent-host/src 只认:
//   - 自身相对路径 (./ ../)
//   - node: builtins
// (实测:src/ 当前 0 个非相对/非 node: import —— 本规则把这一不变量固化进 CI。)
//
// 与 packages/core / packages/cli 的 .dependency-cruiser.cjs 同形态 (三核心包统一守门)。
// 运行: bun run lint:boundaries  (= depcruise -c .dependency-cruiser.cjs src)
//
module.exports = {
  forbidden: [
    {
      name: 'agent-host-self-contained',
      severity: 'error',
      comment:
        'ring-0 sidecar 是自含 TCB:src/ 只许 import 自身相对路径 + node: builtins。' +
        '任何跨包源码 import (forgeax-core / forgeax-cli / server / interface / studio / ' +
        '其它 @forgeax/* —— workspace 解析后落到 ../<pkg>/src) 一律禁止:依赖方向只能 ' +
        'host ← 消费方,反向会让 sidecar 倒挂业务层 (评审稿 P4 修过一次,勿回退)。' +
        '** allow-list 写法**:因 @forgeax/* 经 workspace symlink 解析成 ../<pkg>/src ' +
        '真实路径,specifier 级 `^@forgeax/` 匹配不到 resolved path,故改判「凡不在 src/、' +
        '不在 node_modules、又非 node 核心模块」者即越界 (覆盖一切跨包源码边)。',
      from: {
        path: '^src/',
      },
      to: {
        // 越界 = 解析结果既不在自身 src/、也不在 node_modules、且不是 node 内建。
        pathNot: ['^src/', 'node_modules'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'agent-host-no-llm-sdk',
      severity: 'error',
      comment:
        '协议无关进程管家:绝不引入 LLM SDK / 内核适配 (@anthropic-ai/* / @openai/* / ' +
        'claude-code-sdk / *-kernel)。内核跑在被托管的子进程里,host 只做 spawn/监督/IPC 搬运。',
      from: {
        path: '^src/',
      },
      to: {
        path: [
          '@anthropic-ai/',
          '@openai/',
          'claude-code-sdk',
          'codex-kernel',
          'kernel-adaptors',
        ],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'agent-host/src 内部不允许出现循环依赖。',
      from: {
        path: '^src/',
      },
      to: {
        circular: true,
      },
    },
  ],
  options: {
    // 与 core 同款:不用 includeOnly (它会把指向 src/ 外的被禁边过滤掉,规则就命不中);
    // 改为 doNotFollow 不跟进外部模块,但保留出边,让 from:^src/ + to:<禁用 path> 命中。
    doNotFollow: {
      path: ['node_modules', 'dist', '.vite'],
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    // 跟随 TS 类型 import,确保 `import type` 也受边界约束。
    tsPreCompilationDeps: true,
  },
};
