#!/usr/bin/env bun
// scripts/open-web.ts — focus Studio in the user's Chrome, with an explicit
// isolated forced-WebGPU mode for diagnosis.
// Invoked explicitly by `bun fx open` after the stack is ready.
//
// Default mode preserves the person's account, extensions, cookies, and tabs.
// `--managed` uses a dedicated persistent profile so forced WebGPU flags always
// apply when diagnosing a blocked backend. The desktop app (WebKit/Metal) is
// unaffected.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './lib/env.ts';
import { managedChromeProfile, reuseManagedChrome, wantsManagedChrome } from './lib/managed-chrome.ts';
import { isPortBusy } from './lib/proc.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(ROOT, '.env'))) loadDotenv(join(ROOT, '.env'));

const port = Number.parseInt(process.env.FORGEAX_INTERFACE_PORT ?? '18920', 10);
const url = `http://localhost:${port}`;
const profile = managedChromeProfile();
const managed = wantsManagedChrome(process.argv.slice(2));

// 1. stack must be running (this opens a client; it doesn't boot the server).
if (!isPortBusy(port)) {
  console.error(`[web] Studio UI (:${port}) is not up.`);
  console.error('[web]   start the stack first:  bun fx start      (or: bun fx start desktop)');
  process.exit(1);
}

// 2. locate Chrome per platform.
const chrome = findChrome();
if (!chrome) {
  // headless Linux server / minimal container: Chrome-not-installed is a valid
  // deployment shape, not a command failure. Print the URL so the operator can
  // browse in from another machine.
  console.log(`[web] Studio UI ready at ${url}`);
  console.log('[web] no local Chrome/Chromium found — open the URL from a WebGPU-capable browser');
  console.log('[web] (or use the desktop app on macOS/Windows: bun fx start desktop)');
  process.exit(0);
}

if (!managed) {
  openUserChrome(chrome, url);
  process.exit(0);
}

mkdirSync(profile, { recursive: true });
const reuse = await reuseManagedChrome(profile, url);
if (reuse === 'focused') {
  console.log(`[web] focused existing Studio tab → ${url}`);
  process.exit(0);
}
if (reuse === 'opened-tab') {
  console.log(`[web] opened Studio in the managed Chrome → ${url}`);
  process.exit(0);
}

console.log(`[web] launching Chrome (WebGPU forced) → ${url}`);
console.log('[web]   flags: --enable-unsafe-webgpu --ignore-gpu-blocklist');
console.log("[web] If the viewport shows 'no usable backend': check chrome://gpu, or use bun fx start desktop.");

// Launch detached so this process can exit while Chrome keeps running. A
// dedicated --user-data-dir guarantees the flags take effect.
const child = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ],
  { stdio: 'ignore', detached: true, windowsHide: true },
);
child.unref();
console.log(`[web] managed Chrome launch requested (pid ${child.pid}, profile ${profile}).`);

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

/** Reuse the person's normal Chrome profile; on macOS focus an existing Studio tab. */
function openUserChrome(chrome: string, requestedUrl: string): void {
  if (process.platform === 'darwin') {
    const script = `
on run argv
  set targetUrl to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      repeat with i from 1 to count of tabs of w
        if URL of tab i of w is targetUrl or URL of tab i of w is targetUrl & "/" then
          set active tab index of w to i
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
    open location targetUrl
    activate
    return "opened"
  end tell
end run`;
    const result = spawnSync('osascript', ['-e', script, requestedUrl], { encoding: 'utf8' });
    if (result.status === 0) {
      console.log(`[web] ${result.stdout.trim() || 'opened'} Studio in your Chrome → ${requestedUrl}`);
      return;
    }
  }

  const child = spawn(chrome, [requestedUrl], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  console.log(`[web] opened Studio in your Chrome → ${requestedUrl}`);
}
