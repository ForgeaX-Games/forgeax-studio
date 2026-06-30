/**
 * openclaw-auth —— 扫码登录流程 + 凭证落盘(单账号一份)。
 *
 * 流程(纯 HTTP,无 wechaty):
 *   1. GET  /ilink/bot/get_bot_qrcode?bot_type=<t>  → { qrcode, qrcode_img_content }
 *   2. 把 qrcode_img_content 当 payload 渲染成终端二维码,等用户扫
 *   3. GET  /ilink/bot/get_qrcode_status?qrcode=<qrcode>  → 长轮询 wait/scaned/confirmed/expired
 *   4. confirmed → { bot_token, ilink_bot_id, baseurl, ilink_user_id } 即凭证
 *   5. 凭证原子写入 credentialsPath(0600)
 *
 * 配置(baseUrl/botType/credentialsPath)由 channel 下传,本文件不读 env(Pipeline Isolation)。
 *
 * Boundary(HOST 层):node:fs/path + 全局 fetch + 相对 import。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OpenclawConfig, QRCodeResponse, QRStatusResponse, WechatCredentials } from './openclaw-types';
import { QR_LONG_POLL_TIMEOUT_MS } from './openclaw-types';

/** 扫码进度状态(channel 据此映射成 RemoteEvent)。 */
export type QRAuthStatus =
  | { type: 'fetching'; message: string }
  | { type: 'qr_ready'; message: string; qrPayload: string }
  | { type: 'scanned'; message: string }
  | { type: 'expired'; message: string }
  | { type: 'confirmed'; message: string };

// ============ 凭证读写(原子写 + 0600) ============

export function loadCredentials(credentialsPath: string): WechatCredentials | undefined {
  try {
    if (!fs.existsSync(credentialsPath)) return undefined;
    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as WechatCredentials;
    if (!data.apiBaseUrl || !data.token) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

export function saveCredentials(credentialsPath: string, credentials: WechatCredentials): void {
  const dir = path.dirname(credentialsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${credentialsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), 'utf-8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  fs.renameSync(tmp, credentialsPath);
}

export function clearCredentials(credentialsPath: string): void {
  try {
    if (fs.existsSync(credentialsPath)) fs.rmSync(credentialsPath);
  } catch {
    /* ignore */
  }
}

// ============ 扫码流程 ============

async function fetchQRCode(baseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`get_bot_qrcode 失败: ${response.status} ${response.statusText} body=${body}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`get_qrcode_status 失败: ${response.status}`);
    return (await response.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

/**
 * 走完扫码鉴权。成功返回凭证(并落盘);超时/失败抛错。
 * @param cfg     运行配置(baseUrl/botType/credentialsPath/channelVersion)
 * @param onStatus 进度回调(channel 据此 emit qr / 状态)
 * @param shouldContinue 取消钩子(dispose 时返回 false 中断)
 */
export async function performQrCodeAuth(
  cfg: OpenclawConfig,
  onStatus: (status: QRAuthStatus) => void,
  shouldContinue: () => boolean = () => true,
): Promise<WechatCredentials> {
  onStatus({ type: 'fetching', message: '获取二维码…' });
  const qrResponse = await fetchQRCode(cfg.baseUrl, cfg.botType);
  onStatus({ type: 'qr_ready', message: '请用微信扫描二维码', qrPayload: qrResponse.qrcode_img_content });

  const maxWaitMs = 8 * 60 * 1000; // 最多等 8 分钟,过期自动刷新
  const deadline = Date.now() + maxWaitMs;
  let currentQrcode = qrResponse.qrcode;
  let scannedNotified = false;
  let refreshCount = 0;
  const maxRefresh = 3;

  while (Date.now() < deadline && shouldContinue()) {
    const statusResponse = await pollQRStatus(cfg.baseUrl, currentQrcode);
    switch (statusResponse.status) {
      case 'wait':
        break;
      case 'scaned':
        if (!scannedNotified) {
          onStatus({ type: 'scanned', message: '已扫描,请在微信确认…' });
          scannedNotified = true;
        }
        break;
      case 'expired': {
        if (++refreshCount > maxRefresh) throw new Error('二维码过期次数过多');
        onStatus({ type: 'expired', message: `二维码过期,刷新中…(${refreshCount}/${maxRefresh})` });
        const fresh = await fetchQRCode(cfg.baseUrl, cfg.botType);
        currentQrcode = fresh.qrcode;
        scannedNotified = false;
        onStatus({ type: 'qr_ready', message: '新二维码已就绪,请重新扫描', qrPayload: fresh.qrcode_img_content });
        break;
      }
      case 'confirmed': {
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          throw new Error('鉴权已确认但服务端未返回凭证');
        }
        const credentials: WechatCredentials = {
          apiBaseUrl: statusResponse.baseurl || cfg.baseUrl,
          token: statusResponse.bot_token,
          accountId: statusResponse.ilink_bot_id,
          userId: statusResponse.ilink_user_id,
        };
        saveCredentials(cfg.credentialsPath, credentials);
        onStatus({ type: 'confirmed', message: '已连接微信' });
        return credentials;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('扫码鉴权超时');
}
