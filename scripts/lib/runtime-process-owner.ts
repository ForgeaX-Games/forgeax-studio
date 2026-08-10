import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The small, OS-derived fact set used to decide whether a PID is ours.  It is
 * deliberately separate from process discovery: callers may inject a snapshot
 * from a port, pidfile, or RuntimeState without broadening this predicate.
 */
export interface RuntimeProcessSnapshot {
  readonly pid: number;
  readonly commandLine: string | null;
  readonly cwd: string | null;
  /** Windows-only fallback when Win32 cannot prove a process cwd. */
  readonly ancestorCommandLines?: readonly string[];
}

export interface ActiveServerProcess {
  readonly packageDir: string;
  /** Either the package-relative entry (for example src/main.ts) or its path. */
  readonly entry: string;
}

export type RuntimeProcessService =
  | 'launcher'
  | 'server'
  | 'interface'
  | 'engine'
  | 'narrative'
  | 'rhi-debug-reviewer'
  | 'plugin-frontend'
  | 'plugin-backend'
  | 'plugin-headless';

export interface RuntimeProcessOwnerRequest {
  readonly root: string;
  readonly service: RuntimeProcessService;
  /** Required for server because a profile can select a different package. */
  readonly activeServer?: ActiveServerProcess;
  /** Required for plugin services. It is the exact extension package directory. */
  readonly pluginDir?: string;
  /** The manifest/discovery shortId; it must never be reconstructed from a path. */
  readonly pluginShortId?: string;
  /** The extension's declared standalone start command, required for plugins. */
  readonly pluginCommand?: string;
  /** Explicitly select interface or studio when the source launcher does so. */
  readonly interfaceDir?: string;
  /**
   * A RuntimeState servicePids key supplied by the caller.  It is checked
   * against the service contract so a state key cannot be relabelled as a
   * different service before a kill.
   */
  readonly stateServiceKey?: string;
  /** Same guard for a managedPorts key (including plugin frontend/backend). */
  readonly managedPortKey?: string;
}

/**
 * Reads the current command line and working directory for one PID.  A failed
 * read is represented as null, not guessed from a parent, executable, or port.
 * That makes callers fail closed under PID reuse and restricted OS inspection.
 */
export function readRuntimeProcessSnapshot(pid: number): RuntimeProcessSnapshot | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return readLinuxSnapshot(pid);
  if (process.platform === 'darwin') return readDarwinSnapshot(pid);
  if (process.platform === 'win32') return readWindowsSnapshot(pid);
  return null;
}

/**
 * Pure ownership decision. POSIX requires command line plus exact cwd. Windows
 * may use its bounded parent command-line chain when Win32 cannot expose cwd.
 */
export function runtimeProcessBelongsToInstance(
  snapshot: RuntimeProcessSnapshot | null,
  request: RuntimeProcessOwnerRequest,
): boolean {
  if (!snapshot || !snapshot.commandLine) return false;
  const root = canonicalPath(request.root);
  const commandLine = snapshot.commandLine;
  const service = serviceContract(root, request);
  if (!service) return false;
  // Only the Windows collector may attest that cwd is unavailable. A missing
  // cwd with no parent-chain field is an incomplete POSIX snapshot and fails.
  if (!snapshot.cwd) {
    if (snapshot.ancestorCommandLines === undefined) return false;
    return windowsOwnershipFallback(commandLine, snapshot.ancestorCommandLines, root, request, service);
  }
  const cwd = canonicalPath(snapshot.cwd);
  if (!service.allowedCwds.includes(cwd)) return false;
  return serviceSignatureMatches(commandLine, request, service);
}

