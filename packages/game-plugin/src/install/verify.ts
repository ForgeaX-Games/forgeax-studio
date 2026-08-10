/**
 * Verify the exact command that will be written into an MCP client config.
 *
 * A successful spawn is not enough: a process can stay alive while exposing the
 * wrong protocol or no ForgeaX surface at all. The installer therefore performs the
 * same initialize -> tools/list -> resources/list handshake a client performs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LaunchSpec } from './clients';

const REQUIRED_TOOLS = ['forgeax_status_lite', 'forgeax_run_current_game'] as const;
const REQUIRED_RESOURCES = ['forgeax://status'] as const;

export interface VerifyResult {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly string[];
  readonly resources: readonly string[];
}

interface RpcResponse {
  readonly id?: string | number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

function commandText(launch: LaunchSpec): string {
  return [launch.command, ...launch.args].map((part) => JSON.stringify(part)).join(' ');
}

function rpcRequest(
  child: ChildProcessWithoutNullStreams,
  pending: Map<number, (response: RpcResponse) => void>,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
}

function namesFrom(result: Record<string, unknown> | undefined, key: string): string[] {
  const entries = result?.[key];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const value = key === 'resources' ? record.uri : record.name;
    return typeof value === 'string' ? [value] : [];
  });
}

/**
 * Spawn and handshake with an MCP server command.
 *
 * The child is always terminated after verification. `timeoutMs` covers the entire
 * handshake, including package resolution when the launch command uses npx.
 */
export async function verifyLaunch(launch: LaunchSpec, timeoutMs = 30_000): Promise<VerifyResult> {
  const child = spawn(launch.command, [...launch.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const pending = new Map<number, (response: RpcResponse) => void>();
  let stdout = '';
  let stderr = '';
  let settled = false;

  const failOnExit = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(new Error(`could not launch ${commandText(launch)}: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = stderr.trim();
      reject(
        new Error(
          `MCP server exited before handshake completed (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    let newline: number;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== 'number') continue;
      const resolve = pending.get(response.id);
      if (!resolve) continue;
      pending.delete(response.id);
      resolve(response);
    }
  });

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP handshake timed out after ${timeoutMs}ms for ${commandText(launch)}`));
    }, timeoutMs);
    timer.unref?.();
  });

  const checked = (async (): Promise<VerifyResult> => {
    const initialized = await rpcRequest(child, pending, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'forgeax-game-installer', version: '1' },
    });
    if (initialized.error) throw new Error(`initialize failed: ${initialized.error.message ?? initialized.error.code}`);

    const serverInfo = initialized.result?.serverInfo;
    if (typeof serverInfo !== 'object' || serverInfo === null) {
      throw new Error('initialize response did not include serverInfo');
    }
    const info = serverInfo as Record<string, unknown>;
    if (info.name !== 'forgeax') {
      throw new Error(`initialize returned unexpected server ${JSON.stringify(info.name)}`);
    }

    const toolsResponse = await rpcRequest(child, pending, 2, 'tools/list');
    if (toolsResponse.error) {
      throw new Error(`tools/list failed: ${toolsResponse.error.message ?? toolsResponse.error.code}`);
    }
    const tools = namesFrom(toolsResponse.result, 'tools');
    const missingTools = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missingTools.length) throw new Error(`MCP server is missing tools: ${missingTools.join(', ')}`);

    const resourcesResponse = await rpcRequest(child, pending, 3, 'resources/list');
    if (resourcesResponse.error) {
      throw new Error(`resources/list failed: ${resourcesResponse.error.message ?? resourcesResponse.error.code}`);
    }
    const resources = namesFrom(resourcesResponse.result, 'resources');
    const missingResources = REQUIRED_RESOURCES.filter((uri) => !resources.includes(uri));
    if (missingResources.length) {
      throw new Error(`MCP server is missing resources: ${missingResources.join(', ')}`);
    }

    return {
      serverName: String(info.name),
      serverVersion: typeof info.version === 'string' ? info.version : 'unknown',
      tools,
      resources,
    };
  })();

  try {
    const result = await Promise.race([checked, failOnExit, timeout]);
    settled = true;
    return result;
  } finally {
    settled = true;
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
