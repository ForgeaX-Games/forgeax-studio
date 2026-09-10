import { describe, expect, it } from 'bun:test';
import { parseFuserListenPids, parseSsListenPids } from './proc.ts';

describe('POSIX listener probe parsers', () => {
  it('parses IPv4 and IPv6 ss listeners and de-duplicates process ids', () => {
    const output = [
      'LISTEN 0 4096 127.0.0.1:38900 0.0.0.0:* users:(("bun",pid=101,fd=7))',
      'LISTEN 0 4096 [::]:38900 [::]:* users:(("bun",pid=101,fd=8),("node",pid=202,fd=9))',
      'LISTEN 0 4096 127.0.0.1:38920 0.0.0.0:* users:(("bun",pid=303,fd=7))',
    ].join('\n');
    expect(parseSsListenPids(output, 38900)).toEqual([101, 202]);
  });

  it('returns an empty set for a reliable ss no-match result', () => {
    expect(parseSsListenPids('LISTEN 0 4096 127.0.0.1:38920 0.0.0.0:*', 38900)).toEqual([]);
  });

  it('fails closed when ss sees a listener but cannot expose its owner', () => {
    expect(parseSsListenPids('LISTEN 0 4096 127.0.0.1:38900 0.0.0.0:*', 38900)).toBeNull();
  });

  it('parses fuser output without treating the port number as a pid', () => {
    expect(parseFuserListenPids('38900/tcp: 101 202\n', 38900)).toEqual([101, 202]);
    expect(parseFuserListenPids('38920/tcp: 303\n', 38900)).toEqual([]);
  });

  it('fails closed when fuser reports a socket without pids', () => {
    expect(parseFuserListenPids('38900/tcp:\n', 38900)).toBeNull();
  });
});
