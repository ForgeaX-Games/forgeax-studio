// scripts/lib/standalone-plugins.ts — discover + boot toolchain for marketplace
// standalone-backend workbench plugins (embeddedAlso:false → run.ts spawns dev servers).
//
// pnpm-based node-editor apps (wb-2d-scene-asset-generator, wb-3d-lowpoly,
// wb-scene-generator) need corepack to activate pnpm non-interactively before
// `pnpm dev` — otherwise Corepack blocks on `[Y/n]` and every plugin iframe 404s.
// bun-based plugins (wb-reel) must be launched with `bun dev`, not pnpm.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { has, run } from './sh.ts';

export interface DiscoveredStandalonePlugin {
  dir: string;
  id: string;
  shortId: string;
  port: number;
}

const DEFAULT_PNPM = '9.0.0';

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
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredStandalonePlugin[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const mf = join(pluginsDir, e.name, 'forgeax-plugin.json');
    if (!existsSync(mf)) continue;
    let m: { id?: string; entry?: { standalone?: { embeddedAlso?: boolean; start?: unknown; port?: unknown } } };
    try {
      m = JSON.parse(readFileSync(mf, 'utf8'));
    } catch {
      continue;
    }
    const sa = m.entry?.standalone;
    if (!sa || sa.embeddedAlso !== false || !sa.start || typeof sa.port !== 'number') continue;
    const id = String(m.id ?? e.name);
    const shortId = id.replace(/^@[^/]+\//, '');
    let dir = join(pluginsDir, e.name);
    try {
      dir = realpathSync(dir);
    } catch {
      // keep unresolved
    }
    out.push({ dir, id, shortId, port: sa.port });
  }
  return out;
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
