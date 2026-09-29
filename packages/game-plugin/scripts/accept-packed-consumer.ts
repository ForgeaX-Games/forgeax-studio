#!/usr/bin/env bun

/** Packed, external, headless G0 acceptance against the approved E0 SDK artifacts. */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const EXPECTED_ZIP = '5a9d35d6c05645e889fa8c0c01a9ff2ec7471b5d4afea1d4818eb9a8a6738145';
const EXPECTED_CARRIER = '4bffb2652bc450131e335b5e55cdff3e206c86a4366b631c46abf9273b3b835a';
const EXPECTED_ENGINE = '61fe635acc46de1d8103ae778efe6170c4d6c3f2';
const EXPECTED_VERSION = '0.0.0-e0.61fe635ac';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]!) : undefined;
}

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
const sdkZip = option('--sdk-zip');
const sdkCarrier = option('--sdk-carrier');
if (!tarball || !sdkZip || !sdkCarrier || [tarball, sdkZip, sdkCarrier].some((path) => !existsSync(path))) {
  throw new Error('usage: bun scripts/accept-packed-consumer.ts <game.tgz> --sdk-zip <zip> --sdk-carrier <tgz>');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (sha256(sdkZip) !== EXPECTED_ZIP || sha256(sdkCarrier) !== EXPECTED_CARRIER) {
  throw new Error('approved Engine artifact SHA-256 mismatch');
}

const fixture = mkdtempSync(join(tmpdir(), 'forgeax-g0-packed-'));
const sdkParent = join(fixture, 'sdk');
const game = join(fixture, 'external-game');
const consumer = join(fixture, 'consumer');
const node = process.env.NODE_BINARY ?? 'node';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let lastPreviewPid: number | undefined;

function run(command: string, args: string[], cwd = fixture): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stateFromRun(text: string): { path: string; value: any } {
  const path = text.match(/^preview\.state_file: (.+)$/m)?.[1];
  if (!path) throw new Error(`run result omitted preview.state_file:\n${text}`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error(`state mode is not 0600: ${path}`);
  return { path, value };
}

function resultText(value: any): string {
  return value?.result?.content?.map((entry: any) => entry?.text ?? '').join('\n') ?? '';
}

async function mcpRequest(child: ReturnType<typeof spawn>, request: Record<string, unknown>): Promise<any> {
  return await new Promise((resolveRequest, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`MCP request timed out: ${String(request.method)}\n${stderr}`)), 170_000);
    const finish = (error?: Error, value?: any): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onError);
      if (error) reject(error);
      else resolveRequest(value);
    };
    const onError = (chunk: Buffer): void => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-32_768); };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === request.id) return finish(undefined, response);
        } catch {
          /* stdout is protocol-only; retain waiting for the requested id */
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onError);
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}

async function waitDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  if (alive(pid)) throw new Error(`process ${pid} remained alive`);
}

