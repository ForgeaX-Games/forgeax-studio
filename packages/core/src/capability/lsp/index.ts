/**
 * LSP 子系统出口(③)—— 代码智能工具(Language Server Protocol)。
 *
 * 暴露 `lspToolsPack()`(独立 pack,在 runtime/assemble.ts push,不进
 * builtinToolsPack)+ 底层 client/jsonrpc/servers(供 host 自定义注入)。
 *
 * Boundary: 仅 import core-local + node:。
 */
export * from './jsonrpc';
export * from './servers';
export * from './client';
export * from './tool';
