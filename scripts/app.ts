#!/usr/bin/env bun
// @ts-nocheck
// scripts/app.ts — ForgeaX Studio desktop app, one command (Tauri 2).
// Replaces app.sh (`bun fx start app`, `bun fx build app`).
//
//   bun fx start app          # dev app: native window running LIVE source (HMR).
//   bun fx start app debug    #   same + auto-open DevTools
//   bun fx build app          # package a distributable .app/.dmg (macOS)
//   bun scripts/app.ts open   # open the last-built .app (macOS)
//   bun fx stop               # stop the dev web stack
//
// dev runs on macOS and Windows (Git-Bash no longer needed — pure Bun). build/
// open packaging is macOS-only (.app/.dmg).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortBusy, sleep, spawnService } from './lib/proc.ts';
import { has, IS_WIN } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.STUDIO = process.env.STUDIO ?? '1';

const args = process.argv.slice(2);
let mode = args[0] ?? 'dev';
let devtools = false;
if (mode === 'debug') {
  mode = 'dev';
  devtools = true;
}
if (args.includes('debug')) devtools = true;
process.env.FORGEAX_DEVTOOLS = devtools ? '1' : '0';

const EXE = IS_WIN ? '.exe' : '';
const ifaceDir = join(ROOT, 'packages/interface');

switch (mode) {
  case 'dev':
  case '':
    await devMode();
    break;
  case 'build':
    buildMode();
    break;
  case 'open':
    openMode();
    break;
  case 'stop':
    runScript('stop.ts', args.slice(1));
    break;
  default:
    console.error('usage: bun fx start app [debug]  |  bun fx build app');
    process.exit(2);
}

