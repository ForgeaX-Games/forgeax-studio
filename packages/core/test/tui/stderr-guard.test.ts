/**
 * stderr-guard 单测:挂载期裸 stderr 写被缓冲、不漏到底层;restore 后一次性 flush。
 * 手法:install 前先把 process.stderr.write 换成 recorder,使 guard 捕获到的 original=recorder;
 *   于是「期间 recorder 收到几条」= 漏写量,「restore 后 recorder 收到」= flush 内容。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { installStderrGuard } from '../../src/tui/stderr-guard';

const realWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = realWrite; // 兜底还原,避免污染其它测试
});

describe('stderr-guard', () => {
  test('挂载期裸写被缓冲、不漏到底层;restore 后一次性 flush', () => {
    const seen: string[] = [];
    process.stderr.write = ((c: unknown) => {
      seen.push(String(c));
      return true;
    }) as typeof process.stderr.write;

    const restore = installStderrGuard();
    process.stderr.write('[event-store] append failed\n');
    process.stderr.write('[event-bus] subscriber error\n');
    expect(seen).toEqual([]); // 期间一条都不许漏到底层(TTY)

    restore();
    // 还原 + flush:底层收到合并后的缓冲(顺序保持)。
    expect(seen.join('')).toBe('[event-store] append failed\n[event-bus] subscriber error\n');
  });

  test('write 兼容回调重载:总返回 true 且回调被调用', () => {
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const restore = installStderrGuard();
    try {
      let cb1 = false;
      let cb2 = false;
      const r1 = process.stderr.write('a', () => {
        cb1 = true;
      });
      const r2 = process.stderr.write('b', 'utf8', () => {
        cb2 = true;
      });
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(cb1).toBe(true);
      expect(cb2).toBe(true);
    } finally {
      restore();
    }
  });

  test('Buffer chunk 正确解码进缓冲', () => {
    const seen: string[] = [];
    process.stderr.write = ((c: unknown) => {
      seen.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    const restore = installStderrGuard();
    process.stderr.write(Buffer.from('字节流\n', 'utf8'));
    restore();
    expect(seen.join('')).toBe('字节流\n');
  });
});
