/** POST /api/cli/chat and collect its SSE (or JSONL-compatible) event stream. */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CliChatBody {
  message: string;
  agentId?: string;
  threadId?: string;
  sessionId?: string;
  providerOverride?: string;
  callId?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface StreamEvent {
  event: string;
  data: unknown;
  raw: string;
}

export interface CliChatResult {
  status: number;
  events: StreamEvent[];
}

export interface PostCliChatOptions {
  baseUrl: string;
  body: CliChatBody;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
}

export class CliChatHttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`POST /api/cli/chat failed with HTTP ${status}: ${detail}`);
    this.name = 'CliChatHttpError';
    this.status = status;
    this.detail = detail;
  }
}

export class CliChatTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`POST /api/cli/chat exceeded total timeout ${timeoutMs}ms`);
    this.name = 'CliChatTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function eventFromJsonLine(raw: string): StreamEvent {
  const parsed = parseJsonOrText(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const event = typeof record.event === 'string'
      ? record.event
      : typeof record.type === 'string'
        ? record.type
        : 'message';
    return {
      event,
      data: Object.hasOwn(record, 'data') ? record.data : parsed,
      raw,
    };
  }
  return { event: 'message', data: parsed, raw };
}

function eventFromSseFrame(frame: string): StreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  let sawSseField = false;
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    const value = colon < 0 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value || 'message';
      sawSseField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawSseField = true;
    } else if (field === 'id' || field === 'retry') {
      sawSseField = true;
    }
  }
  if (!sawSseField || dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  return { event, data: parseJsonOrText(raw), raw };
}

async function emit(
  event: StreamEvent,
  events: StreamEvent[],
  onEvent?: PostCliChatOptions['onEvent'],
): Promise<void> {
  events.push(event);
  await onEvent?.(event);
}

/** Collect a response body while parsing complete SSE frames incrementally. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: PostCliChatOptions['onEvent'],
  signal?: AbortSignal,
): Promise<StreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  let buffer = '';
  let sawSseFrame = false;
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => {}); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = eventFromSseFrame(frame);
        if (parsed) {
          sawSseFrame = true;
          await emit(parsed, events, onEvent);
        } else if (frame.trim()) {
          for (const line of frame.split(/\r?\n/).filter((item) => item.trim())) {
            await emit(eventFromJsonLine(line), events, onEvent);
          }
        }
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const finalSse = eventFromSseFrame(buffer);
    if (finalSse) {
      await emit(finalSse, events, onEvent);
    } else {
      // A JSONL response normally has no blank frame separators, so it reaches
      // this final branch as a set of complete lines.
      for (const line of buffer.split(/\r?\n/).filter((item) => item.trim())) {
        await emit(eventFromJsonLine(line), events, onEvent);
      }
    }
  } else if (!sawSseFrame) {
    // Empty streams are valid transport-wise; the case decides whether the
    // missing terminal event is an assertion failure.
  }

  return events;
}

export async function postCliChat(options: PostCliChatOptions): Promise<CliChatResult> {
  const { body, timeoutMs, onEvent } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CliChatTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const request = (async (): Promise<CliChatResult> => {
      const response = await fetchImpl(`${baseUrl}/api/cli/chat`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream, application/x-ndjson',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => response.statusText || 'empty response');
        throw new CliChatHttpError(response.status, detail);
      }
      const events = await readEventStream(response.body, onEvent);
      return { status: response.status, events };
    })();
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
