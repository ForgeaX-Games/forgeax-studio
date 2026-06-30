/**
 * sandbox(R3 S3)—— imported 内核 spawn 的**网络隔离**(macOS `sandbox-exec`)。
 *
 * 与 S2 合力:imported 内核调模型走 **loopback cred-vault**(127.0.0.1);本沙箱"拦外网、
 * 仅放 loopback" → 内核仍能经 vault 出模型响应(vault 在 sidecar 内、不被沙箱、替它访外),
 * 而 imported **自身够不到任何外部主机** → 偷到也送不出去(R3-14 网络面)。own/forge 不沙箱。
 *
 * 平台 / 启用:**默认关**,需 `FORGEAX_SANDBOX=on` 显式开(且 imported + darwin + sandbox-exec 在)。
 * 为何默认关:网络隔离**机制**已验证可靠(curl/node fetch loopback 通、外网被拒、单测覆盖),但
 * **rented 内核在该沙箱下连不上 loopback vault**(node fetch 能、rented 内核不能——其内部
 * 不透明,macOS 上无法可靠 sandbox;规格已 risk-accept)。故作 opt-in/实验件落地,真正强制留 Linux
 * netns / 生产沙箱。资源/文件层隔离同样 deferred(macOS 原语不足:内存 ulimit 忽略、file-read deny 不稳)。
 */
import { spawnSync } from 'node:child_process';

export type TrustTier = 'own' | 'imported';

/** allow-default + 拦外网、仅放 loopback(内核→vault)。 */
const NET_ISOLATION_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  // sandbox-exec 网络地址只接受 "localhost"/"*"(不能写数字 IP);localhost 即覆盖 127.0.0.1/::1 回环。
  '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
  '(allow network-bind network-inbound (local ip "localhost:*"))',
].join('\n');

let availCache: boolean | null = null;

/** 探测 `sandbox-exec` 可用(缓存)。 */
export function sandboxAvailable(): boolean {
  if (availCache !== null) return availCache;
  if (process.platform !== 'darwin') return (availCache = false);
  try {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' });
    availCache = r.status === 0;
  } catch {
    availCache = false;
  }
  return availCache;
}

export interface MaybeSandboxOpts {
  trustTier: TrustTier;
}

/** 沙箱内额外 env:关掉 CLI 的非必要外网(遥测/统计/自更新/错误上报)——否则 `(deny network*)`
 *  会拦掉这些启动期外连,内核把它当致命错("typo in url")。关掉后只剩模型流量(走 loopback vault)。 */
export const SANDBOX_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1',
};

/** imported + darwin + sandbox-exec 可用 + 未禁用 → 包装为 sandbox-exec(网络隔离);否则原样。 */
export function maybeSandbox(
  command: string,
  args: string[],
  opts: MaybeSandboxOpts,
): { command: string; args: string[]; sandboxed: boolean } {
  const enabled =
    (process.env.FORGEAX_SANDBOX ?? '') === 'on' && // 默认关(rented 内核在沙箱下连不上 vault,见文件头)
    opts.trustTier === 'imported' &&
    (process.env.FORGEAX_NO_SANDBOX ?? '') !== '1' &&
    sandboxAvailable();
  if (!enabled) return { command, args, sandboxed: false };
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', NET_ISOLATION_PROFILE, command, ...args],
    sandboxed: true,
  };
}

/** 测试用:重置探测缓存。 */
export function _resetSandboxCache(): void { availCache = null; }
