#!/usr/bin/env bun

/**
 * Fresh-consumer acceptance for the packed plugin.
 *
 * It deliberately launches the published Node entrypoint from an empty project,
 * drives the real MCP stdio surface, and checks the preview health identity. A
 * browser screenshot is optional because CI machines may not have Chromium.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
const runtimeTarballs = process.argv.flatMap((argument, index, args) =>
  ['--runtime-tarball', '--common', '--platform', '--universal'].includes(argument) && args[index + 1]
    ? [resolve(args[index + 1]!)]
    : [],
);
const screenshotPath = process.argv.indexOf('--screenshot') >= 0
  ? process.argv[process.argv.indexOf('--screenshot') + 1]
  : undefined;
if (!tarball || !existsSync(tarball) || runtimeTarballs.some((path) => !existsSync(path))) {
  throw new Error(
    'usage: bun scripts/accept-packed-consumer.ts <package.tgz> [--common <runtime-common.tgz>] [--platform <runtime-platform.tgz>] [--universal <runtime-universal.tgz>] [--screenshot <png>]',
  );
}

const consumer = mkdtempSync(join(tmpdir(), 'forgeax-packed-consumer-'));
const node = process.env.NODE_BINARY ?? 'node';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

function previewState(): { pid?: number; buildHash?: string } | undefined {
  try {
    return JSON.parse(
      readFileSync(join(consumer, '.forgeax', 'logs', 'runtime', 'state.json'), 'utf8'),
    ) as { pid?: number; buildHash?: string };
  } catch {
    return undefined;
  }
}

function stopPreview(): void {
  const pid = previewState()?.pid;
  if (typeof pid !== 'number') return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* The detached preview may already have exited. */
  }
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
  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-save',
    '--no-audit',
    '--no-fund',
    ...(runtimeTarballs.length ? ['--force', ...runtimeTarballs] : []),
    tarball,
  ], consumer);
  const binary = join(consumer, 'node_modules/@forgeax/game/dist/main.js');
  const universal = join(consumer, 'node_modules/@forgeax/game-runtime/package.json');
  if (!existsSync(binary) || !existsSync(universal)) {
    throw new Error('packed consumer is missing the executable or Universal Runtime dependency');
  }
  run(node, [binary, 'init', '--game', 'smoke'], consumer);
  const sdk = join(consumer, '.forgeax', 'engine-sdk');
  if (!existsSync(join(sdk, 'engine-version.json'))) {
    throw new Error('Runtime package did not install its Engine SDK into the consumer project');
  }

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
      throw new Error(`selected Runtime package did not reach runtime tier:\n${runText}`);
    }
    const previewUrl = runText.match(/^preview_url: (.+)$/m)?.[1];
    if (!previewUrl) throw new Error(`MCP result did not return preview_url:\n${runText}`);
    const health = await fetch(`${new URL(previewUrl).origin}/preview/__forgeax_health`).then((response) => response.json()) as {
      status?: string;
      gameId?: string;
      buildHash?: string;
      runtimeVersion?: string;
      engineCommit?: string;
      projectRoot?: string;
      gameRoot?: string;
      outputRoot?: string;
    };
    const expectedRoot = realpathSync(consumer);
    const expectedGameRoot = realpathSync(join(consumer, '.forgeax', 'games', 'smoke'));
    const actualRoot = health.projectRoot ? realpathSync(health.projectRoot) : '';
    const actualGameRoot = health.gameRoot ? realpathSync(health.gameRoot) : '';
    if (
      health.status !== 'ok'
      || health.gameId !== 'smoke'
      || actualRoot !== expectedRoot
      || actualGameRoot !== expectedGameRoot
      || !health.buildHash
      || !health.runtimeVersion
      || !health.engineCommit
      || !health.outputRoot
    ) {
      throw new Error(`preview identity did not match the consumer and Engine SDK: ${JSON.stringify(health)}`);
    }
    const firstBuildHash = health.buildHash;
    const secondRun = await mcpRequest(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: consumer, game: 'smoke' } },
    });
    const secondText = textOf(secondRun);
    if (!secondText.includes('build.reused: true')) {
      throw new Error(`preview cache was not reused:\n${secondText}`);
    }
    const gameEntry = join(consumer, '.forgeax', 'games', 'smoke', 'main.ts');
    writeFileSync(gameEntry, `${readFileSync(gameEntry, 'utf8')}\n// acceptance cache invalidation\n`);
    const thirdRun = await mcpRequest(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: consumer, game: 'smoke' } },
    });
    const thirdText = textOf(thirdRun);
    if (!thirdText.includes('build.reused: false') || thirdText.includes(firstBuildHash)) {
      throw new Error(`preview cache was not invalidated after a source change:\n${thirdText}`);
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
    console.log(`preview.project_root: ${health.projectRoot}`);
    console.log(`preview.runtime_version: ${health.runtimeVersion}`);
    console.log(`preview.engine_commit: ${health.engineCommit}`);
    console.log(`Packed consumer acceptance passed: ${consumer}`);
    console.log(runText);
  } finally {
    child.kill('SIGTERM');
    stopPreview();
  }
} finally {
  if (process.env.KEEP_ACCEPTANCE !== '1') rmSync(consumer, { recursive: true, force: true });
}
