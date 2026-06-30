/** sandbox 单测(S3):imported+darwin → sandbox-exec 包装;own/禁用 → passthrough;外网拦截。 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { maybeSandbox, sandboxAvailable, _resetSandboxCache } from '../src/sandbox';

const isDarwinWithSandbox = process.platform === 'darwin' && sandboxAvailable();

afterEach(() => { delete process.env.FORGEAX_NO_SANDBOX; delete process.env.FORGEAX_SANDBOX; _resetSandboxCache(); });

describe('maybeSandbox', () => {
  test('默认(FORGEAX_SANDBOX 未设)→ passthrough,即便 imported(opt-in,默认关)', () => {
    const r = maybeSandbox('bc', ['-p', 'hi'], { trustTier: 'imported' });
    expect(r.sandboxed).toBe(false);
    expect(r.command).toBe('bc');
  });

  test('FORGEAX_SANDBOX=on 但 own → passthrough(only imported)', () => {
    process.env.FORGEAX_SANDBOX = 'on';
    const r = maybeSandbox('bc', ['-p', 'hi'], { trustTier: 'own' });
    expect(r.sandboxed).toBe(false);
  });

  test('FORGEAX_SANDBOX=on + FORGEAX_NO_SANDBOX=1 → passthrough(逃生优先)', () => {
    process.env.FORGEAX_SANDBOX = 'on';
    process.env.FORGEAX_NO_SANDBOX = '1';
    _resetSandboxCache();
    const r = maybeSandbox('bc', [], { trustTier: 'imported' });
    expect(r.sandboxed).toBe(false);
  });

  test.if(isDarwinWithSandbox)('FORGEAX_SANDBOX=on + imported + darwin → sandbox-exec 包装,原 cmd/args 在尾部', () => {
    process.env.FORGEAX_SANDBOX = 'on';
    _resetSandboxCache();
    const r = maybeSandbox('bc', ['-p', 'hi'], { trustTier: 'imported' });
    expect(r.sandboxed).toBe(true);
    expect(r.command).toBe('/usr/bin/sandbox-exec');
    expect(r.args[0]).toBe('-p');
    expect(r.args).toContain('bc');
    expect(r.args.slice(-2)).toEqual(['-p', 'hi']);
  });

  test.if(isDarwinWithSandbox)('沙箱 profile 拦外网、放 loopback(直证)', () => {
    process.env.FORGEAX_SANDBOX = 'on';
    _resetSandboxCache();
    const r = maybeSandbox('/usr/bin/curl', ['-sS', '--max-time', '5', 'https://api.anthropic.com'], { trustTier: 'imported' });
    const ext = spawnSync(r.command, r.args, { encoding: 'utf8' });
    // 外网应连不上(沙箱拒);curl 退出非 0。
    expect(ext.status).not.toBe(0);
    // loopback:尝试连一个本地必拒端口 → curl 报 connection refused(= 沙箱放行到达了 TCP 层),非沙箱阻断。
    const lo = maybeSandbox('/usr/bin/curl', ['-sS', '--max-time', '3', 'http://127.0.0.1:1/'], { trustTier: 'imported' });
    const loRes = spawnSync(lo.command, lo.args, { encoding: 'utf8' });
    expect(loRes.status).not.toBe(0); // 端口 1 无服务 → refused(但不是沙箱拦)
    expect(`${loRes.stderr}`).toMatch(/refused|connect/i);
  });
});
