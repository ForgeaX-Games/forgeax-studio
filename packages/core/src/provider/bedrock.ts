/**
 * AWS Bedrock (Anthropic) provider (C4) — backend `bedrock-anthropic`.
 *
 * 两正交轴里只换 backend:
 *   - URL:`{baseUrl}/model/{modelId}/invoke-with-response-stream`
 *     (baseUrl 默认 `https://bedrock-runtime.{region}.amazonaws.com`)
 *   - body:复用 `buildRequestBody`,删 `model`(在 URL)、删 `stream`、加
 *     `anthropic_version: "bedrock-2023-05-31"`
 *   - auth:AWS SigV4(零依赖,node:crypto 手写),opts.apiKey = `AK:SK` 或 `AK:SK:TOKEN`
 *   - 响应:AWS event-stream **二进制帧**(非 SSE)→ 自带 decoder 提取每帧里的 anthropic
 *     事件 JSON,转成 `{event,data}` 喂回复用的 `normalizeAnthropicStream`。
 *
 * 无 AWS 凭据 → 不做 live e2e;SigV4 规范化 + 帧 decoder 以单测覆盖(设计稿 §11)。
 * Boundary: 仅 import core-local + node:crypto(node: 前缀在 lint ALLOW)。
 */
import { createHash, createHmac } from 'node:crypto';
import type {
  LLMProvider,
  ProviderCallOpts,
  ProviderFactory,
  ProviderFactoryOpts,
  ProviderRequest,
  ProviderStreamEvent,
} from './types';
import { buildRequestBody, normalizeAnthropicStream } from './anthropic';

const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const SERVICE = 'bedrock';

export function buildBedrockBody(req: ProviderRequest): Record<string, unknown> {
  const body = buildRequestBody(req);
  delete body.model;
  delete body.stream;
  body.anthropic_version = BEDROCK_ANTHROPIC_VERSION;
  return body;
}

export function buildBedrockUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/model/${encodeURIComponent(model)}/invoke-with-response-stream`;
}

// ─── SigV4(导出供单测)────────────────────────────────────────────────────────

export interface SigV4Input {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** 注入时间戳(测试确定性);缺省取 new Date()。 */
  amzDate?: string; // YYYYMMDDTHHMMSSZ
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 计算 SigV4 的 Authorization + 必需头(返回应附加到请求的 header 集)。 */
export function signV4(input: SigV4Input): Record<string, string> {
  const service = input.service ?? SERVICE;
  const amzDate = input.amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const u = new URL(input.url);

  const baseHeaders: Record<string, string> = {
    host: u.host,
    'x-amz-date': amzDate,
    ...input.headers,
  };
  if (input.sessionToken) baseHeaders['x-amz-security-token'] = input.sessionToken;

  // canonical headers:按小写名排序
  const names = Object.keys(baseHeaders).map((h) => h.toLowerCase());
  names.sort();
  const lowerMap = new Map(Object.entries(baseHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lowerMap.get(n)).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const payloadHash = sha256Hex(input.body);
  const canonicalRequest = [
    input.method.toUpperCase(),
    u.pathname,
    u.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = { ...input.headers, host: u.host, 'x-amz-date': amzDate, authorization };
  if (input.sessionToken) out['x-amz-security-token'] = input.sessionToken;
  return out;
}

// ─── AWS event-stream 帧 decoder(导出供单测)─────────────────────────────────

/** 解析 event-stream 头区:返回 name→string-value(只取 string 类型 7)。 */
function parseEventStreamHeaders(buf: Uint8Array): Record<string, string> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headers: Record<string, string> = {};
  let off = 0;
  const td = new TextDecoder();
  while (off < buf.byteLength) {
    const nameLen = view.getUint8(off);
    off += 1;
    const name = td.decode(buf.subarray(off, off + nameLen));
    off += nameLen;
    const valueType = view.getUint8(off);
    off += 1;
    if (valueType === 7) {
      const valLen = view.getUint16(off);
      off += 2;
      headers[name] = td.decode(buf.subarray(off, off + valLen));
      off += valLen;
    } else {
      break; // 只关心 string 头(:event-type / :message-type),其余略
    }
  }
  return headers;
}

/**
 * 把 Bedrock event-stream 二进制流转成 `{event,data}`(对齐 parseSSE 产物),供
 * normalizeAnthropicStream 消费。每个 "chunk" 帧 payload = `{"bytes": base64(anthropic 事件 JSON)}`。
 */
export async function* decodeBedrockEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const td = new TextDecoder();
  const append = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf = append(buf, value);
      while (buf.byteLength >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const totalLen = view.getUint32(0);
        if (buf.byteLength < totalLen) break; // 帧未收全
        const headersLen = view.getUint32(4);
        const headerBytes = buf.subarray(12, 12 + headersLen);
        const payloadBytes = buf.subarray(12 + headersLen, totalLen - 4);
        buf = buf.subarray(totalLen);

        const h = parseEventStreamHeaders(headerBytes);
        const eventType = h[':event-type'];
        const messageType = h[':message-type'];
        if (messageType === 'exception' || h[':exception-type']) {
          throw new Error(`bedrock event-stream exception: ${td.decode(payloadBytes).slice(0, 300)}`);
        }
        if (eventType === 'chunk') {
          try {
            const wrapper = JSON.parse(td.decode(payloadBytes)) as { bytes?: string };
            if (wrapper.bytes) {
              const inner = Buffer.from(wrapper.bytes, 'base64').toString('utf8');
              const parsed = JSON.parse(inner) as { type?: string };
              yield { event: parsed.type, data: inner };
            }
          } catch {
            // 跳过坏帧
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── provider 工厂 ────────────────────────────────────────────────────────────

function parseCreds(apiKey: string): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  const parts = apiKey.split(':');
  if (parts.length < 2) {
    throw new Error('bedrock-anthropic: apiKey must be "ACCESS_KEY:SECRET_KEY" or "ACCESS_KEY:SECRET_KEY:SESSION_TOKEN"');
  }
  return { accessKeyId: parts[0], secretAccessKey: parts[1], sessionToken: parts[2] };
}

function regionFromUrl(baseUrl: string): string {
  const m = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/.exec(baseUrl);
  return m?.[1] ?? 'us-east-1';
}

export const createBedrockProvider: ProviderFactory = (opts: ProviderFactoryOpts): LLMProvider => {
  const creds = parseCreds(opts.apiKey);
  const region = regionFromUrl(opts.baseUrl ?? '');
  const baseUrl = opts.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`;
  return {
    api: 'bedrock-anthropic',
    async *stream(req: ProviderRequest, callOpts: ProviderCallOpts): AsyncIterable<ProviderStreamEvent> {
      const url = buildBedrockUrl(baseUrl, req.model);
      const bodyStr = JSON.stringify(buildBedrockBody(req));
      const signed = signV4({
        ...creds,
        region,
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          accept: 'application/vnd.amazon.eventstream',
          ...(opts.headers ?? {}),
        },
        body: bodyStr,
      });
      const res = await fetch(url, { method: 'POST', headers: signed, body: bodyStr, signal: callOpts.signal });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : '';
        throw new Error(`bedrock-anthropic ${res.status}: ${text.slice(0, 500)}`);
      }
      yield* normalizeAnthropicStream(decodeBedrockEventStream(res.body), { signal: callOpts.signal });
    },
  };
};
