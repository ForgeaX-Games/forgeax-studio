/**
 * @forgeax/types — public surface.
 *
 * 每个 file 一个 concern。consumers 直接 `from '@forgeax/types/manifest'` 导入
 * 子模块，或 `from '@forgeax/types'` 拿 namespaces。
 */
export * from './i18n';
export * from './manifest';
export * from './agent';
export * from './skill';
export * from './tool';
export * from './host-sdk';
export * from './persona-capability-surface';
