#!/usr/bin/env bun
// Root-owned development integration launcher. Product UI and business logic
// stay in their repositories; this file only supervises their public dev
// entrypoints and projects one shared RuntimeInstance onto them.
import { delimiter, join, resolve } from 'node:path';
import { clearPidfiles, isAlive, isPortBusy, recordPid, reapPidfiles, runDir, sleep, waitForPort } from './lib/proc.ts';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { managedRuntimePorts } from './lib/managed-runtime-ports.ts';
import { readinessSummary, waitForRuntime } from './lib/runtime-readiness.ts';
import { RuntimeStateStore } from './lib/runtime-state.ts';
import { resolveActiveServerRole, serverRuntimeInvocation } from './lib/server-role.ts';
import { ServiceSupervisor } from './lib/service-supervisor.ts';
import { StartLock } from './lib/startlock.ts';
import { consumeSourceRuntimeContext } from './lib/source-runtime-context.ts';
import {
  allocateStandaloneRuntimePlugins,
  discoverStandalonePlugins,
  ensureStandalonePluginToolchain,
  standalonePluginInvocation,
  standalonePluginPortMap,
} from './lib/standalone-plugins.ts';

const ROOT = resolve(process.env.FORGEAX_WORKSPACE_ROOT ?? join(import.meta.dir, '..'));
const startup = consumeSourceRuntimeContext();
const lock = StartLock.consumeRuntimeOwner(ROOT);
if (!lock) throw new Error('source runtime lock owner is unavailable; start through `bun fx start`');

const serverRole = resolveActiveServerRole({ root: ROOT, profile: process.env.FORGEAX_SERVER_PROFILE });
const serverRuntime = serverRuntimeInvocation(serverRole);
const ideDir = join(ROOT, 'packages/ide');
const editorDir = join(ROOT, 'packages/editor');
const engineDir = join(editorDir, 'packages/play-runtime');
const engineViteCli = join(editorDir, 'node_modules/vite/bin/vite.js');
const gameMcpEntry = join(ROOT, 'packages/game-plugin/src/main.ts');
const extensionDevRoots = process.env.FORGEAX_CORE_ONLY === '1'
  ? []
  : (process.env.FORGEAX_EXTENSION_DEV_ROOTS ?? '')
      .split(delimiter)
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root));
const discoveredExtensions = extensionDevRoots.flatMap((root) => discoverStandalonePlugins(root));
const extensions = allocateStandaloneRuntimePlugins(discoveredExtensions, {
  projectRoot: startup.projectRoot,
  portOffset: startup.optional.pluginPortOffset,
  reservedPorts: [startup.server.port, startup.interface.port, startup.engine.port],
  isPortBusy,
});
for (const extension of extensions) mkdirSync(extension.projectRoot, { recursive: true });

const extensionDevPortsFile = join(startup.projectRoot, '.forgeax', 'extension-dev-ports.json');
mkdirSync(join(startup.projectRoot, '.forgeax'), { recursive: true });
writeFileSync(
  extensionDevPortsFile,
  `${JSON.stringify(standalonePluginPortMap(extensions), null, 2)}\n`,
);
process.env.FORGEAX_EXTENSION_DEV_PORTS_FILE = extensionDevPortsFile;

const managedPorts = managedRuntimePorts({
  serverPort: startup.server.port,
  interfacePort: startup.interface.port,
  enginePort: startup.engine.port,
  ...(startup.mcp.enabled ? { mcpPort: startup.mcp.port } : {}),
  extensions: extensions.map(({ shortId, frontendPort, backendPort }) => ({
    shortId,
    frontendPort,
    backendPort,
  })),
});
const state = new RuntimeStateStore(startup, process.pid, managedPorts, {
  server: { packageDir: serverRole.packageDir, entry: serverRole.entry },
  interface: { dir: ideDir },
});
state.writeStarting();

let stopping = false;
let cleanupPromise: Promise<void> | null = null;
let cleanupFinished = false;
const supervisor = new ServiceSupervisor({
  onEvent(event) {
    if (event.pid) state.setServicePid(event.name, event.pid);
    if (event.status === 'stopped' || event.status === 'failed') state.setServicePid(event.name, 0);
  },
  onFatal(error) {
    if (stopping) return;
    state.markFailed(error.message);
    void shutdown(1);
  },
});

const commonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  FORGEAX_HOST_PACKAGE_ROOT: ROOT,
  FORGEAX_PRODUCT_ROOT: ideDir,
};
function launch(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = commonEnv,
): number {
  const pid = supervisor.launch({
    name,
    command,
    args,
    spawn: { cwd, env },
    required: true,
    restartPolicy: startup.supervision.restartPolicy,
    maxRestarts: startup.supervision.maxRestarts,
  });
  if (pid) recordPid(startup.projectRoot, name, pid);
  return pid;
}

clearPidfiles(startup.projectRoot);
mkdirSync(runDir(startup.projectRoot), { recursive: true });

if (extensionDevRoots.some((root) => !ensureStandalonePluginToolchain(root))) {
  state.markFailed('standalone extension toolchain preparation failed');
  await shutdown(1);
}

console.log(
  `[run] starting server :${startup.server.port} + IDE :${startup.interface.port} + engine :${startup.engine.port}`
    + (startup.mcp.enabled ? ` + Engine MCP :${startup.mcp.port}` : ''),
);
// The server imports embedded extension output. Standalone extension watchers
// rewrite that output during this same startup, and Bun 1.3 can deadlock its
// HTTP event loop when `--watch` reloads across those child-process writes.
// Keep the supervised server stable; backend source changes take effect after
// the existing explicit `bun fx restart` lifecycle command.
launch('server', 'bun', [serverRuntime.entryPath], serverRole.packageDir);
if (!(await waitForPort(startup.server.port, 10_000))) {
  state.markFailed(`server did not bind :${startup.server.port} within 10 seconds`);
  await shutdown(1);
}

