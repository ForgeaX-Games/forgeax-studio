/**
 * @forgeax/host-sdk — postMessage RPC bridge for forgeax plugin iframes.
 *
 * Two entry points:
 *   import { createHost } from '@forgeax/host-sdk/extension';   // inside iframe
 *   import { createExtensionPort } from '@forgeax/host-sdk/host'; // in interface
 *
 * Both built on the same RpcChannel + Transport abstraction.
 */
export * from './rpc';
export * from './transport';
export { createHost } from './extension-side';
export type { ExtensionHostApi, CreateHostOptions } from './extension-side';
export { installExtensionDiagnosticsBridge } from './extension-diagnostics';
export { createExtensionPort } from './host-side';
export type { ExtensionPort, CreateExtensionPortOptions } from './host-side';
export { createMockTransportPair } from './transport-mock';
export { createWindowTransport } from './transport-window';
export type { WindowTransportOptions } from './transport-window';
