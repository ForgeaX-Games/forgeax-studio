/**
 * dependency-cruiser config — Phase A5 package boundary lint.
 *
 * Encodes the §11.1 ownership table from
 * docs/v2-vision/architecture-evolution/11-LONG-TERM-MAINTAINABILITY.md.
 *
 * Run (when dep-cruiser is installed in CI):
 *   npx depcruise --config .dependency-cruiser.cjs packages/
 *
 * This file is the spec; bun-based check at scripts/check-boundaries.ts
 * implements the same rules without external deps for local/CI use today.
 */
module.exports = {
  forbidden: [
    {
      name: 'plugins-cannot-import-host',
      severity: 'error',
      comment:
        'Plugins must use @forgeax/host-sdk; deep-importing server/interface internals leaks the host abstraction.',
      from: { path: '^packages/marketplace/plugins/[^/]+/' },
      to: {
        path: [
          '^packages/server/(?!.*\\.json$)',
          '^packages/interface/',
        ],
      },
    },
    {
      name: 'interface-cannot-import-plugin-internals',
      severity: 'error',
      comment:
        'Interface may only depend on plugin manifests via the bus API; deep-importing plugin source couples the host to specific implementations.',
      from: { path: '^packages/interface/' },
      to: {
        path: '^packages/marketplace/plugins/[^/]+/(?!forgeax-plugin\\.json)',
      },
    },
    {
      name: 'server-cannot-import-interface',
      severity: 'error',
      comment: 'Server is the iframe parent; importing UI code creates a CSR/SSR coupling we do not want.',
      from: { path: '^packages/server/' },
      to: { path: '^packages/interface/' },
    },
    {
      name: 'types-pure',
      severity: 'error',
      comment: '@forgeax/types is type/schema only. Do not import runtime packages.',
      from: { path: '^packages/types/' },
      to: {
        path: [
          '^packages/server/',
          '^packages/interface/',
          '^packages/host-sdk/',
          '^packages/marketplace/',
          '^packages/cli/',
          '^packages/agent-runtime/',
        ],
      },
    },
    {
      name: 'host-sdk-no-runtime-deps',
      severity: 'error',
      comment: '@forgeax/host-sdk must stay portable; only @forgeax/types is allowed as a workspace dep.',
      from: { path: '^packages/host-sdk/' },
      to: {
        path: [
          '^packages/server/',
          '^packages/interface/',
          '^packages/marketplace/',
          '^packages/cli/',
          '^packages/agent-runtime/',
        ],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular deps between packages signal a missing extraction.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: {
      // Each package has its own tsconfig; pass per-invocation if needed.
    },
    includeOnly: '^packages/',
    exclude: {
      path: [
        'node_modules',
        '\\.test\\.ts$',
        '\\.spec\\.ts$',
        '/test/',
        '/dist/',
        '/build/',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