if (startup.mcp.enabled) {
  if (!process.env.FORGEAX_REMOTE_MCP_TOKEN?.trim()) {
    state.markFailed('FORGEAX_REMOTE_MCP_TOKEN is required when FORGEAX_MCP_HTTP=1');
    await shutdown(1);
  }
  if (!existsSync(gameMcpEntry)) {
    state.markFailed(`Engine MCP entry is missing: ${gameMcpEntry}`);
    await shutdown(1);
  }
  launch(
    'engine-mcp',
    'bun',
    [
      gameMcpEntry,
      'mcp',
      '--transport', 'http',
      '--host', startup.mcp.host,
      '--port', String(startup.mcp.port),
      '--root', startup.projectRoot,
      '--require-auth',
    ],
    ROOT,
    { ...commonEnv, FORGEAX_MCP_EXISTING_SERVICES: '1' },
  );
  if (!(await waitForPort(startup.mcp.port, 10_000))) {
    state.markFailed(`Engine MCP did not bind :${startup.mcp.port} within 10 seconds`);
    await shutdown(1);
  }
}

const extensionTlsCert = join(ROOT, '.tls', 'cert.pem');
const extensionTlsKey = join(ROOT, '.tls', 'key.pem');
for (const plugin of extensions) {
  const runner = standalonePluginInvocation(plugin.start);
  const proxyBase = startup.standaloneProxy ? `/__fx-plugin/${plugin.shortId}/` : '';
  launch(`plugin-${plugin.shortId}`, runner.cmd, runner.args, plugin.dir, {
    ...commonEnv,
    FORGEAX_PROJECT_ROOT: plugin.projectRoot,
    PORT: String(plugin.backendPort),
    VITE_DEV_PORT: String(plugin.frontendPort),
    VITE_API_TARGET: `http://127.0.0.1:${plugin.backendPort}`,
    VITE_PLUGIN_BASE: proxyBase,
    VITE_PLUGIN_HMR_CLIENT_PORT: startup.standaloneProxy ? String(startup.hmrClientPort) : '',
    VITE_PLUGIN_HMR_PATH: startup.standaloneProxy ? '/__vite_hmr' : '',
    VITE_DEV_HTTPS_CERT: existsSync(extensionTlsCert) ? extensionTlsCert : '',
    VITE_DEV_HTTPS_KEY: existsSync(extensionTlsKey) ? extensionTlsKey : '',
  });
  if (!(await waitForPort(plugin.frontendPort, Math.min(startup.startupTimeoutMs, 30_000)))) {
    state.markFailed(
      `standalone extension ${plugin.id} did not bind :${plugin.frontendPort} within 30 seconds`,
    );
    await shutdown(1);
  }
}

launch(
  'interface',
  'bun',
  ['run', 'dev:web', '--', '--host', startup.interface.host, '--port', String(startup.interface.port), '--strictPort'],
  ideDir,
  { ...commonEnv, FORGEAX_INTEGRATION_ROOT: ROOT },
);
launch(
  'engine',
  'node',
  ['--experimental-import-meta-resolve', engineViteCli, '--host', startup.engine.host, '--port', String(startup.engine.port), '--strictPort'],
  engineDir,
  commonEnv,
);

const readiness = await waitForRuntime(startup, { onCheck: (result) => state.setReadiness(result) });
if (!readiness.ready) {
  state.markFailed(`core services failed readiness: ${readinessSummary(readiness)}`, readiness);
  await shutdown(1);
}
state.markReady(readiness);
console.log(`[run] runtime ready (${startup.profile}): ${readinessSummary(readiness)}`);

async function shutdown(code: number): Promise<never> {
  if (!cleanupPromise) {
    stopping = true;
    if (code === 0 || code === 130 || code === 143) state.markStopping();
    const servicePids = Object.values(supervisor.pids()).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    const force = code === 1;
    supervisor.shutdown(force);
    reapPidfiles(startup.projectRoot, force);
    cleanupPromise = (async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const livePids = servicePids.filter((pid) => isAlive(pid));
        const busyPorts = Object.values(managedPorts).filter((port) => isPortBusy(port));
        if (livePids.length === 0 && busyPorts.length === 0) {
          clearPidfiles(startup.projectRoot);
          rmSync(extensionDevPortsFile, { force: true });
          if (code === 0 || code === 130 || code === 143) state.remove();
          lock.release();
          cleanupFinished = true;
          return;
        }
        await sleep(100);
      }

      const livePids = servicePids.filter((pid) => isAlive(pid));
      const busyPorts = Object.values(managedPorts).filter((port) => isPortBusy(port));
      const detail = `runtime cleanup incomplete: livePids=${livePids.join(',') || 'none'} busyPorts=${busyPorts.join(',') || 'none'}`;
      try {
        state.markFailed(detail);
      } catch {
        // Preserve recovery evidence even when the state write itself fails.
      }
      console.error(`[run] ${detail}; retaining runtime recovery files`);
      cleanupFinished = true;
    })();
  }
  await cleanupPromise;
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
// `exit` cannot await. This is an emergency fallback only: never remove
// recovery evidence or release run.lock from this synchronous path.
process.on('exit', () => {
  if (cleanupFinished) return;
  supervisor.shutdown(true);
  reapPidfiles(startup.projectRoot, true);
});
await new Promise(() => {});