function serviceSignatureMatches(
  commandLine: string,
  request: RuntimeProcessOwnerRequest,
  service: ServiceContract,
): boolean {
  if (service.requiredCommandPath && !hasCommandToken(commandLine, service.requiredCommandPath)) return false;
  if (service.pluginEvidence && !pluginEvidenceMatches(commandLine, request, service)) return false;
  if (service.pluginEvidence) return true;
  if (service.requiredCommandWord === 'vite' && !viteCommandMatches(commandLine, service.allowedCwds)) return false;
  if (service.requiredCommandWord && service.requiredCommandWord !== 'vite' && !hasCommandWord(commandLine, service.requiredCommandWord)) return false;
  if (request.stateServiceKey !== undefined && request.stateServiceKey !== service.stateServiceKey) return false;
  if (
    request.managedPortKey !== undefined
    && (service.managedPortKey === undefined || request.managedPortKey !== service.managedPortKey)
  ) return false;
  return true;
}

function windowsOwnershipFallback(
  commandLine: string,
  ancestors: readonly string[] | undefined,
  root: string,
  request: RuntimeProcessOwnerRequest,
  service: ServiceContract,
): boolean {
  // These entries name their exact rooted source file, so they do not need a
  // launcher ancestor. Source-layout local-runtime dynamically imports run.ts
  // in this same process, so children have local-runtime.ts (not run.ts) in
  // their OS parent chain. All other services require that independently
  // obtained, exact-root parent-chain proof.
  if (request.service === 'launcher' || request.service === 'server') {
    return service.requiredCommandPath !== undefined && hasCommandToken(commandLine, service.requiredCommandPath);
  }
  if (!ancestors?.some((line) => hasCommandToken(line, join(root, 'scripts/local-runtime.ts')))) return false;
  return serviceSignatureMatches(commandLine, request, service);
}

interface ServiceContract {
  readonly allowedCwds: readonly string[];
  readonly requiredCommandPath?: string;
  readonly requiredCommandWord?: string;
  readonly stateServiceKey: string;
  readonly managedPortKey?: string;
  readonly pluginEvidence?: 'wrapper-or-child' | 'state-only';
}

function serviceContract(root: string, request: RuntimeProcessOwnerRequest): ServiceContract | null {
  switch (request.service) {
    case 'launcher':
      return contract(root, join(root, 'scripts/local-runtime.ts'), 'launcher', 'launcher');
    case 'server': {
      if (!request.activeServer) return null;
      const packageDir = canonicalPath(request.activeServer.packageDir);
      if (!isPathWithin(root, packageDir)) return null;
      const entry = canonicalPath(resolve(packageDir, request.activeServer.entry));
      if (!isPathWithin(packageDir, entry)) return null;
      return contract(packageDir, entry, 'server', 'server');
    }
    case 'interface': {
      const cwd = canonicalPath(request.interfaceDir ?? join(root, 'packages/studio'));
      const allowed = [canonicalPath(join(root, 'packages/studio')), canonicalPath(join(root, 'packages/interface'))];
      if (!allowed.includes(cwd)) return null;
      return contract(cwd, undefined, 'interface', 'interface', 'vite');
    }
    case 'engine':
      return contract(join(root, 'packages/editor/packages/play-runtime'), undefined, 'engine', 'engine', 'vite');
    case 'narrative':
      return contract(join(root, 'packages/marketplace/extensions/wb-narrative'), undefined, 'narrative', 'narrative', 'src/api/server.ts');
    case 'rhi-debug-reviewer':
      return contract(join(root, 'packages/editor/packages/engine'), undefined, 'rhi-debug-reviewer', 'rhi-reviewer', 'vite');
    case 'plugin-frontend':
    case 'plugin-backend': {
      const plugin = pluginContract(root, request.pluginDir, request.pluginShortId, request.pluginCommand, request.service);
      return plugin;
    }
    case 'plugin-headless': {
      const plugin = pluginContract(root, request.pluginDir, request.pluginShortId, undefined, request.service);
      if (!plugin) return null;
      return { ...plugin, requiredCommandWord: 'scripts/headless-renderer.mjs' };
    }
  }
}

