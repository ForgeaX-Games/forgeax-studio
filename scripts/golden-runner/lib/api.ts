/** Thin HTTP and audit-file access used by golden cases. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FetchLike } from './sse.ts';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export interface ToolDescriptor {
  id: string;
  exposedToAI: boolean;
  hasHandler?: boolean;
  [key: string]: unknown;
}

export interface ToolsEnvelope {
  tools: ToolDescriptor[];
}

export interface ToolCallBody {
  toolId: string;
  args: unknown;
  caller: {
    kind: 'user' | 'ai' | 'skill' | 'workbench' | 'cli';
    sessionId?: string;
    threadId?: string;
  };
}

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface CreateSessionBody {
  displayName?: string;
  autoStart?: boolean;
  bootstrapAgent?: string | false | null;
  [key: string]: unknown;
}

export interface CreateSessionResult {
  sid?: string;
  bootstrappedAgent?: string | null;
  [key: string]: unknown;
}

export interface KernelToolCallBody {
  toolName: string;
  args?: Record<string, unknown>;
  agentPath?: string;
}

export interface KernelToolCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export type CommandExecutionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface CommandExecutionEnvelope<T = unknown> {
  result: CommandExecutionResult<T>;
}

export interface ExecuteCommandOptions {
  sessionId?: string;
  requestingAgentId?: string;
}

export interface SetAgentModelsResult {
  sid: string;
  agentPath: string;
  models: { model: string[] };
  selected: string;
  restarted: boolean;
  agentJsonFile: string;
}

export interface KernelToolAuditEntry {
  sid: string;
  agent: string;
  tool: string;
  trustTier: string;
  allow: boolean;
  ok?: boolean;
  error?: string;
  durationMs: number;
  ts: number;
  [key: string]: unknown;
}

export interface KernelToolAuditProbe {
  path: string | null;
  entries: KernelToolAuditEntry[];
  probed: string[];
}

export class GoldenApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoldenApiError';
  }
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function safeSegment(value: string, label: string): string {
  if (
    !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new GoldenApiError(`${label} must be one safe path segment`);
  }
  return value;
}

export class GoldenApi {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly onSessionCreated?: (sid: string) => void | Promise<void>;

  constructor(
    baseUrl: string,
    fetchImpl: FetchLike = fetch,
    onSessionCreated?: (sid: string) => void | Promise<void>,
  ) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.onSessionCreated = onSessionCreated;
  }

  getTools(): Promise<ApiResponse<ToolsEnvelope>> {
    return this.requestJson<ToolsEnvelope>('/api/tools');
  }

  callTool(body: ToolCallBody): Promise<ApiResponse<ToolCallResult>> {
    return this.requestJson<ToolCallResult>('/api/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async createSession(body: CreateSessionBody = {}): Promise<ApiResponse<CreateSessionResult>> {
    const response = await this.requestJson<CreateSessionResult>('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok && typeof response.body?.sid === 'string' && response.body.sid) {
      await this.onSessionCreated?.(response.body.sid);
    }
    return response;
  }

  callKernelTool<T = unknown>(
    sid: string,
    body: KernelToolCallBody,
  ): Promise<ApiResponse<KernelToolCallResult<T>>> {
    return this.requestJson<KernelToolCallResult<T>>(
      `/api/sessions/${encodeURIComponent(safeSegment(sid, 'sid'))}/kernel-tool`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  executeCommand<T = unknown>(
    name: string,
    args: readonly string[],
    options: ExecuteCommandOptions = {},
  ): Promise<ApiResponse<CommandExecutionEnvelope<T>>> {
    return this.requestJson<CommandExecutionEnvelope<T>>(
      `/api/commands/${encodeURIComponent(safeSegment(name, 'command name'))}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args, ...options }),
      },
    );
  }

  setAgentModels(
    sid: string,
    agentPath: string,
    models: readonly string[],
  ): Promise<ApiResponse<CommandExecutionEnvelope<SetAgentModelsResult>>> {
    if (!models.length || models.some((model) => !model.trim())) {
      throw new GoldenApiError('setAgentModels requires at least one non-empty model');
    }
    return this.executeCommand<SetAgentModelsResult>(
      'set_agent_models',
      [sid, agentPath, ...models],
      { sessionId: sid, requestingAgentId: agentPath },
    );
  }

  deleteSession(sid: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/sessions/${encodeURIComponent(safeSegment(sid, 'sid'))}`,
      { method: 'DELETE' },
    );
  }

  /** Product-level deletion also clears active-game.json when it owns slug. */
  deleteGame(slug: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/workbench/games/${encodeURIComponent(safeSegment(slug, 'slug'))}`,
      { method: 'DELETE' },
    );
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new GoldenApiError(
        `request failed: ${init?.method ?? 'GET'} ${path}: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new GoldenApiError(
          `invalid JSON from ${init?.method ?? 'GET'} ${path} (HTTP ${response.status})`,
          { cause: error },
        );
      }
    }
    return { status: response.status, ok: response.ok, body: body as T };
  }
}

/**
 * Probe the hinted game first, then discover the session's actual game binding
 * by sid, then try the project-local legacy flat path. The runner slug is an
 * ownership nonce and need not equal the active game that owns the session.
 * Missing files are a valid empty result; multiple matches are ambiguous and
 * fail rather than silently reading the wrong session copy.
 */
export async function readKernelToolAudit(
  projectRoot: string,
  slug: string,
  sid: string,
): Promise<KernelToolAuditProbe> {
  safeSegment(slug, 'slug');
  safeSegment(sid, 'sid');
  const gamesRoot = resolve(projectRoot, '.forgeax', 'games');
  const hinted = resolve(gamesRoot, slug, 'sessions', sid, 'kernel-tool-audit.jsonl');
  const discovered: string[] = [];
  try {
    const games = await readdir(gamesRoot, { withFileTypes: true });
    for (const game of games.sort((left, right) => left.name.localeCompare(right.name))) {
      if (game.name === slug) continue;
      let isDirectory = game.isDirectory();
      if (!isDirectory && game.isSymbolicLink()) {
        try {
          isDirectory = (await stat(resolve(gamesRoot, game.name))).isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new GoldenApiError(`failed to inspect game binding: ${game.name}`, { cause: error });
          }
        }
      }
      if (!isDirectory) continue;
      discovered.push(resolve(gamesRoot, game.name, 'sessions', sid, 'kernel-tool-audit.jsonl'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GoldenApiError(`failed to enumerate game-bound sessions: ${gamesRoot}`, { cause: error });
    }
  }
  const candidates = [
    hinted,
    ...discovered,
    resolve(projectRoot, '.forgeax', 'sessions', sid, 'kernel-tool-audit.jsonl'),
  ];

  const matches: Array<{ path: string; entries: KernelToolAuditEntry[] }> = [];
  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new GoldenApiError(`failed to read kernel tool audit: ${path}`, { cause: error });
    }

    const entries: KernelToolAuditEntry[] = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as KernelToolAuditEntry);
      } catch (error) {
        throw new GoldenApiError(
          `invalid JSONL in ${path} at line ${index + 1}`,
          { cause: error },
        );
      }
    }
    matches.push({ path, entries });
  }

  if (matches.length > 1) {
    throw new GoldenApiError(
      `multiple kernel tool audit files found for sid ${sid}: ${matches.map((match) => match.path).join(', ')}`,
    );
  }
  if (matches.length === 1) {
    return { path: matches[0].path, entries: matches[0].entries, probed: candidates };
  }
  return { path: null, entries: [], probed: candidates };
}
