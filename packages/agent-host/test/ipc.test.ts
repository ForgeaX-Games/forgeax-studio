/** ipc 单测:JSON-RPC 帧编解码 + 半包/粘包。 */
import { describe, expect, test } from 'bun:test';
import { createFrameParser, encodeFrame } from '../src/ipc';

describe('ipc framing', () => {
  test('encodeFrame 末尾带 \\n', () => {
    expect(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });

  test('粘包:一次喂多帧 → 全部解出', () => {
    const parse = createFrameParser();
    const a = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const b = encodeFrame({ jsonrpc: '2.0', id: 2, method: 'listSessions' });
    const msgs = parse(a + b);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { id: number }).id).toBe(1);
    expect((msgs[1] as { method: string }).method).toBe('listSessions');
  });

  test('半包:分片到达 → 跨片拼出完整帧', () => {
    const parse = createFrameParser();
    const full = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'ping', params: { x: 1 } });
    const mid = Math.floor(full.length / 2);
    expect(parse(full.slice(0, mid))).toHaveLength(0); // 不完整 → 暂不吐
    const msgs = parse(full.slice(mid));
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { id: number }).id).toBe(7);
  });

  test('坏帧被丢弃,不影响后续好帧', () => {
    const parse = createFrameParser();
    const good = encodeFrame({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const msgs = parse('{bad json\n' + good);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { id: number }).id).toBe(9);
  });
});
