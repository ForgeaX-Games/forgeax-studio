/** cred-vault 单测(S2):scoped≠真key + 注入转发 + 预算硬熔断 429 + revoke→401。 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { issueScoped, revokeScoped, closeCredVault } from '../src/cred-vault';

const REAL = 'sk-ant-REAL-vault-secret';
let upstream: Server | null = null;
let savedKey: string | undefined;
let savedBase: string | undefined;

async function startUpstream(usageOut = 0): Promise<{ url: string; gotKey: () => string | undefined; hits: () => number }> {
  let key: string | undefined; let hits = 0;
  upstream = createServer((req, res) => {
    hits++;
    key = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 含 usage 的 SSE 片段,供 cred-vault 累加。
    res.end(`data: {"type":"message_delta","usage":{"output_tokens":${usageOut}}}\n`);
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const addr = upstream!.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, gotKey: () => key, hits: () => hits };
}

afterEach(async () => {
  await closeCredVault();
  if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedBase;
});

function withEnv(up: string) {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = REAL;
  process.env.ANTHROPIC_BASE_URL = up;
}

describe('cred-vault', () => {
  test('issueScoped → scoped(≠真key)+loopback;转发注入真 key', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const issued = await issueScoped('anthropic', 's1');
    expect(issued).not.toBeNull();
    expect(issued!.token).not.toBe(REAL);
    expect(issued!.token.startsWith('fxs-')).toBe(true);
    expect(issued!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${issued!.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': issued!.token }, body: '{}' });
    expect(r.status).toBe(200);
    await r.text();
    expect(up.gotKey()).toBe(REAL); // upstream 收到真 key(vault 注入)
  });

  test('预算硬熔断:usage 累计超 maxTokens → 次请求 429 budget_exceeded', async () => {
    const up = await startUpstream(100); // 每次响应报 100 output tokens
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's2', { maxTokens: 50 }))!;
    // 第一次:未超(0<50)→ 转发,累加 100
    const r1 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r1.status).toBe(200); await r1.text();
    // 第二次:usedTokens=100 ≥ 50 → 429,不转发
    const hitsBefore = up.hits();
    const r2 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r2.status).toBe(429);
    expect((await r2.json() as { error: string }).error).toBe('budget_exceeded');
    expect(up.hits()).toBe(hitsBefore); // 未再转发
  });

  test('USD 硬熔断:usedUsd 累计超 maxBudgetUsd → 次请求 429 budget_exceeded', async () => {
    // 每次响应报 100 万 output tokens。Sonnet-class 默认价 output=$15/1M → 单次 ≈ $15。
    const up = await startUpstream(1_000_000);
    withEnv(up.url);
    // maxBudgetUsd=$1:第一次转发后 usedUsd≈$15 ≥ $1 → 第二次熔断。
    const { token, baseUrl } = (await issueScoped('anthropic', 'usd1', { maxBudgetUsd: 1 }))!;
    const r1 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r1.status).toBe(200); await r1.text();
    const hitsBefore = up.hits();
    const r2 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r2.status).toBe(429);
    expect((await r2.json() as { error: string }).error).toBe('budget_exceeded');
    expect(up.hits()).toBe(hitsBefore); // 未再转发
  });

  test('USD 预算内:小额 usage 不熔断,继续转发', async () => {
    // 每次响应报 1000 output tokens → ≈ 1000 × $15/1M = $0.015,远低于 $5 预算。
    const up = await startUpstream(1000);
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 'usd2', { maxBudgetUsd: 5 }))!;
    const r1 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r1.status).toBe(200); await r1.text();
    // 第二次仍在预算内 → 正常转发(200,upstream 命中数 +1)。
    const hitsBefore = up.hits();
    const r2 = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r2.status).toBe(200); await r2.text();
    expect(up.hits()).toBe(hitsBefore + 1);
  });

  test('revoke 后 → 401', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's3'))!;
    revokeScoped(token);
    const r = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
    expect(r.status).toBe(401);
  });

  test('无 env 真 key → issueScoped 返回 null(用户自管 passthrough)', async () => {
    savedKey = process.env.ANTHROPIC_API_KEY; savedBase = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await issueScoped('anthropic', 's4')).toBeNull();
  });
});
