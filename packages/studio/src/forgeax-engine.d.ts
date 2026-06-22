// Ambient module shims for the @forgeax/engine-* packages.
//
// studio's tsconfig pulls editor-core sources into its program via
// workspace symlinks (transitively through @forgeax/interface and
// @forgeax/editor-edit-runtime). When editor-core does
// `import { Materials } from '@forgeax/engine-runtime'`, tsc resolves
// to forgeax-engine/packages/runtime/dist/index.mjs — engine packages
// currently emit dist/*.mjs only (no dist/*.d.ts), so studio's
// typecheck reds out at TS7016.
//
// Sibling shims also live in:
//   - packages/editor/src/forgeax-engine.d.ts (forgeax-editor#1)
//   - packages/interface/src/forgeax-engine.d.ts (forgeax-interface#31)
//
// All three shims become removable when the engine packages start
// shipping .d.ts (engine submodule tsup `dts: true` + root `tsc -b`).

declare module '@forgeax/engine-runtime';
declare module '@forgeax/engine-ecs';
declare module '@forgeax/engine-gltf';
