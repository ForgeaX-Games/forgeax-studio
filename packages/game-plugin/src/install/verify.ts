/**
 * Verify the exact command that will be written into an MCP client config.
 *
 * A successful spawn is not enough: a process can stay alive while exposing the
 * wrong protocol or no ForgeaX surface at all. The installer therefore performs the
 * same initialize -> tools/list -> resources/list handshake a client performs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LaunchSpec } from './clients';
import { RELEASE_IDENTITY_MIME, RELEASE_IDENTITY_URI, type ReleaseIdentity } from './release-manifest';

const REQUIRED_TOOLS = ['forgeax_status_lite', 'forgeax_run_current_game'] as const;
const REQUIRED_RESOURCES = ['forgeax://status'] as const;
/** Install may cold-start an npx launcher and resolve a fresh dependency graph. */
export const INSTALL_VERIFY_TIMEOUT_MS = 120_000;

export interface VerifyResult {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly string[];
  readonly resources: readonly string[];
}

export interface InstallVerification extends VerifyResult {
  readonly releaseIdentity: ReleaseIdentity;
  readonly releaseIdentityMimeType: string;
  readonly handshake: readonly string[];
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
  return verifyLaunchInternal(launch, timeoutMs, false);
}

/**
 * Install's stronger preflight.  It performs the exact unbound sequence
 * initialize -> tools/list -> resources/list -> resources/read and returns the
 * immutable release identity that was read from the launcher.  No caller can move
 * into the config transaction until this function has completed successfully.
 */
export async function verifyLaunchForInstall(
  launch: LaunchSpec,
  timeoutMs = 30_000,
): Promise<InstallVerification> {
  return verifyLaunchInternal(launch, timeoutMs, true) as Promise<InstallVerification>;
}

async function verifyLaunchInternal(
  launch: LaunchSpec,
  timeoutMs: number,
  requireReleaseIdentity: boolean,
): Promise<VerifyResult | InstallVerification> {
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

  const checked = (async (): Promise<VerifyResult | InstallVerification> => {
    const handshake: string[] = [];
    const initialized = await rpcRequest(child, pending, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'forgeax-game-installer', version: '1' },
    });
    handshake.push('initialize');
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
    handshake.push('tools/list');
    if (toolsResponse.error) {
      throw new Error(`tools/list failed: ${toolsResponse.error.message ?? toolsResponse.error.code}`);
    }
    const tools = namesFrom(toolsResponse.result, 'tools');
    const missingTools = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missingTools.length) throw new Error(`MCP server is missing tools: ${missingTools.join(', ')}`);

    const resourcesResponse = await rpcRequest(child, pending, 3, 'resources/list');
    handshake.push('resources/list');
    if (resourcesResponse.error) {
      throw new Error(`resources/list failed: ${resourcesResponse.error.message ?? resourcesResponse.error.code}`);
    }
    const resources = namesFrom(resourcesResponse.result, 'resources');
    const missingResources = REQUIRED_RESOURCES.filter((uri) => !resources.includes(uri));
    if (missingResources.length) {
      throw new Error(`MCP server is missing resources: ${missingResources.join(', ')}`);
    }

    const base: VerifyResult = {
      serverName: String(info.name),
      serverVersion: typeof info.version === 'string' ? info.version : 'unknown',
      tools,
      resources,
    };
    if (!requireReleaseIdentity) return base;

    if (!resources.includes(RELEASE_IDENTITY_URI)) {
      throw new Error(`MCP server is missing resource: ${RELEASE_IDENTITY_URI}`);
    }
    const identityResponse = await rpcRequest(child, pending, 4, 'resources/read', {
      uri: RELEASE_IDENTITY_URI,
    });
    handshake.push('resources/read');
    if (identityResponse.error) {
      throw new Error(
        `resources/read failed: ${identityResponse.error.message ?? identityResponse.error.code}`,
      );
    }
    const contents = identityResponse.result?.contents;
    if (!Array.isArray(contents) || contents.length !== 1) {
      throw new Error('release identity resource returned an unexpected content list');
    }
    const content = contents[0];
    if (typeof content !== 'object' || content === null) {
      throw new Error('release identity resource returned a non-object content');
    }
    const record = content as Record<string, unknown>;
    if (record.uri !== RELEASE_IDENTITY_URI || record.mimeType !== RELEASE_IDENTITY_MIME) {
      throw new Error('release identity resource URI or media type mismatched');
    }
    if (typeof record.text !== 'string') throw new Error('release identity resource did not return JSON text');
    let identity: unknown;
    try {
      identity = JSON.parse(record.text);
    } catch {
      throw new Error('release identity resource returned invalid JSON');
    }
    return {
      ...base,
      releaseIdentity: identity as ReleaseIdentity,
      releaseIdentityMimeType: String(record.mimeType),
      handshake,
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
