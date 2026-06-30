/**
 * cred-vault(R3 S2)—— sidecar 侧凭据保险箱:真 upstream key **只在 sidecar 进程**,
 * 给每个 session 发**作用域受限 / 可吊销 / 绑预算**的 scoped token;子进程/内核永不见真 key。
 *
 * 与 server 进程内 cred-proxy(C0-a)的差异:
 *  - 这是 sidecar 侧权威保险箱(真 key 在 sidecar env);C0-a 只是 server 进程内过渡版。
 *  - scoped token 绑 **预算**:proxy 从 SSE usage 累加,超额 → **硬熔断 429 budget_exceeded**(不靠内核自报)。
 *
 * 透明转发:原样转发 path/body + 只换鉴权头;流式 pass-through;真 key 永不出 sidecar。
 * 无 env key(用户自管登录态)→ issueScoped 返回 null,调用方 passthrough(不代理)。
 */
import { createServer as createHttpServer, type IncomingMessage as Req, type ServerResponse as Res } from 'node:http';
import { randomUUID } from 'node:crypto';

export type Provider = 'anthropic' | 'openai';

export interface ScopedBudget {
  maxTokens?: number;
  maxBudgetUsd?: number;
}

interface VaultEntry {
  provider: Provider;
  realKey: string;
  upstream: string;
  budget: ScopedBudget;
  usedTokens: number;
  usedUsd: number;
  sessionId: string;
  /** 模型名:从首个 upstream 请求体的 "model" 字段嗅探(用于 USD 计价)。未知 → 用 provider 默认价。 */
  model?: string;
}

/**
 * 计价表(USD / 1M tokens)。来源:Anthropic/OpenAI 公开价(claude-api skill cached 2026-06-04
 * + prompt-caching 文档)。近似即可——超额硬熔断只需量级正确,不做财务级精确。
 *
 * cache 价基于 input 价推导(Anthropic 计价模型):
 *   cacheWrite(5min TTL) ≈ 1.25 × input;cacheRead ≈ 0.1 × input。
 * 命中规则:provider+model 前缀匹配(见 priceFor);未知 model → provider 默认(*)。
 */
interface ModelPrice { input: number; output: number; cacheWrite: number; cacheRead: number; }
const PRICES: Record<string, ModelPrice> = {
  // Anthropic(per 1M):opus 5/25、sonnet 3/15、haiku 1/5。
  'anthropic:claude-opus':   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'anthropic:claude-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'anthropic:claude-haiku':  { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI gpt-4o(per 1M,近似公开价):input 2.5 / output 10 / cached-input 1.25。无 cacheWrite 概念→沿用 input。
  'openai:gpt-4o':           { input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 1.25 },
  // provider 默认(model 未知/未命中):取该 provider 一个中档默认价。
  'anthropic:*':             { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }, // Claude Sonnet-class 默认
  'openai:*':                { input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 1.25 },
};

/** 按 provider+model 解析单价:精确前缀优先,回退 provider 默认(`*`)。 */
function priceFor(provider: Provider, model?: string): ModelPrice {
  if (model) {
    const m = model.toLowerCase();
    for (const key of Object.keys(PRICES)) {
      if (key.endsWith(':*')) continue;
      const [p, prefix] = key.split(':');
      if (p === provider && m.startsWith(prefix)) return PRICES[key];
    }
  }
  return PRICES[`${provider}:*`];
}

interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; }

/**
 * 从 Anthropic/OpenAI SSE 文本累加各类 token 计数(best-effort)。
 * Anthropic:message_start.usage 给 input/cache_*,message_delta.usage 给累计 output。
 * 逐字段抓取——同名字段(尤其 output_tokens 在 start≈1 与 delta=终值)用「取最大」避免重复累加。
 */
function parseTokenCounts(text: string): TokenCounts {
  const grabMax = (field: string): number => {
    const re = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g');
    let max = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) { const v = Number(m[1]); if (v > max) max = v; }
    return max;
  };
  return {
    input: grabMax('input_tokens') + grabMax('prompt_tokens'),
    output: grabMax('output_tokens') + grabMax('completion_tokens'),
    cacheRead: grabMax('cache_read_input_tokens'),
    cacheWrite: grabMax('cache_creation_input_tokens'),
  };
}

/** token 计数 × 单价 → USD(price 单位为 per-1M)。 */
function costUsd(c: TokenCounts, p: ModelPrice): number {
  return (
    (c.input * p.input) +
    (c.output * p.output) +
    (c.cacheRead * p.cacheRead) +
    (c.cacheWrite * p.cacheWrite)
  ) / 1_000_000;
}

export type CredAuditFn = (rec: {
  event: 'issue' | 'budget_exceeded' | 'revoke';
  sessionId: string;
  provider: Provider;
  usedTokens?: number;
  budget?: ScopedBudget;
  at: number;
}) => void;

const DEBUG = process.env.FORGEAX_CRED_PROXY_DEBUG;
const dbg = (m: string) => { if (DEBUG) { try { process.stderr.write(`[cred-vault] ${m}\n`); } catch { /* ignore */ } } };

const tokens = new Map<string, VaultEntry>();
let server: Server2 | null = null;
let port = 0;
let starting: Promise<void> | null = null;
let auditFn: CredAuditFn | null = null;

type Server2 = ReturnType<typeof createHttpServer>;

export function setCredAudit(fn: CredAuditFn): void { auditFn = fn; }

function defaultUpstream(provider: Provider): string {
  if (provider === 'anthropic') return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
}

