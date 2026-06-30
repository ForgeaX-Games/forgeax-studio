#!/usr/bin/env bun
// scripts/open-web.ts — open Studio in Chrome with WebGPU reliably enabled.
// Replaces open-web.sh (`bun fx start` opens this after the stack is ready).
//
// The engine renders the viewport via WebGPU; on a browser where it isn't
// enabled-by-default (or the GPU is blocklisted) createApp fails with "no usable
// backend". Chrome also ignores flags when an instance for that profile already
// runs. So we launch Chrome on a DEDICATED persistent profile (flags always
// apply) with --enable-unsafe-webgpu --ignore-gpu-blocklist. The desktop app
// (bun fx start app, WebKit/Metal) already has WebGPU and is unaffected.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './lib/env.ts';
import { isPortBusy } from './lib/proc.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(ROOT, '.env'))) loadDotenv(join(ROOT, '.env'));

const port = Number.parseInt(process.env.FORGEAX_INTERFACE_PORT ?? '18920', 10);
const url = `http://localhost:${port}`;
const profile = join(ROOT, '.forgeax/chrome-webgpu-profile'); // .forgeax/ is gitignored

// 1. stack must be running (this opens a client; it doesn't boot the server).
if (!isPortBusy(port)) {
  console.error(`[web] Studio UI (:${port}) is not up.`);
  console.error('[web]   start the stack first:  bun fx start      (or: bun fx start app)');
  process.exit(1);
}

// 2. locate Chrome per platform.
const chrome = findChrome();
if (!chrome) {
  console.error('[web] Google Chrome not found.');
  console.error(`[web] Install Chrome, or open ${url} in a WebGPU-capable browser yourself.`);
  console.error('[web] (The desktop app works without Chrome: bun fx start app)');
  process.exit(1);
}

mkdirSync(profile, { recursive: true });
console.log(`[web] launching Chrome (WebGPU forced) → ${url}`);
console.log('[web]   flags: --enable-unsafe-webgpu --ignore-gpu-blocklist');
console.log("[web] If the viewport shows 'no usable backend': check chrome://gpu, or use bun fx start app.");

// Launch detached so this process can exit while Chrome keeps running. A
// dedicated --user-data-dir guarantees the flags take effect.
const child = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ],
  { stdio: 'ignore', detached: true },
);
child.unref();
console.log(`[web] Chrome launched (pid ${child.pid}).`);

/** Find a Chrome executable across macOS / Windows / Linux. */
function findChrome(): string | null {
  const candidates: string[] =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [
            join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}
