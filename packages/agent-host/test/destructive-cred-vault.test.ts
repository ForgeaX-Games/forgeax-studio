/**
 * 暴力破坏性 —— 凭据保险箱(cred-vault)。
 *
 * 目标:真 key 永不外泄;非法/吊销 token 拒绝;预算硬熔断;上游故障/畸形流/海量流不崩。
 * 用本地假上游(不碰真 API)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueScoped, revokeScoped, closeCredVault } from '../src/cred-vault';
import { Host } from '../src/host';
import type { StartSessionReq } from '../src/types';

const REAL = 'sk-ant-REAL-DO-NOT-LEAK-xyz';
let upstream: Server | null = null;
let savedKey: string | undefined;
let savedBase: string | undefined;
let dir: string;

interface UpstreamOpts {
  status?: number;
  usageOut?: number;
  delayMs?: number;
  totalBytes?: number;
  raw?: Buffer; // malformed/binary body
}
async function startUpstream(opts: UpstreamOpts = {}): Promise<{ url: string; gotKey: () => string | undefined; hits: () => number }> {
  let key: string | undefined;
  let hits = 0;
  upstream = createServer(async (req, res) => {
    hits++;
    key = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : undefined;
    for await (const _ of req) { /* drain body */ void _; }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    res.writeHead(opts.status ?? 200, { 'content-type': 'text/event-stream' });
    if (opts.raw) { res.end(opts.raw); return; }
    if (opts.totalBytes) {
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      while (sent < opts.totalBytes) { res.write(chunk); sent += chunk.length; }
      res.end(`data: {"usage":{"output_tokens":${opts.usageOut ?? 0}}}\n`);
      return;
    }
    res.end(`data: {"type":"message_delta","usage":{"output_tokens":${opts.usageOut ?? 0}}}\n`);
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const a = upstream!.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { url: `http://127.0.0.1:${port}`, gotKey: () => key, hits: () => hits };
}

function withEnv(up: string): void {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = REAL;
  process.env.ANTHROPIC_BASE_URL = up;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-vault-')); });
afterEach(async () => {
  await closeCredVault();
  if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedBase;
  savedKey = savedBase = undefined;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const hit = (baseUrl: string, token?: string): Promise<Response> =>
  fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: token ? { 'x-api-key': token } : {}, body: '{}' });

describe('cred-vault — attack surface', () => {
  test('非法 token → 401;无 auth 头 → 401', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const { baseUrl } = (await issueScoped('anthropic', 's'))!;
    expect((await hit(baseUrl, 'fxs-bogus')).status).toBe(401);
    expect((await hit(baseUrl)).status).toBe(401);
    expect(up.hits()).toBe(0); // 非法请求绝不转发到上游
  });

  test('预算硬熔断:并发不崩 + 超额后续必 429', async () => {
    const up = await startUpstream({ usageOut: 100 });
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's', { maxTokens: 50 }))!;
    // 10 并发:可能过冲(usage 流式累加),但绝不能抛/崩。
    const codes = await Promise.all(Array.from({ length: 10 }, async () => (await hit(baseUrl, token)).status));
    expect(codes.every((c) => c === 200 || c === 429)).toBe(true);
    // 之后串行一发:usage 早已 ≥50 → 必 429,且不再转发。
    const before = up.hits();
    const r = await hit(baseUrl, token);
    expect(r.status).toBe(429);
    expect((await r.json() as { error: string }).error).toBe('budget_exceeded');
    expect(up.hits()).toBe(before);
  });

  test('in-flight 吊销:revoke 后同 token 立即 401', async () => {
    const up = await startUpstream({ delayMs: 150 });
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's'))!;
    const inflight = hit(baseUrl, token);        // 进行中(entry 已捕获)
    revokeScoped(token);                          // 中途吊销
    expect((await hit(baseUrl, token)).status).toBe(401); // 新请求即拒
    await inflight.then((r) => r.text()).catch(() => {});  // 不崩即可
  });

  test('上游故障 → 502(不崩)', async () => {
    // base 指向一个已关闭端口。
    savedKey = process.env.ANTHROPIC_API_KEY; savedBase = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = REAL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // 拒连
    const { token, baseUrl } = (await issueScoped('anthropic', 's'))!;
    expect((await hit(baseUrl, token)).status).toBe(502);
  });

  test('真 key 永不进子进程 env(经 Host 注入 scoped)', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const out = join(dir, 'env.txt');
    const host = new Host();
    const r: StartSessionReq = {
      sessionId: 'leak', agentId: 'a', trustTier: 'own',
      kernel: {
        kind: 'bc', credential: 'sidecar-managed', cmd: 'bash', cwd: dir,
        args: ['-c', `printenv ANTHROPIC_API_KEY > ${out}; printenv ANTHROPIC_BASE_URL >> ${out}`],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ANTHROPIC_API_KEY: REAL, ANTHROPIC_BASE_URL: up.url },
      },
    };
    const grant = await host.startSession(r);
    expect(grant.scopedToken?.startsWith('fxs-')).toBe(true);
    for (let i = 0; i < 80 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 25));
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines[0]).not.toBe(REAL);          // 子进程拿到的是 scoped,不是真 key
    expect(lines[0].startsWith('fxs-')).toBe(true);
    expect(lines[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/); // loopback vault
    await host.shutdownAll();
  }, 15000);

  test('多 token 互不串扰:吊销其一不影响其余', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const a = (await issueScoped('anthropic', 'sa'))!;
    const b = (await issueScoped('anthropic', 'sb'))!;
    const c = (await issueScoped('anthropic', 'sc'))!;
    revokeScoped(b.token);
    expect((await hit(a.baseUrl, a.token)).status).toBe(200);
    expect((await hit(b.baseUrl, b.token)).status).toBe(401);
    expect((await hit(c.baseUrl, c.token)).status).toBe(200);
  });

  test('畸形/二进制响应体 → 不崩,原样透传', async () => {
    const up = await startUpstream({ raw: Buffer.from([0, 255, 1, 254, 10, 0, 123, 34]) });
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's'))!;
    const r = await hit(baseUrl, token);
    expect(r.status).toBe(200);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0); // usage 正则扫垃圾不崩,字节透传
  });

  test('5MB 流式响应全程透传不截断', async () => {
    const up = await startUpstream({ totalBytes: 5_000_000 });
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's'))!;
    const r = await hit(baseUrl, token);
    expect(r.status).toBe(200);
    const buf = await r.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(5_000_000);
  }, 15000);

  test('closeCredVault 后端口回收,后续请求连不上(不崩)', async () => {
    const up = await startUpstream();
    withEnv(up.url);
    const { token, baseUrl } = (await issueScoped('anthropic', 's'))!;
    await closeCredVault();
    let failed = false;
    await hit(baseUrl, token).catch(() => { failed = true; });
    expect(failed).toBe(true); // 端口已回收 → fetch reject,进程不崩
  });
});
