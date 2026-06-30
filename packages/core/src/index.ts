/**
 * @forgeax/forgeax-core — self-contained single-agent runtime.
 *
 * Wave 0 surface (contract freeze): events (sync hook bus block/modify + 事件目录),
 * history (EventStore default + ledger fold), inject (§4 injection interfaces),
 * and the cross-package CONTRACTS the parallel team builds against —
 *   capability/ (C2 Tool/Slot/Plugin ABI + C8 memory seam),
 *   provider/   (C4 LLMProvider + stream + usage + errors),
 *   agent/      (C5 Agent API + loop stages + Terminal reasons),
 *   context/    (C7 system-prompt slot + cache scope + compaction strategy).
 * Later waves add the IMPLEMENTATIONS behind these contracts (provider/, context/,
 * capability host, agent loop, kernel-facade).
 */
export * from './events/index';
export * from './history/index';
export * from './inject/types';
export * from './inject/in-process-scheduler';
export * from './capability/index';
export * from './provider/index';
export * from './agent/index';
export * from './context/index';
export * from './permission/index';
// NOTE: `./kernel-facade` (ForgeaxCoreKernel) is intentionally NOT re-exported here.
// It is the sidecar's internal engine, constructed only by `src/cli/serve.ts` via a
// relative import. The server-side in-process construction was removed (WS-B), so the
// facade is demoted out of the public `@forgeax/forgeax-core` `.` export. A
// dependency-cruiser rule (`facade-serve-internal`) keeps any other src/ module from
// importing it.
export * from './runtime/index';