function pluginContract(
  root: string,
  pluginDir: string | undefined,
  pluginShortId: string | undefined,
  pluginCommand: string | undefined,
  service: 'plugin-frontend' | 'plugin-backend' | 'plugin-headless',
): ServiceContract | null {
  if (!pluginDir || !pluginShortId || !/^[a-z0-9-]+$/.test(pluginShortId)) return null;
  const cwd = canonicalPath(pluginDir);
  const extensionRoot = canonicalPath(join(root, 'packages/marketplace/extensions'));
  if (!isPathWithin(extensionRoot, cwd)) return null;
  const suffix = service === 'plugin-frontend' ? 'frontend' : service === 'plugin-backend' ? 'backend' : 'headless';
  // Standalone extensions currently use one launcher process for frontend and
  // backend.  The two keys remain distinct so state/port callers cannot mix
  // them, while the exact extension cwd prevents a root-local unrelated Bun.
  if (service !== 'plugin-headless' && (!pluginCommand || !/^[A-Za-z0-9:_-]+$/.test(pluginCommand))) return null;
  if (service === 'plugin-headless') {
    // The headless renderer owns no listener. Its state key is distinct from
    // the plugin launcher, so it cannot be mistaken for its parent process.
    return {
      ...contract(cwd, undefined, `plugin-${pluginShortId}-headless`, undefined, 'scripts/headless-renderer.mjs'),
      pluginEvidence: 'state-only',
    };
  }
  return {
    ...contract(
      cwd,
      undefined,
      `plugin-${pluginShortId}`,
      `plugin-${pluginShortId}-${suffix}`,
      pluginCommand,
    ),
    pluginEvidence: 'wrapper-or-child',
    allowedCwds: [cwd, canonicalPath(join(cwd, suffix === 'frontend' ? 'frontend' : 'backend'))],
  };
}

function pluginEvidenceMatches(
  commandLine: string,
  request: RuntimeProcessOwnerRequest,
  service: ServiceContract,
): boolean {
  if (service.pluginEvidence === 'state-only') {
    return request.stateServiceKey === service.stateServiceKey
      && request.managedPortKey === undefined
      && service.requiredCommandWord !== undefined
      && hasCommandWord(commandLine, service.requiredCommandWord);
  }

  // RuntimeState's plugin PID is the `bun run <start>` wrapper.  Its command
  // must retain the declared script word so a reused PID cannot impersonate it.
  if (request.stateServiceKey !== undefined) {
    return request.stateServiceKey === service.stateServiceKey
      && service.requiredCommandWord !== undefined
      && hasCommandWord(commandLine, service.requiredCommandWord)
      && (request.managedPortKey === undefined || request.managedPortKey === service.managedPortKey);
  }

  // A listener discovered through the managed frontend/backend port is often a
  // Vite or backend child, whose argv correctly lacks the wrapper's script
  // word. Exact extension cwd + declared shortId/key alone is not enough: a
  // random process may share that cwd, so admit only known listener shapes.
  return request.managedPortKey !== undefined
    && request.managedPortKey === service.managedPortKey
    && pluginManagedChildMatches(commandLine, request.service, request.pluginDir as string);
}

function pluginManagedChildMatches(
  commandLine: string,
  service: RuntimeProcessService,
  pluginDir: string,
): boolean {
  if (service === 'plugin-frontend') {
    return hasCommandWord(commandLine, 'vite')
      || hasCommandToken(commandLine, join(pluginDir, 'node_modules/vite/bin/vite.js'))
      || hasCommandWord(commandLine, 'scripts/serve-dist.mjs');
  }
  if (service === 'plugin-backend') {
    return hasCommandWord(commandLine, 'tsx')
      || hasCommandToken(commandLine, join(pluginDir, 'backend/dist/main.js'))
      || hasCommandWord(commandLine, 'backend/dist/main.js')
      || hasCommandWord(commandLine, 'scripts/serve-dist.mjs');
  }
  return false;
}

function contract(
  cwd: string,
  requiredCommandPath: string | undefined,
  stateServiceKey: string,
  managedPortKey: string | undefined,
  requiredCommandWord?: string,
): ServiceContract {
  return {
    allowedCwds: [canonicalPath(cwd)],
    ...(requiredCommandPath ? { requiredCommandPath: canonicalPath(requiredCommandPath) } : {}),
    stateServiceKey,
    ...(managedPortKey ? { managedPortKey } : {}),
    requiredCommandWord,
  };
}

