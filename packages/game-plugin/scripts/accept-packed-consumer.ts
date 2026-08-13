#!/usr/bin/env bun

/**
 * Fresh-consumer acceptance for the packed plugin.
 *
 * It deliberately launches the published Node entrypoint from an empty project,
 * drives the real MCP stdio surface, and checks the preview health identity. A
 * browser screenshot is optional because CI machines may not have Chromium.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
const screenshotPath = process.argv.indexOf('--screenshot') >= 0
  ? process.argv[process.argv.indexOf('--screenshot') + 1]
  : undefined;
if (!tarball || !existsSync(tarball)) throw new Error('usage: bun scripts/accept-packed-consumer.ts <package.tgz> [--screenshot <png>]');

const consumer = mkdtempSync(join(tmpdir(), 'forgeax-packed-consumer-'));
const node = process.env.NODE_BINARY ?? 'node';
const env = {
  ...process.env,
  FORGEAX_SERVER_PORT: '39200',
  FORGEAX_ENGINE_PORT: '39201',
  FORGEAX_RUNTIME_CACHE: join(consumer, '.runtime-cache'),
};

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = (value as { result?: { content?: Array<{ text?: unknown }> } }).result?.content;
  return content?.map((item) => typeof item.text === 'string' ? item.text : '').join('\n') ?? '';
}

async function mcpRequest(child: ReturnType<typeof spawn>, request: Record<string, unknown>): Promise<any> {
  return await new Promise((resolveRequest, reject) => {
    let buffer = '';
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384);
    });
    const timer = setTimeout(
      () => reject(new Error(`MCP request timed out: ${String(request.method)}\n${stderr}`)),
      180_000,
    );
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line) as { id?: unknown };
          if (response.id !== request.id) continue;
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          resolveRequest(response);
          return;
        } catch {
          /* Ignore non-protocol output; the response remains authoritative. */
        }
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}

try {
  console.log(`Fresh consumer: ${consumer}`);
  run('npm', ['install', '--ignore-scripts', '--no-save', tarball], consumer);
  const binary = join(consumer, 'node_modules/@forgeax/game/dist/main.js');
  const sdk = join(consumer, 'node_modules/@forgeax/game/assets/engine-sdk');
  if (!existsSync(binary) || !existsSync(join(sdk, 'engine-version.json'))) {
    throw new Error('packed consumer is missing the executable or Engine SDK');
  }
  run(node, [binary, 'init', '--game', 'smoke'], consumer);

  const child = spawn(node, [binary], { cwd: consumer, env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await mcpRequest(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const status = await mcpRequest(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forgeax_status_lite', arguments: { target_dir: consumer } },
    });
    const statusText = textOf(status);
    if (!statusText.includes('Engine SDK') || !statusText.includes('active game: smoke')) {
      throw new Error(`status did not describe the fresh consumer:\n${statusText}`);
    }
    const runResult = await mcpRequest(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: consumer, game: 'smoke' } },
    });
    const runText = textOf(runResult);
    if (!runText.includes('tier: runtime') || !runText.includes('engine.identity:')) {
      throw new Error(`bundled Runtime did not reach runtime tier:\n${runText}`);
    }
    const previewUrl = runText.match(/^preview_url: (.+)$/m)?.[1];
    if (!previewUrl) throw new Error(`MCP result did not return preview_url:\n${runText}`);
    const health = await fetch(`${new URL(previewUrl).origin}/preview/__forgeax_health`).then((response) => response.json()) as {
      instanceRootAbs?: string;
      runtimeVersion?: string;
      engineVersion?: string;
    };
    const expectedRoot = realpathSync(consumer);
    const actualRoot = health.instanceRootAbs ? realpathSync(health.instanceRootAbs) : '';
    if (actualRoot !== expectedRoot || !health.runtimeVersion || !health.engineVersion) {
      throw new Error(`preview identity did not match the consumer and Engine SDK: ${JSON.stringify(health)}`);
    }
    if (screenshotPath) {
      const target = resolve(screenshotPath);
      const shot = spawnSync('bunx', ['--bun', 'playwright', 'screenshot', '--wait-for-timeout=3000', previewUrl, target], {
        encoding: 'utf8',
      });
      if (shot.status === 0 && existsSync(target)) {
        console.log(`Browser screenshot: ${target}`);
      } else {
        console.warn(`Browser screenshot skipped: ${shot.stderr?.trim() || shot.stdout?.trim() || 'playwright unavailable'}`);
      }
    }
    console.log(`preview.instance_root: ${health.instanceRootAbs}`);
    console.log(`preview.runtime_version: ${health.runtimeVersion}`);
    console.log(`preview.engine_version: ${health.engineVersion}`);
    console.log(`Packed consumer acceptance passed: ${consumer}`);
    console.log(runText);
  } finally {
    child.kill('SIGTERM');
  }
} finally {
  if (process.env.KEEP_ACCEPTANCE !== '1') rmSync(consumer, { recursive: true, force: true });
}
