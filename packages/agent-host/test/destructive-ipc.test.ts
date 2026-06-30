/**
 * 暴力破坏性 —— IPC 层(帧解析 + RpcConnection)。
 *
 * 目标:控制面是 sidecar 的命门;喂垃圾/半包/洪流/中途断连都不能让它崩或挂。
 * 纯 in-process(真 unix socket 对),快、确定。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { rmSync } from 'node:fs';
import { connect, createFrameParser, encodeFrame, RpcConnection } from '../src/ipc';

type AnyMsg = Record<string, unknown>;

describe('frame parser — fuzz/abuse', () => {
  test('丢弃畸形帧,保留同批有效帧', () => {
    const parse = createFrameParser();
    const out = parse(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'a' }) +
        'not json\n' +
        '{bad json\n' +
        '[]\n' + // valid JSON but not an object — still parsed (parser doesn't validate shape)
        encodeFrame({ jsonrpc: '2.0', id: 2, method: 'b' }),
    ) as unknown as AnyMsg[];
    const ids = out.filter((m) => 'id' in m).map((m) => m.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  test('逐字节切分:仅在换行处吐一条完整消息', () => {
    const parse = createFrameParser();
    const frame = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'x' });
    let msgs: AnyMsg[] = [];
    for (const ch of frame) msgs = msgs.concat(parse(ch) as unknown as AnyMsg[]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(7);
  });

  test('单 chunk 内 10 万帧全部解析,无栈溢出', () => {
    const parse = createFrameParser();
    const N = 100_000;
    let blob = '';
    for (let i = 0; i < N; i++) blob += `{"jsonrpc":"2.0","id":${i},"method":"m"}\n`;
    const out = parse(blob);
    expect(out).toHaveLength(N);
  });

  test('payload 内含转义换行不被误切帧', () => {
    const parse = createFrameParser();
    const f = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'm', params: { text: 'a\nb\nc' } });
    const out = parse(f) as unknown as AnyMsg[];
    expect(out).toHaveLength(1);
    expect((out[0].params as { text: string }).text).toBe('a\nb\nc');
  });

  test('二进制垃圾与有效帧混合 → 垃圾丢、有效留', () => {
    const parse = createFrameParser();
    const out = parse(
      Buffer.concat([
        Buffer.from([0, 1, 2, 255, 254, 0]),
        Buffer.from('\n'),
        Buffer.from(encodeFrame({ jsonrpc: '2.0', id: 9, method: 'ok' })),
      ]),
    ) as unknown as AnyMsg[];
    expect(out.map((m) => m.id)).toEqual([9]);
  });

  test('空行/纯空白行忽略', () => {
    const parse = createFrameParser();
    const out = parse('\n   \n\t\n' + encodeFrame({ jsonrpc: '2.0', id: 3, method: 'm' }));
    expect(out).toHaveLength(1);
  });

  test('5MB 单帧解析不崩', () => {
    const parse = createFrameParser();
    const big = 'x'.repeat(5_000_000);
    const out = parse(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'm', params: { big } })) as unknown as AnyMsg[];
    expect(out).toHaveLength(1);
    expect(((out[0].params as { big: string }).big).length).toBe(5_000_000);
  });
});

describe('RpcConnection — abuse', () => {
  let server: Server;
  let sock: string;
  const clients: RpcConnection[] = [];
  const serverSocks = new Set<Socket>();

  beforeEach(async () => {
    sock = `/tmp/fxah-ipc-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
    await new Promise<void>((res) => {
      server = createServer((s) => {
        serverSocks.add(s);
        s.on('close', () => serverSocks.delete(s));
        const conn = new RpcConnection(s);
        conn.setRequestHandler((method, params) => {
          if (method === 'echo') return params;
          if (method === 'boom') throw Object.assign(new Error('kaboom'), { code: -32050 });
          if (method === 'slow') return new Promise((r) => setTimeout(() => r('ok'), 300));
          throw Object.assign(new Error(`unknown:${method}`), { code: -32601 });
        });
      });
      server.listen(sock, () => res());
    });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of serverSocks) { try { s.destroy(); } catch { /* ignore */ } }
    serverSocks.clear();
    await new Promise<void>((r) => server.close(() => r()));
    try { rmSync(sock, { force: true }); } catch { /* ignore */ }
  });

  const mk = async (): Promise<RpcConnection> => {
    const c = await connect(sock, 2000);
    clients.push(c);
    return c;
  };

  test('1000 并发请求 id 关联全部正确', async () => {
    const c = await mk();
    const results = (await Promise.all(
      Array.from({ length: 1000 }, (_, i) => c.request('echo', { i })),
    )) as Array<{ i: number }>;
    expect(results.map((r) => r.i)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  test('handler 抛错 → 带 code 的 error 回传', async () => {
    const c = await mk();
    let code: unknown;
    await c.request('boom').catch((e: { code?: number }) => { code = e.code; });
    expect(code).toBe(-32050);
  });

  test('未知方法 → -32601', async () => {
    const c = await mk();
    let code: unknown;
    await c.request('nope').catch((e: { code?: number }) => { code = e.code; });
    expect(code).toBe(-32601);
  });

  test('请求在途时对端 reset → pending 立即 reject(不挂死)', async () => {
    const c = await mk();
    const p = c.request('slow');
    setTimeout(() => { for (const s of serverSocks) s.destroy(); }, 30);
    await expect(p).rejects.toThrow(/connection closed|closed/);
  });

  test('close() 后再 request → 立即 reject(不挂死)', async () => {
    const c = await mk();
    c.close();
    await expect(c.request('echo', {})).rejects.toThrow(/closed/);
  });

  test('close() 幂等 + 在途请求被拒', async () => {
    const c = await mk();
    const p = c.request('slow');
    c.close();
    c.close(); // 幂等,不抛
    await expect(p).rejects.toThrow(/closed/);
  });

  test('对端发来畸形/二进制噪声后,正常请求仍可用', async () => {
    const c = await mk();
    // 直接往服务端连接灌噪声(模拟坏 client),不应毒化解析器
    for (const s of serverSocks) s.write(Buffer.from([0, 255, 10, 123, 10]));
    const r = (await c.request('echo', { ok: 1 })) as { ok: number };
    expect(r.ok).toBe(1);
  });
});