function readLinuxSnapshot(pid: number): RuntimeProcessSnapshot | null {
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    return commandLine && cwd ? { pid, commandLine, cwd } : null;
  } catch {
    return null;
  }
}

function readDarwinSnapshot(pid: number): RuntimeProcessSnapshot | null {
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  // lsof is the portable macOS source for a process working directory.  Do not
  // infer cwd from command arguments: that reintroduces the old root substring bug.
  const cwdResult = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const cwd = (cwdResult.stdout ?? '').split('\n').find((line) => line.startsWith('n'))?.slice(1).trim();
  const commandLine = (command.stdout ?? '').trim();
  return commandLine && cwd ? { pid, commandLine, cwd } : null;
}

function readWindowsSnapshot(pid: number): RuntimeProcessSnapshot | null {
  // Query the table once so the target and every inspected parent come from one
  // snapshot, rather than racing separate CIM queries during PID reuse.
  const script = '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress -Depth 3';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  });
  return windowsSnapshotFromProcessTable(pid, result.stdout ?? '');
}

interface WindowsProcessRow {
  readonly ProcessId: number;
  readonly ParentProcessId: number;
  readonly CommandLine: string | null;
}

function windowsSnapshotFromProcessTable(pid: number, output: string): RuntimeProcessSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const table = new Map<number, WindowsProcessRow>();
  for (const row of value) {
    if (!isWindowsProcessRow(row) || table.has(row.ProcessId)) return null;
    table.set(row.ProcessId, row);
  }
  const target = table.get(pid);
  if (!target?.CommandLine?.trim()) return null;

  const ancestors: string[] = [];
  const seen = new Set<number>([pid]);
  let parentPid = target.ParentProcessId;
  for (let depth = 0; parentPid > 0; depth += 1) {
    if (depth >= 64 || seen.has(parentPid)) return null;
    seen.add(parentPid);
    const parent = table.get(parentPid);
    if (!parent) break;
    if (parent.CommandLine?.trim()) ancestors.push(parent.CommandLine);
    parentPid = parent.ParentProcessId;
  }
  // Win32_Process does not reliably expose cwd. The explicit ancestor evidence
  // makes its absence distinguishable from POSIX's failed /proc or lsof read.
  return { pid, commandLine: target.CommandLine, cwd: null, ancestorCommandLines: ancestors };
}

function isWindowsProcessRow(value: unknown): value is WindowsProcessRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !Object.hasOwn(row, 'ProcessId') || !Object.hasOwn(row, 'ParentProcessId') || !Object.hasOwn(row, 'CommandLine')) return false;
  return Number.isInteger(row.ProcessId) && (row.ProcessId as number) > 0
    && Number.isInteger(row.ParentProcessId) && (row.ParentProcessId as number) >= 0
    && (typeof row.CommandLine === 'string' || row.CommandLine === null);
}

function canonicalPath(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

function isPathWithin(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(`${parent}/`);
}

/** Exact canonical path token, never a prefix such as /foo matching /foo-copy. */
function hasCommandToken(commandLine: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s'\"=])${escaped}(?=$|[\\s'\"=])`).test(commandLine.replace(/\\/g, '/'));
}

function hasCommandWord(commandLine: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`, 'i').test(commandLine);
}

/**
 * Vite normally appears as a bare package-manager word, but the spawned child
 * can retain Node's exact local executable path. Limit that alternate shape
 * to an already-authorized service cwd; an arbitrary Node script is not Vite.
 */
function viteCommandMatches(commandLine: string, allowedCwds: readonly string[]): boolean {
  return hasCommandWord(commandLine, 'vite') || allowedCwds.some((cwd) =>
    hasCommandToken(commandLine, join(cwd, 'node_modules/.bin/vite'))
    || hasCommandToken(commandLine, join(cwd, 'node_modules/vite/bin/vite.js')),
  );
}
