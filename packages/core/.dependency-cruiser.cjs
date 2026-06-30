/** @type {import('dependency-cruiser').IConfiguration} */
//
// Boundary lint for forgeax-core (@forgeax/forgeax-core).
//
// 设计铁律: 内核本体 core 不许 import 任何外部内核适配,也不许 import
// 编排层 forgeax-cli。core/src 只认:
//   - @forgeax/agent-runtime (AgentKernel 契约) + 子路径
//   - @forgeax/types (共享 DTO) + 子路径
//   - 自身相对路径 (./ ../)
//   - node: builtins + 已声明的第三方运行时依赖 (package.json dependencies)
//
// 这份 .dependency-cruiser.cjs 把上面约定固化进 CI。它与
// scripts/check-core-boundaries.mjs (轻量 regex 兜底, 无需安装 depcruise) 表达
// 同一组不变量;depcruise 解析真实模块图,覆盖动态 import / 间接路径,作为强制源。
//
// 运行: bun run lint:boundaries  (= depcruise -c .dependency-cruiser.cjs src)
//
module.exports = {
  forbidden: [
    {
      name: 'core-cannot-import-kernel-adaptor',
      severity: 'error',
      comment:
        '内核本体禁止 import 任何外部内核适配或其 SDK。' +
        'provider 层用 fetch 直连,绝不引入 @anthropic-ai/* / @openai/* 依赖,' +
        '更不许依赖 *-kernel / kernel-adaptors 这类宿主适配。',
      from: {
        path: '^src/',
      },
      to: {
        path: [
          '@anthropic-ai/',
          '@openai/',
          'bc-kernel',
          'codex-kernel',
          'kernel-adaptors',
        ],
      },
    },
    {
      name: 'core-cannot-import-orchestration',
      severity: 'error',
      comment:
        '内核本体禁止 import 编排层/宿主 (forgeax-cli / server / interface / studio)。' +
        '依赖方向只能 host → core,反向会倒置分层。',
      from: {
        path: '^src/',
      },
      to: {
        path: [
          '^forgeax-cli($|/)',
          '@forgeax/forgeax-cli',
          '@forgeax/server',
          '@forgeax/interface',
          '@forgeax/studio',
        ],
      },
    },
    {
      name: 'core-mechanism-no-otel-sdk',
      severity: 'error',
      comment:
        '机制层禁止 import OTel SDK / OTLP exporter / consola —— 只 HOST(src/cli/、src/tui/)可用。' +
        '机制层只认 @opentelemetry/api(zero-dep noop 契约),实现经注入缝下发(v3/B 档)。',
      from: {
        path: '^src/',
        pathNot: ['^src/cli/', '^src/tui/'],
      },
      to: {
        path: [
          '^@opentelemetry/sdk',
          '^@opentelemetry/exporter',
          '^@opentelemetry/resources',
          '^@opentelemetry/semantic-conventions',
          '^consola($|/)',
        ],
      },
    },
    {
      name: 'facade-serve-internal',
      severity: 'error',
      comment:
        'kernel-facade (ForgeaxCoreKernel) 是 sidecar 的内部引擎,只许 src/cli/serve.ts ' +
        '相对 import。它已从公共包导出降级 (WS-B):其他 src/ 模块不得 import kernel-facade,' +
        '内核的对外消费方应走 @forgeax/agent-runtime 契约 + sidecar --serve,而非进程内 facade。',
      from: {
        path: '^src/',
        pathNot: ['^src/cli/serve\\.ts$', '^src/kernel-facade/'],
      },
      to: {
        path: '^src/kernel-facade/',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'core/src 内部不允许出现循环依赖。',
      from: {
        path: '^src/',
      },
      to: {
        circular: true,
      },
    },
  ],
  options: {
    // 不用 includeOnly: 它会把指向 src/ 外的边 (正是被禁的那些) 从依赖图里
    // 过滤掉,规则就永远命不中。改为不跟进外部模块 (doNotFollow),但保留这些
    // 出边,让 from:^src/ + to:<禁用 path> 的规则能命中其 resolved 路径/specifier。
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
