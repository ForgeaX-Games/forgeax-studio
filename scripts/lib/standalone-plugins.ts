// scripts/lib/standalone-plugins.ts — discover + boot toolchain for marketplace
// standalone-backend extensions (embeddedAlso:false → run.ts spawns dev servers).
//
// pnpm-based node-editor apps need corepack to activate pnpm non-interactively before
// `pnpm dev` — otherwise Corepack blocks on `[Y/n]` and every plugin iframe 404s.
// Bun-based extensions must be launched with `bun dev`, not pnpm.

import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { has, run } from './sh.ts';

export interface DiscoveredStandalonePlugin {
  dir: string;
  id: string;
  shortId: string;
  port: number;
  start: string;
}

export interface StandaloneRuntimePlugin extends DiscoveredStandalonePlugin {
  frontendPort: number;
  backendPort: number;
  projectRoot: string;
}

export interface AllocateStandaloneRuntimePluginsOptions {
  projectRoot: string;
  portOffset: number;
  reservedPorts: readonly number[];
  isPortBusy(port: number): boolean;
}

const DEFAULT_PNPM = '9.0.0';
const RETIRED_STANDALONE_EXTENSION_IDS = new Set(['@forgeax-extension/video-game']);

type PackageJson = { packageManager?: string; scripts?: Record<string, string> };

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** Marketplace manifests with entry.standalone { embeddedAlso:false, start, port }. */
export function discoverStandalonePlugins(pluginsDir: string): DiscoveredStandalonePlugin[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredStandalonePlugin[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(pluginsDir, e.name);
    const canonicalManifest = join(dir, 'forgeax-extension.json');
    const legacyManifest = join(dir, 'forgeax-plugin.json');
    const mf = existsSync(canonicalManifest)
      ? canonicalManifest
      : existsSync(legacyManifest) ? legacyManifest : null;
    if (!mf) continue;
    let m: { id?: string; entry?: { standalone?: { embeddedAlso?: boolean; start?: unknown; port?: unknown } } };
    try {
      m = JSON.parse(readFileSync(mf, 'utf8'));
    } catch {
      continue;
    }
    const sa = m.entry?.standalone;
    if (!sa || sa.embeddedAlso !== false || typeof sa.start !== 'string' || !sa.start.trim() || typeof sa.port !== 'number') continue;
    const id = String(m.id ?? e.name);
    if (RETIRED_STANDALONE_EXTENSION_IDS.has(id)) continue;
    const shortId = id.replace(/^@[^/]+\//, '');
    let resolvedDir = dir;
    try {
      resolvedDir = realpathSync(dir);
    } catch {
      // keep unresolved
    }
    out.push({ dir: resolvedDir, id, shortId, port: sa.port, start: sa.start });
  }
  return out;
}

/** Parse the manifest command into an argv without enabling a shell. */
export function standalonePluginInvocation(start: string): { cmd: string; args: string[] } {
  if (/[;&|<>`$\n\r]/.test(start)) {
    throw new Error(`standalone plugin start command contains a shell operator: ${start}`);
  }
  const words: string[] = [];
  const token = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s"']+)/g;
  let consumed = 0;
  for (const match of start.matchAll(token)) {
    const gap = start.slice(consumed, match.index);
    if (gap.trim()) throw new Error(`invalid standalone plugin start command: ${start}`);
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"])/g, '$1'));
    consumed = (match.index ?? 0) + match[0].length;
  }
  if (start.slice(consumed).trim() || words.length === 0) {
    throw new Error(`invalid standalone plugin start command: ${start}`);
  }
  return { cmd: words[0]!, args: words.slice(1) };
}

/** Allocate one isolated frontend/backend pair for each discovered extension. */
export function allocateStandaloneRuntimePlugins(
  plugins: readonly DiscoveredStandalonePlugin[],
  options: AllocateStandaloneRuntimePluginsOptions,
): StandaloneRuntimePlugin[] {
  if (!Number.isSafeInteger(options.portOffset) || options.portOffset < 0) {
    throw new Error(`standalone plugin port offset must be a non-negative integer: ${options.portOffset}`);
  }
  const allocated = new Set(options.reservedPorts);
  const allocate = (seed: number): number => {
    let candidate = seed;
    while (candidate <= 65_535 && (allocated.has(candidate) || options.isPortBusy(candidate))) {
      candidate++;
    }
    if (candidate > 65_535) throw new Error(`no standalone plugin port available from ${seed}`);
    allocated.add(candidate);
    return candidate;
  };

  return plugins.map((plugin) => {
    const frontendSeed = plugin.port + options.portOffset;
    if (frontendSeed > 65_535) {
      throw new Error(`standalone plugin ${plugin.id} port exceeds 65535 after offset`);
    }
    const frontendPort = allocate(frontendSeed);
    const backendPort = allocate(frontendSeed + 2);
    return {
      ...plugin,
      frontendPort,
      backendPort,
      projectRoot: join(options.projectRoot, '.forgeax', 'extension-runtime', plugin.shortId),
    };
  });
}

/** Server/interface contract used to project dynamically allocated dev ports. */
export function standalonePluginPortMap(plugins: readonly StandaloneRuntimePlugin[]) {
  return {
    generatedBy: 'scripts/local-runtime.ts',
    plugins: Object.fromEntries(plugins.map((plugin) => [
      plugin.id,
      { frontendPort: plugin.frontendPort, backendPort: plugin.backendPort },
    ])),
  };
}

/** Pick the plugin run script: dev (HMR, default) or serve. */
export function extPluginCmd(dir: string): string {
  const pkg = readPackageJson(dir);
  const hasScript = (name: string): boolean => Boolean(pkg?.scripts?.[name]);
  if (process.env.FORGEAX_PLUGIN_HMR !== '0') {
    return hasScript('dev') ? 'dev' : hasScript('serve') ? 'serve' : 'dev';
  }
  return hasScript('serve') ? 'serve' : hasScript('dev') ? 'dev' : 'serve';
}

function pnpmVersionFor(dir: string): string | null {
  const pm = readPackageJson(dir)?.packageManager ?? '';
  if (pm.startsWith('bun@')) return null;
  if (pm.startsWith('pnpm@')) return pm.slice('pnpm@'.length);
  return DEFAULT_PNPM;
}

/**
 * Ensure pnpm is activated via corepack (non-interactive) for every discovered
 * pnpm-based standalone-backend plugin. Idempotent — safe to call from restart.sh
 * and again from run.ts.
 */
export function ensureStandalonePluginToolchain(pluginsDir: string): boolean {
  const plugins = discoverStandalonePlugins(pluginsDir);
  if (plugins.length === 0) return true;

  const pnpmByVersion = new Map<string, string[]>();
  let bunCount = 0;
  for (const p of plugins) {
    const ver = pnpmVersionFor(p.dir);
    if (ver === null) {
      bunCount++;
      continue;
    }
    const list = pnpmByVersion.get(ver) ?? [];
    list.push(p.shortId);
    pnpmByVersion.set(ver, list);
  }

  // Without this, first `pnpm` invocation hangs on Corepack's `[Y/n]` prompt and
  // run.ts's detached spawns never bind their dev ports.
  process.env.COREPACK_ENABLE_DOWNLOAD = '1';

  if (pnpmByVersion.size > 0) {
    if (!has('corepack')) {
      console.error(
        '[standalone-plugins] corepack not found — pnpm-based standalone plugins cannot start.',
      );
      console.error(
        `[standalone-plugins] affected: ${[...pnpmByVersion.values()].flat().join(', ')}`,
      );
      return false;
    }
    for (const [ver, ids] of [...pnpmByVersion.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`[standalone-plugins] ensuring pnpm@${ver} for ${ids.join(', ')}…`);
      if (!run('corepack', ['prepare', `pnpm@${ver}`, '--activate'])) {
        console.error(`[standalone-plugins] corepack prepare pnpm@${ver} failed`);
        return false;
      }
    }
    if (!has('pnpm')) {
      console.error('[standalone-plugins] pnpm not on PATH after corepack prepare');
      return false;
    }
  }

  if (bunCount > 0) {
    console.log(`[standalone-plugins] ${bunCount} bun-based plugin(s) → bun dev`);
  }

  return true;
}

/** Resolve the package manager binary for a plugin's dev/serve script. */
export function resolvePluginRunner(dir: string, script: string): { cmd: string; args: string[] } {
  const pm = readPackageJson(dir)?.packageManager ?? '';
  if (pm.startsWith('bun@')) {
    return { cmd: 'bun', args: [script] };
  }
  return { cmd: 'pnpm', args: [script] };
}
