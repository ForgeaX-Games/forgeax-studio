/**
 * @forgeax/host-sdk — postMessage RPC bridge for forgeax plugin iframes.
 *
 * Two entry points:
 *   import { createHost } from '@forgeax/host-sdk/plugin';   // inside iframe
 *   import { createPluginPort } from '@forgeax/host-sdk/host'; // in interface
 *
 * Both built on the same RpcChannel + Transport abstraction.
 */
export * from './rpc';
export * from './transport';
export { createHost } from './plugin-side';
export type { PluginHostApi, CreateHostOptions } from './plugin-side';
export { installPluginDiagnosticsBridge } from './plugin-diagnostics';
export { createPluginPort } from './host-side';
export type { PluginPort, CreatePluginPortOptions } from './host-side';
export { createMockTransportPair } from './transport-mock';
export { createWindowTransport } from './transport-window';
export type { WindowTransportOptions } from './transport-window';
