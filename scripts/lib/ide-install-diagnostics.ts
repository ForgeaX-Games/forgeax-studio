import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Diagnostic output is an allowlist, not a scrubbed copy of raw configuration.
// Never read npmrc/bunfig contents, process argv/environ, or network endpoints.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MEMBERS = 512;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions'] as const;
type Fingerprint = { state: 'present' | 'missing' | 'unavailable' | 'oversize'; sha256?: string; bytes?: number };

function readRegularFile(path: string): Buffer | undefined {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  return readFileSync(path);
}

function fingerprint(path: string): Fingerprint {
  try {
    const bytes = readRegularFile(path);
    if (!bytes) return { state: 'oversize' };
    return { state: 'present', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
}

function manifest(path: string): Record<string, unknown> | undefined {
  try {
    const bytes = readRegularFile(path);
    const value: unknown = bytes && JSON.parse(bytes.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function safeName(value: unknown): string {
  return typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value) && value.length <= 214 ? value : '[redacted]';
}

function safeSpec(value: unknown): string {
  // Only numeric semver ranges and workspace selectors are useful in clear text.
  // URL, Git, local-path and arbitrary tag values are deliberately not emitted.
  return typeof value === 'string' && value.length <= 120 && /^(?:workspace:)?[0-9xX*.^~<>=| +\-]+$/.test(value) ? value : '[redacted]';
}

function manifestSummary(path: string) {
  const value = manifest(path);
  const dependencies: Record<string, Record<string, string>> = {};
  let omittedEdges = 0;
  for (const field of DEPENDENCY_FIELDS) {
    const edges = value?.[field];
    if (!edges || typeof edges !== 'object' || Array.isArray(edges)) continue;
    const entries = Object.entries(edges).sort(([a], [b]) => a.localeCompare(b));
    omittedEdges += Math.max(0, entries.length - 1024);
    dependencies[field] = Object.fromEntries(entries.slice(0, 1024).map(([name, spec]) => [safeName(name), safeSpec(spec)]));
  }
  return { ...fingerprint(path), ...(value ? {} : { state: 'invalid' as const }), name: safeName(value?.name), dependencies, omittedEdges };
}

function head(path: string): string | null {
  try {
    // Missing directories must not accidentally report the enclosing Studio HEAD.
    if (!existsSync(join(path, '.git'))) return null;
    const result = spawnSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000, maxBuffer: 256, stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = result.stdout?.trim();
    return result.status === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

function locks(root: string, cwd: string) {
  return {
    rootText: fingerprint(join(root, 'bun.lock')),
    rootBinary: fingerprint(join(root, 'bun.lockb')),
    installText: fingerprint(join(cwd, 'bun.lock')),
    installBinary: fingerprint(join(cwd, 'bun.lockb')),
    ideText: fingerprint(join(root, 'packages/ide/bun.lock')),
  };
}

/** Read only the generated root and its declared members, never node_modules. */
export function collectIdeInstallInputs(root: string, cwd: string, env: NodeJS.ProcessEnv) {
  const value = manifest(join(cwd, 'package.json'));
  const patterns = Array.isArray(value?.workspaces) ? value.workspaces : [];
  const directories = new Set<string>();
  let omittedPatterns = Math.max(0, patterns.length - MAX_MEMBERS);
  let truncatedMembers = false;
  for (const pattern of patterns.slice(0, MAX_MEMBERS)) {
    if (typeof pattern !== 'string' || !/^[a-zA-Z0-9_./*-]+$/.test(pattern)) { omittedPatterns++; continue; }
    const wildcard = pattern.endsWith('/*');
    const directory = resolve(cwd, wildcard ? pattern.slice(0, -2) : pattern);
    const within = relative(root, directory);
    if (isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\') || directory.includes('*')) { omittedPatterns++; continue; }
    let candidates = [directory];
    if (wildcard) {
      try { candidates = readdirSync(directory).sort().map((name) => join(directory, name)); }
      catch { omittedPatterns++; continue; }
    }
    for (const candidate of candidates) {
      if (directories.size >= MAX_MEMBERS) { truncatedMembers = true; break; }
      try { if (statSync(candidate).isDirectory()) directories.add(candidate); }
      catch { omittedPatterns++; }
    }
  }
  return {
    studioHead: head(root), ideHead: head(join(root, 'packages/ide')),
    observerBunVersion: process.versions.bun ?? null, platform: process.platform, arch: process.arch,
    installManifest: manifestSummary(join(cwd, 'package.json')),
    members: [...directories].sort().map((directory) => ({
      path: relative(root, directory).replaceAll('\\', '/').replace(/[^a-zA-Z0-9_./-]/g, '_'),
      ...manifestSummary(join(directory, 'package.json')),
    })),
    omittedPatterns, truncatedMembers, locks: locks(root, cwd),
    configPresence: {
      rootNpmrc: existsSync(join(root, '.npmrc')), installNpmrc: existsSync(join(cwd, '.npmrc')),
      rootBunfig: existsSync(join(root, 'bunfig.toml')), installBunfig: existsSync(join(cwd, 'bunfig.toml')),
      registryEnv: Boolean(env.npm_config_registry || env.NPM_CONFIG_REGISTRY || env.BUN_CONFIG_REGISTRY),
      cacheEnv: Boolean(env.BUN_INSTALL_CACHE_DIR),
    },
  };
}

/** Linux /proc evidence for this one child PID; no machine-wide process scan. */
export function readInstallProcessState(pid: number, procRoot = '/proc') {
  const read = (name: string) => { try { return readFileSync(join(procRoot, String(pid), name), 'utf8').slice(0, 16384); } catch { return ''; } };
  const stat = read('stat');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const status = read('status');
  const io = read('io');
  const number = (value: string | undefined) => value && /^\d+$/.test(value) ? Number(value) : null;
  const metric = (text: string, key: string) => number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
  const wchan = read('wchan').trim();
  return {
    state: /^[RSDZTtXxKWPI]$/.test(fields[0] ?? '') ? fields[0] : 'unavailable',
    userTicks: number(fields[11]), systemTicks: number(fields[12]),
    rssKiB: metric(status, 'VmRSS'), threads: metric(status, 'Threads'),
    readChars: metric(io, 'rchar'), writeChars: metric(io, 'wchar'),
    readBytes: metric(io, 'read_bytes'), writeBytes: metric(io, 'write_bytes'),
    waitChannel: /^[a-z0-9_]{1,80}$/.test(wchan) ? wchan : null,
  };
}

type InstallOptions = { root: string; cwd: string; args: string[]; env: NodeJS.ProcessEnv; executable?: string };
type InstallResult = { status: number | null; signal: NodeJS.Signals | null };

/** Opt-in observation only: identical command/env/stdio, no retry or deadline. */
export async function runIdeWorkspaceInstall(options: InstallOptions, diagnostics: { intervalMs?: number; emit?: (line: string) => void } = {}): Promise<InstallResult> {
  const { root, cwd, args, env, executable = 'bun' } = options;
  const spawnOptions = { cwd, env, stdio: 'inherit' as const };
  if (env.FORGEAX_IDE_INSTALL_DIAGNOSTICS !== '1') return spawnSync(executable, args, spawnOptions);
  const started = performance.now();
  const emit = (record: Record<string, unknown>) => {
    try { (diagnostics.emit ?? console.log)(`[ide-install] ${JSON.stringify({ ...record, elapsedMs: Math.round(performance.now() - started) })}`); }
    catch { /* Observability must not change the install result. */ }
  };
  try {
    const { members, ...inputs } = collectIdeInstallInputs(root, cwd, env);
    emit({ event: 'inputs', ...inputs, memberCount: members.length });
    for (const member of members) emit({ event: 'member', ...member });
  } catch { emit({ event: 'inputs-unavailable' }); }
  return await new Promise<InstallResult>((resolveResult) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, spawnOptions); }
    catch { emit({ event: 'spawn-failed' }); resolveResult({ status: null, signal: null }); return; }
    let finished = false;
    let interrupted: NodeJS.Signals | null = null;
    const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; try { child.kill(signal); } catch { /* The child may already have exited. */ } };
    const terminate = () => interrupt('SIGTERM');
    const cancel = () => interrupt('SIGINT');
    process.on('SIGTERM', terminate);
    process.on('SIGINT', cancel);
    const sample = () => {
      if (finished || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { emit({ event: 'waiting', pid: child.pid, process: readInstallProcessState(child.pid), locks: locks(root, cwd) }); }
      catch { emit({ event: 'sample-unavailable' }); }
    };
    const timer = setInterval(sample, diagnostics.intervalMs ?? 30_000);
    timer.unref();
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      process.off('SIGTERM', terminate);
      process.off('SIGINT', cancel);
      emit({ event: 'exit', status, signal });
      resolveResult({ status, signal });
      // Preserve cancellation of the wrapper as well as its install child.
      if (interrupted) process.kill(process.pid, interrupted);
    };
    child.once('error', () => { emit({ event: 'spawn-failed' }); finish(null, null); });
    child.once('close', finish);
    emit({ event: 'start', pid: child.pid ?? null });
  });
}
