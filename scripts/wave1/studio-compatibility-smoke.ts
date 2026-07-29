#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gameSlug = 'spin-cube';
const filePath = `.forgeax/games/${gameSlug}/.forgeax/wave1-compatibility-smoke.json`;
const evidence: Array<{ step: string; detail: string }> = [];
let stack: ChildProcess | undefined;
let baseUrl = '';
let runtimeId: string | undefined;
let browser: { close(): Promise<void> } | undefined;
let stoppingStack = false;

function record(step: string, detail: string): void {
  evidence.push({ step, detail });
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to reserve port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
  return body;
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopStack(): Promise<void> {
  if (!stack?.pid || stack.exitCode !== null) return;
  stoppingStack = true;
  stack.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => stack?.once('exit', () => resolveExit())),
    Bun.sleep(8_000),
  ]);
  if (stack.exitCode === null) stack.kill('SIGKILL');
  stack.stdout?.destroy();
  stack.stderr?.destroy();
}

try {
  const [serverPort, interfacePort, enginePort] = await Promise.all([freePort(), freePort(), freePort()]);
  baseUrl = `http://127.0.0.1:${serverPort}`;
  stack = spawn('bun', ['scripts/run.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORGEAX_CORE_ONLY: '1',
      FORGEAX_BRIDGE: '0',
      FORGEAX_CARRIER_HEADLESS: '1',
      FORGEAX_CARRIER_TIMEOUT_MS: '15000',
      FORGEAX_PROJECT_ROOT: root,
      FORGEAX_SERVER_PORT: String(serverPort),
      FORGEAX_SERVER_URL: `http://127.0.0.1:${serverPort}`,
      FORGEAX_INTERFACE_PORT: String(interfacePort),
      FORGEAX_ENGINE_PORT: String(enginePort),
      FORGEAX_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      FORGEAX_INTERFACE_ORIGIN: `http://127.0.0.1:${interfacePort}`,
    },
  });
  let logs = '';
  stack.stdout?.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-16_384); });
  stack.stderr?.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-16_384); });
  stack.once('exit', (code) => {
    if (code && !stoppingStack && !process.exitCode) process.stderr.write(logs);
  });

  await Promise.all([
    waitFor(`${baseUrl}/api/health`),
    waitFor(`http://127.0.0.1:${interfacePort}`),
  ]);
  record('boot', `isolated core stack ready on server ${serverPort}, interface ${interfacePort}, engine ${enginePort}`);

  await request(`/api/workbench/games/${gameSlug}/activate`, { method: 'POST' });
  const catalog = await request('/api/workbench/games');
  if (!JSON.stringify(catalog).includes(gameSlug)) throw new Error(`${gameSlug} missing from catalog`);
  record('open', `${gameSlug} activated`);
  record('catalog', `${gameSlug} observed through /api/workbench/games`);

  const content = JSON.stringify({ wave: 1, nonce: crypto.randomUUID() });
  await request('/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath, content }),
  });
  const saved = await request(`/api/files?path=${encodeURIComponent(filePath)}`);
  if (saved.content !== content) throw new Error('saved content did not round-trip');
  await request(`/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
  record('save', `write/read/delete round-trip passed for ${filePath}`);

  const health = await request('/api/health');
  if (typeof health.instanceRootAbs !== 'string') throw new Error('server health returned no instanceRootAbs');
  const scope = { projectId: health.instanceRootAbs, gameId: gameSlug };
  const ensured = await request('/api/runtime-carrier/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  runtimeId = ensured.runtimeId as string;
  if (!runtimeId) throw new Error('managed carrier ensure returned no runtimeId');
  const readyDeadline = Date.now() + 30_000;
  let status = ensured;
  while (Date.now() < readyDeadline) {
    status = await request(`/api/runtime-carrier/status/${encodeURIComponent(runtimeId)}`);
    if (status.lifecycle === 'running' && status.liveness === 'alive') break;
    await Bun.sleep(250);
  }
  if (status.lifecycle !== 'running' || status.liveness !== 'alive') {
    throw new Error(`managed carrier did not become live: ${JSON.stringify(status)}`);
  }

  const { chromium } = await import('playwright');
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.addInitScript((slug) => {
    localStorage.setItem('forgeax.onboarding.v2', JSON.stringify({ v: 2, phase: 'done', done: { tour: true, firstChat: true } }));
    localStorage.setItem('forgeax.pinnedSlug', slug);
  }, gameSlug);
  await page.goto(`http://127.0.0.1:${interfacePort}/?gameId=${gameSlug}`);
  await page.waitForFunction(() => Boolean((globalThis as { __forgeax_editor?: unknown }).__forgeax_editor), undefined, { timeout: 30_000 });
  await page.evaluate(() => (globalThis as unknown as {
    __forgeax_editor: { playSimulation(): Promise<void> };
  }).__forgeax_editor.playSimulation());
  await page.waitForFunction(() => (globalThis as unknown as {
    __forgeax_editor: { gateway: { mode: string } };
  }).__forgeax_editor.gateway.mode === 'play', undefined, { timeout: 30_000 });
  record('play', `headless Studio page entered Editor play mode; managed carrier ${runtimeId} remained live`);

  await page.evaluate(() => (globalThis as unknown as {
    __forgeax_editor: { stopSimulation(): void };
  }).__forgeax_editor.stopSimulation());
  await page.waitForFunction(() => (globalThis as unknown as {
    __forgeax_editor: { gateway: { mode: string } };
  }).__forgeax_editor.gateway.mode === 'edit', undefined, { timeout: 30_000 });
  const stopped = await request(`/api/runtime-carrier/stop/${encodeURIComponent(runtimeId)}`, { method: 'POST' });
  if (stopped.lifecycle !== 'stopped') throw new Error(`managed carrier did not stop: ${JSON.stringify(stopped)}`);
  record('stop', `headless Studio page returned to Editor edit mode and managed carrier ${runtimeId} stopped`);
  runtimeId = undefined;

  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, evidence, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (runtimeId) {
    await fetch(`${baseUrl}/api/runtime-carrier/stop/${encodeURIComponent(runtimeId)}`, { method: 'POST' }).catch(() => {});
  }
  await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' }).catch(() => {});
  await browser?.close().catch(() => {});
  await stopStack();
}
