/** @forgeax/agent-host —— ring-0 sidecar(R3 阶段1:进程监督脊梁)public API。 */
export * from './types';
export { createKernelProcess, type KernelProcess, type KernelProcessExit } from './kernel-process';
export { RpcConnection, connect, encodeFrame, createFrameParser } from './ipc';
export { Host } from './host';
export { startAgentHostServer, type AgentHostServer } from './server';
export { issueScoped, revokeScoped, setCredAudit, closeCredVault, type Provider, type ScopedBudget } from './cred-vault';
export { maybeSandbox, sandboxAvailable } from './sandbox';
// R3 内核归一:peer 调度器 / 子 agent 装配 / WAL store 已搬进 @forgeax/forgeax-core
// (它们只依赖 core 运行时,本应住在 core)。agent-host 自此**零 @forgeax 业务依赖**,
// 回归协议无关的进程管家。见 forgeax-core/src/{inject/in-process-scheduler,cli/peer}.ts。
export { resolveSockPath, main } from './main';
