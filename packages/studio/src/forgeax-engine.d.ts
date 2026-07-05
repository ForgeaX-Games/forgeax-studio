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

// engine-types is imported as TYPES (SceneAsset, SceneEntity, LocalEntityId, …)
// by editor-core / play-runtime, pulled into studio's program transitively via
// workspace symlinks. A bare `declare module` only supplies value-space `any`,
// so `type SceneAsset` fails with TS2709. Declare each type as `any` so
// type-space resolves until the engine ships real .d.ts.
declare module '@forgeax/engine-types' {
  export type SceneAsset = any;
  export type SceneEntity = any;
  export type LocalEntityId = any;
  export type CubeTextureMetadata = any;
  export type ImageMetadata = any;
  export type PackIndexEntry = any;
  export type TextureAsset = any;
  export type AssetError = any;
  export type ImageError = any;
}

// engine-project is imported by editor-core/store.ts for both values
// (loadGameProject, FORGE_JSON, GameProjectError) AND types
// (`type GameProject`). A bare `declare module` only supplies value-space
// `any`, so `type GameProject` fails with TS2709. Declare the surface
// explicitly so both spaces resolve until the engine ships real .d.ts.
declare module '@forgeax/engine-project' {
  export const loadGameProject: any;
  export const loadGameProjectSync: any;
  export const resolveDefaultScene: any;
  export const validateGameProject: any;
  export const GameProjectSchema: any;
  export const GameProjectError: any;
  export const FORGE_JSON: string;
  export type GameProject = any;
  export type ResolvedScene = any;
  export type GameProjectErrorCode = any;
  export type GameProjectErrorDetail = any;
}