function extractNonce(headers: Req['headers']): string | undefined {
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const a = headers['authorization'];
  if (typeof a === 'string') { const m = a.match(/^Bearer\s+(.+)$/i); if (m) return m[1].trim(); }
  return undefined;
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'content-encoding', 'x-api-key', 'authorization', 'keep-alive']);

async function readBody(req: Req): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** 超预算?(usage 累计达上限即熔断) */
function overBudget(e: VaultEntry): boolean {
  if (e.budget.maxTokens != null && e.usedTokens >= e.budget.maxTokens) return true;
  if (e.budget.maxBudgetUsd != null && e.usedUsd >= e.budget.maxBudgetUsd) return true;
  return false;
}

/**
 * 从 Anthropic/OpenAI SSE 文本累加 usage(best-effort)。
 *  - usedTokens:沿用原行为(逐块累加 input_tokens/output_tokens,保 maxTokens 路径不变)。
 *  - usedUsd:按本块解析出的各类 token 数 × provider+model 单价累加(接通 maxBudgetUsd 硬熔断)。
 * Anthropic 不在响应里直报费用,故由 token×price 计算;若 upstream 显式给出费用字段未来可优先读取。
 */
function accrueUsage(e: VaultEntry, text: string): void {
  // 逐行找 "usage":{...} 里的 input_tokens/output_tokens(原始 token 预算口径,保持不变)。
  const re = /"(?:input_tokens|output_tokens)"\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) e.usedTokens += Number(m[1]);

  // USD 口径:用各类 token 数 × 单价累加进 e.usedUsd(供 overBudget 的 maxBudgetUsd 分支熔断)。
  const counts = parseTokenCounts(text);
  if (counts.input || counts.output || counts.cacheRead || counts.cacheWrite) {
    e.usedUsd += costUsd(counts, priceFor(e.provider, e.model));
  }
}

/** 从 upstream 请求体嗅探 model(仅首次,用于计价)。失败静默。 */
function sniffModel(e: VaultEntry, body: Buffer | undefined): void {
  if (e.model || !body || !body.length) return;
  const m = body.toString('utf8').match(/"model"\s*:\s*"([^"]+)"/);
  if (m) e.model = m[1];
}

async function handle(req: Req, res: Res): Promise<void> {
  const nonce = extractNonce(req.headers);
  const entry = nonce ? tokens.get(nonce) : undefined;
  if (!entry) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'cred-vault: invalid or revoked token' }));
    return;
  }
  if (overBudget(entry)) {
    auditFn?.({ event: 'budget_exceeded', sessionId: entry.sessionId, provider: entry.provider, usedTokens: entry.usedTokens, budget: entry.budget, at: Date.now() });
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'budget_exceeded' }));
    dbg(`429 budget_exceeded session=${entry.sessionId} used=${entry.usedTokens}`);
    return;
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  sniffModel(entry, body); // 首个带 body 的请求嗅探 model → 计价精度
  const fwd: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k.toLowerCase())) continue;
    if (typeof v === 'string') fwd[k] = v;
    else if (Array.isArray(v)) fwd[k] = v.join(', ');
  }
  if (entry.provider === 'anthropic') fwd['x-api-key'] = entry.realKey;
  else fwd['authorization'] = `Bearer ${entry.realKey}`;

  dbg(`forward ${req.method} ${req.url} → ${entry.upstream} (scoped→realKey swap, session=${entry.sessionId})`);
  let up: Response;
  try {
    up = await fetch(`${entry.upstream}${req.url ?? '/'}`, { method: req.method, headers: fwd, body: body && body.length ? body : undefined });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `cred-vault upstream error: ${(e as Error).message}` }));
    return;
  }
  const respHeaders: Record<string, string> = {};
  up.headers.forEach((value, key) => { if (!HOP.has(key.toLowerCase())) respHeaders[key] = value; });
  res.writeHead(up.status, respHeaders);
  if (up.body) {
    try {
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
        accrueUsage(entry, Buffer.from(chunk).toString('utf8'));
        res.write(chunk);
      }
    } catch { /* upstream stream ended */ }
  }
  res.end();
}

function ensureStarted(): Promise<void> {
  if (server) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    const s = createHttpServer((req, res) => { void handle(req, res); });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      server = s;
      dbg(`listening on 127.0.0.1:${port}`);
      resolve();
    });
  });
  return starting;
}

/** 发 scoped token + 环回 baseUrl。无 env 真 key → null(用户自管,passthrough)。 */
export async function issueScoped(
  provider: Provider,
  sessionId: string,
  budget: ScopedBudget = {},
): Promise<{ token: string; baseUrl: string } | null> {
  const realKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!realKey || !realKey.trim()) return null;
  await ensureStarted();
  const token = `fxs-${randomUUID()}`;
  tokens.set(token, { provider, realKey: realKey.trim(), upstream: defaultUpstream(provider), budget, usedTokens: 0, usedUsd: 0, sessionId });
  auditFn?.({ event: 'issue', sessionId, provider, budget, at: Date.now() });
  return { token, baseUrl: `http://127.0.0.1:${port}` };
}

export function revokeScoped(token: string): void {
  const e = tokens.get(token);
  if (e) auditFn?.({ event: 'revoke', sessionId: e.sessionId, provider: e.provider, usedTokens: e.usedTokens, at: Date.now() });
  tokens.delete(token);
}

export function closeCredVault(): Promise<void> {
  tokens.clear();
  const s = server; server = null; starting = null; port = 0;
  return new Promise((resolve) => { if (!s) return resolve(); s.close(() => resolve()); });
}