// ── dev ───────────────────────────────────────────────────────────────────
async function devMode(): Promise<void> {
  // First run on a fresh clone: deps + engine build (idempotent).
  if (!existsSync(join(ROOT, 'packages/editor/packages/engine/packages/runtime/dist/index.mjs'))) {
    console.log('[app] first run — installing deps + building engine (setup)…');
    runScript('setup.ts', []);
  }

  // The desktop app OWNS the full dev-stack lifecycle: reap any existing/stale
  // stack, start fresh, and tear it all down when the window closes.
  console.log('[app] clean restart — reaping any existing/stale web stack first…');
  runScript('stop.ts', ['--force'], true);

  console.log('[app] clearing webview HTTP cache (force fresh source load)…');
  clearWebviewCache();

  console.log('[app] starting web stack (run.ts) in background…');
  const stackLog = join(tmpdir(), 'forgeax-stack.log');
  const fd = openSync(stackLog, 'a');
  spawnService(process.execPath, [join(ROOT, 'scripts/run.ts')], { cwd: ROOT, detach: true, logFd: fd });

  process.stdout.write('[app] waiting for UI :18920');
  let up = false;
  for (let i = 0; i < 90; i++) {
    if (isPortBusy(18920)) {
      up = true;
      break;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log();
  if (!up) {
    console.error(`[app] web stack failed to come up — see ${stackLog}`);
    runScript('stop.ts', ['--force'], true);
    process.exit(1);
  }

  // Tear the whole stack down when the app window (tauri:dev) exits.
  const teardown = () => {
    console.log('[app] app closed — stopping the whole web stack…');
    runScript('stop.ts', ['--force'], true);
  };
  process.on('exit', teardown);
  process.on('SIGINT', () => {
    teardown();
    process.exit(130);
  });

  stageTauriSidecar();
  stageTauriResourcesStub();
  reapDevWindows();
  ensureCcToolchain();

  console.log(`[app] launching desktop dev window (tauri:dev — live HMR, DevTools ${devtools ? 'ON' : 'off'})…`);
  // tauri:dev always runs from packages/interface (src-tauri lives there).
  const r = spawnSync('bun', ['run', 'tauri:dev'], { cwd: ifaceDir, stdio: 'inherit', shell: IS_WIN });
  process.exit(r.status ?? 0);
}

// ── build (macOS) ────────────────────────────────────────────────────────────
function buildMode(): void {
  console.log('[app] packaging .app (build-desktop.sh assembles Resources, then tauri build)…');
  // build-desktop stays bash for now (macOS-only payload assembly; see migration
  // TODO). On macOS bash is always present.
  const r1 = spawnSync('bash', [join(ROOT, 'scripts/build-desktop.sh')], { stdio: 'inherit', cwd: ROOT });
  if (r1.status !== 0) process.exit(r1.status ?? 1);
  const r2 = spawnSync('bunx', ['tauri', 'build'], { cwd: ifaceDir, stdio: 'inherit', shell: IS_WIN });
  if (r2.status !== 0) process.exit(r2.status ?? 1);
  const app = join(ifaceDir, 'src-tauri/target/release/bundle/macos/ForgeaX Studio.app');
  if (existsSync(app)) console.log(`[app] ✓ built: ${app}   (run: bun scripts/app.ts open)`);
  else {
    console.log('[app] build finished but .app not found (check the bundle dir)');
    process.exit(1);
  }
}

function openMode(): void {
  const app = join(ifaceDir, 'src-tauri/target/release/bundle/macos/ForgeaX Studio.app');
  if (!existsSync(app)) {
    console.error('[app] no built .app — run: bun fx build app');
    process.exit(1);
  }
  spawnSync('open', [app], { stdio: 'inherit' });
  console.log(`[app] opened ${app}`);
}

// ── helpers ───────────────────────────────────────────────────────────────
function runScript(name: string, scriptArgs: string[], quiet = false): void {
  spawnSync(process.execPath, [join(ROOT, 'scripts', name), ...scriptArgs], {
    cwd: ROOT,
    stdio: quiet ? 'ignore' : 'inherit',
  });
}

/** Reap any previous desktop dev window so a relaunch lands on fresh source. */
function reapDevWindows(): void {
  if (IS_WIN) {
    const r = spawnSync('tasklist', [], { encoding: 'utf8' });
    if ((r.stdout ?? '').toLowerCase().includes('forgeax-studio-desktop')) {
      console.log('[app] closing previous dev window(s) so you get the latest code…');
      spawnSync('taskkill', ['/IM', 'forgeax-studio-desktop.exe', '/F'], { stdio: 'ignore' });
    }
  } else {
    const r = spawnSync('pgrep', ['-f', 'forgeax-studio-desktop'], { encoding: 'utf8' });
    if ((r.stdout ?? '').trim()) {
      console.log('[app] closing previous dev window(s) so you get the latest code…');
      spawnSync('pkill', ['-f', 'forgeax-studio-desktop'], { stdio: 'ignore' });
    }
  }
}

/** Bust the webview HTTP cache (keep localStorage/IndexedDB). Per-engine paths. */
function clearWebviewCache(): void {
  if (IS_WIN) {
    const base = join(process.env.LOCALAPPDATA ?? '', 'com.forgeax.studio/EBWebView/Default');
    for (const sub of ['Cache', 'Code Cache', 'GPUCache']) rmSync(join(base, sub), { recursive: true, force: true });
  } else {
    const home = process.env.HOME ?? '';
    rmSync(join(home, 'Library/Caches/com.forgeax.studio'), { recursive: true, force: true });
    rmSync(join(home, 'Library/Caches/forgeax-studio-desktop'), { recursive: true, force: true });
    rmSync(join(home, 'Library/Saved Application State/com.forgeax.studio.savedState'), {
      recursive: true,
      force: true,
    });
  }
}

/** Stage the bun sidecar tauri's externalBin resolver requires (idempotent). */
function stageTauriSidecar(): void {
  const triple = (spawnSync('rustc', ['-Vv'], { encoding: 'utf8' }).stdout ?? '').match(/^host:\s*(.+)$/m)?.[1]?.trim();
  if (!triple) return;
  const binDir = join(ifaceDir, 'src-tauri/binaries');
  const dest = join(binDir, `bun-${triple}${EXE}`);
  if (existsSync(dest)) return;
  let bunBin = process.execPath; // the bun running this script
  if (!existsSync(bunBin) && existsSync(bunBin + EXE)) bunBin += EXE;
  if (existsSync(bunBin)) {
    mkdirSync(binDir, { recursive: true });
    copyFileSync(bunBin, dest);
    console.log(`[app] staged tauri sidecar: bun-${triple}${EXE}`);
  }
}

/** tauri.conf declares resources:["resources"]; the build script needs the dir to exist. */
function stageTauriResourcesStub(): void {
  const resDir = join(ifaceDir, 'src-tauri/resources');
  mkdirSync(resDir, { recursive: true });
  const keep = join(resDir, '.gitkeep');
  if (!existsSync(keep)) writeFileSync(keep, '');
}

/** Windows-gnu: put MinGW-w64 (gcc/dlltool) on PATH so cargo can link the shell. */
function ensureCcToolchain(): void {
  if (!IS_WIN) return;
  if (has('dlltool') && has('gcc')) return;
  const base = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages');
  const candidates = [
    ...globWinlibs(base),
    'C:\\msys64\\mingw64\\bin',
    'C:\\mingw64\\bin',
  ];
  for (const d of candidates) {
    if (existsSync(join(d, 'dlltool.exe')) && existsSync(join(d, 'gcc.exe'))) {
      process.env.PATH = `${d};${process.env.PATH ?? ''}`;
      console.log(`[app] MinGW-w64 on PATH: ${d}`);
      return;
    }
  }
  console.error("[app] WARNING: MinGW-w64 (gcc/dlltool) not found — 'tauri dev' can't link the Rust shell.");
  console.error('[app]          install once:  winget install BrechtSanders.WinLibs.POSIX.MSVCRT');
}

/** Find BrechtSanders WinLibs mingw64/bin dirs under the WinGet packages base. */
function globWinlibs(base: string): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const name of readdirSync(base)) {
    if (name.startsWith('BrechtSanders.WinLibs.')) out.push(join(base, name, 'mingw64/bin'));
  }
  return out;
}