try {
  run('unzip', ['-q', sdkZip, '-d', sdkParent]);
  const sdk = join(sdkParent, 'forgeax-sdk');
  const fullManifest = JSON.parse(readFileSync(join(sdk, 'sdk-manifest.json'), 'utf8'));
  if (fullManifest.engineCommit !== EXPECTED_ENGINE || fullManifest.sdkVersion !== EXPECTED_VERSION) {
    throw new Error('full SDK manifest identity mismatch');
  }
  const newEnvelope = JSON.parse(run(join(sdk, 'bin', 'forgeax'), ['new', game, '--template', 'empty', '--json']).trim());
  if (!newEnvelope.ok || newEnvelope.value?.sdkVersion !== EXPECTED_VERSION) {
    throw new Error(`Engine new did not bind ${EXPECTED_VERSION}: ${JSON.stringify(newEnvelope)}`);
  }

  mkdirSync(consumer);
  run(npm, ['init', '-y'], consumer);
  run(npm, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    tarball, sdkCarrier,
  ], consumer);
  const binary = join(consumer, 'node_modules', '@forgeax', 'game', 'dist', 'main.js');
  if (!existsSync(binary)) throw new Error('packed @forgeax/game executable was not installed');
  const carrierManifest = JSON.parse(readFileSync(join(consumer, 'node_modules', '@forgeax', 'engine-sdk', 'sdk', 'sdk-manifest.json'), 'utf8'));
  if (carrierManifest.engineCommit !== EXPECTED_ENGINE || carrierManifest.sdkVersion !== EXPECTED_VERSION) {
    throw new Error('installed npm carrier identity mismatch');
  }

  const child = spawn(node, [binary, 'mcp'], { cwd: game, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  try {
    const issuedPreviewTokens: string[] = [];
    await mcpRequest(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const status = resultText(await mcpRequest(child, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'forgeax_status_lite', arguments: { target_dir: game } },
    }));
    if (!status.includes(EXPECTED_ENGINE) || !status.includes(EXPECTED_VERSION)) {
      throw new Error(`status omitted exact Engine identity:\n${status}`);
    }

    const first = resultText(await mcpRequest(child, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: game } },
    }));
    const firstState = stateFromRun(first);
    issuedPreviewTokens.push(firstState.value.instanceToken);
    lastPreviewPid = firstState.value.pid;
    const healthUrl = new URL('/.forgeax/preview-health', firstState.value.selectedUrl);
    const unauthenticated = await fetch(healthUrl);
    if (unauthenticated.status !== 401) throw new Error(`unauthenticated health returned ${unauthenticated.status}`);
    const health = await fetch(healthUrl, { headers: { authorization: `Bearer ${firstState.value.instanceToken}` } }).then((response) => response.json()) as any;
    if (
      realpathSync(health.root) !== realpathSync(game) || health.engineCommit !== EXPECTED_ENGINE || health.engineVersion !== EXPECTED_VERSION ||
      health.buildDigest !== firstState.value.buildDigest || health.previewInstanceId !== firstState.value.previewInstanceId
    ) throw new Error(`authenticated health identity mismatch: ${JSON.stringify(health)}`);

    const second = resultText(await mcpRequest(child, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: game } },
    }));
    const secondState = stateFromRun(second);
    if (!second.includes('preview.reused: true') || secondState.value.pid !== firstState.value.pid) {
      throw new Error(`Preview was not reused:\n${second}`);
    }

    const stopEnvelope = JSON.parse(run(node, [binary, 'preview', 'stop', '--target-dir', game, '--json'], game).trim());
    if (!stopEnvelope.ok || stopEnvelope.value?.stopped !== true) throw new Error(`explicit stop failed: ${JSON.stringify(stopEnvelope)}`);
    await waitDead(firstState.value.pid);
    if (existsSync(firstState.path)) throw new Error('state survived explicit stop');

    const restarted = resultText(await mcpRequest(child, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: game } },
    }));
    const crashed = stateFromRun(restarted);
    issuedPreviewTokens.push(crashed.value.instanceToken);
    process.kill(crashed.value.pid, 'SIGKILL');
    await waitDead(crashed.value.pid);
    const recovered = resultText(await mcpRequest(child, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'forgeax_run_current_game', arguments: { target_dir: game } },
    }));
    const recoveredState = stateFromRun(recovered);
    issuedPreviewTokens.push(recoveredState.value.instanceToken);
    lastPreviewPid = recoveredState.value.pid;
    if (recoveredState.value.pid === crashed.value.pid || !recovered.includes('preview.reused: false')) {
      throw new Error(`crash recovery did not create a fresh owned Preview:\n${recovered}`);
    }

    const finalStopEnvelope = JSON.parse(run(node, [binary, 'preview', 'stop', '--target-dir', game, '--json'], game).trim());
    if (!finalStopEnvelope.ok || finalStopEnvelope.value?.stopped !== true) {
      throw new Error(`final explicit stop failed: ${JSON.stringify(finalStopEnvelope)}`);
    }
    await waitDead(recoveredState.value.pid);
    if (existsSync(recoveredState.path)) throw new Error('state survived final explicit stop');
    lastPreviewPid = undefined;

    const stdoutLog = join(dirname(recoveredState.path), 'stdout.log');
    const stdoutText = readFileSync(stdoutLog, 'utf8');
    const stderrText = readFileSync(join(dirname(recoveredState.path), 'stderr.log'), 'utf8');
    if (issuedPreviewTokens.some((token) => stdoutText.includes(token) || stderrText.includes(token))) {
      throw new Error('Preview instance token leaked into owning logs');
    }
    const stdoutFrames = stdoutText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`cumulative stdout log frame ${index + 1} is not standalone JSON`);
        }
      });
    if (
      stdoutFrames.length < 7 ||
      stdoutFrames.some((frame) => frame.schemaVersion !== '1.0.0' || !['build', 'preview'].includes(frame.command)) ||
      !stdoutFrames.some((frame) => frame.command === 'build' && frame.ok === true) ||
      !stdoutFrames.some((frame) => frame.command === 'preview' && frame.ok === true)
    ) throw new Error(`cumulative stdout log contract mismatch: ${JSON.stringify(stdoutFrames)}`);

    child.stdin?.end();
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('MCP graceful shutdown timed out')), 12_000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
    console.log(`PASS_SUPPORTING packed consumer: ${game}`);
    console.log(`engine.commit: ${EXPECTED_ENGINE}`);
    console.log(`engine.version: ${EXPECTED_VERSION}`);
    console.log(`preview.health: authenticated`);
    console.log(`preview.lifecycle: start,reuse,stop,crash,recover,final-stop,graceful-shutdown`);
    console.log(`preview.stdout_frames: ${stdoutFrames.length}`);
    console.log(`preview.logs: token-redacted`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
} finally {
  if (alive(lastPreviewPid)) {
    try { process.kill(lastPreviewPid!, 'SIGTERM'); } catch { /* owning test child already exited */ }
  }
  if (process.env.KEEP_ACCEPTANCE !== '1') rmSync(fixture, { recursive: true, force: true });
  else console.log(`kept fixture: ${fixture}`);
}
