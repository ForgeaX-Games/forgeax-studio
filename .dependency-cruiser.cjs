/**
 * Static file dependencies, read directly by the dependency-cruiser CLI.
 *
 * Encodes the §11.1 ownership table from
 * .forgeax-harness/docs/v2-vision/architecture-evolution/11-LONG-TERM-MAINTAINABILITY.md.
 *
 * Run from the Studio root (Node 22, 24 or >=26):
 *   bunx --no-install depcruise packages/ --output-type err-long
 *   bunx --no-install depcruise packages/server/src --ts-config "$PWD/packages/server/tsconfig.json"
 *
 * Each invocation has ONE resolution context. A scan without --ts-config is
 * an inventory, not proof that every project's aliases resolve. Keep unresolved
 * entries visible. Existing raw-specifier/manifest gates remain in
 * scripts/check-boundaries.ts; resolved-path rules cannot replace facade locks.
 * Usage, scope and limitations: .forgeax-harness/docs/audits/static-references/guide.md
 */
module.exports = {
  forbidden: [
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
      from: { path: '^packages/contracts/types/' },
      to: {
        path: [
          '^packages/server/',
          '^packages/interface/',
          '^packages/orchestrator/',
          '^packages/contracts/agent-runtime/',
        ],
      },
    },
    {
      name: 'unresolved-reference',
      severity: 'warn',
      comment: 'Check the selected tsconfig, installed dependencies, package exports and Vite-only aliases before treating this as a missing source file.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A file dependency cycle needs review; type-only edges are included and this does not imply a runtime cycle.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Keep installed dependencies as leaves, including their actual resolved path.
    // Do not exclude node_modules or use includeOnly: that hides unresolved and
    // external edges. The CLI arguments select the source roots to scan.
    doNotFollow: {
      path: [
        '(^|/)node_modules/',
        '(^|/)(\\.[^/]+|dist|target|coverage|vendor)/',
        // packages/build itself is a source repository, not generated output.
        '^packages/[^/]+/build/',
      ],
    },
    tsPreCompilationDeps: 'specify',
    parser: 'tsc',
    builtInModules: { add: ['bun', 'bun:sqlite', 'bun:jsc', 'bun:test'] },
    // A static graph of type + import/require conditions, not a Vite/Bun build.
    // Exports enforcement is opt-in in dependency-cruiser; never bypass it.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
      mainFields: ['types', 'typings', 'module', 'main'],
    },
    exclude: {
      path: [
        '(^|/)(__tests__|__fixtures__|test|tests|fixtures)/',
        '\\.(test|spec)\\.[cm]?[jt]sx?$',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
