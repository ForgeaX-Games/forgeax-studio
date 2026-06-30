/**
 * openclaw-api —— openclaw HTTP JSON 端点封装(全部挂 `<baseUrl>/ilink/bot/<endpoint>`)。
 *
 *   - getupdates : 长轮询收新消息(客户端超时即返回空,由调用方重试)。
 *   - sendmessage: 发文本消息(message_type=2 bot / message_state=2 finish)。
 *
 * 每个请求都带公共头 Authorization(Bearer bot_token)+ AuthorizationType + X-WECHAT-UIN,
 * body 外层包一层 base_info.channel_version(forgeax 自己的标识)。无 app secret、无签名。
 *
 * Boundary(HOST 层):node:crypto + 全局 fetch + 相对 import,无第三方 bare 依赖。
 */
import { randomBytes } from 'node:crypto';

import type {
  GetUpdatesResponse,
  SendMessageRequest,
  SendMessageResponse,
  WechatCredentials,
} from './openclaw-types';
import { DEFAULT_POLL_TIMEOUT_MS } from './openclaw-types';

/** X-WECHAT-UIN:随机 uint32 → 十进制串 → base64。 */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export class OpenclawApi {
  private credentials: WechatCredentials;
  private readonly channelVersion: string;

  constructor(credentials: WechatCredentials, channelVersion: string) {
    this.credentials = credentials;
    this.channelVersion = channelVersion;
  }

  updateCredentials(credentials: WechatCredentials): void {
    this.credentials = credentials;
  }

  private buildHeaders(bodyStr: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
      'X-WECHAT-UIN': randomWechatUin(),
    };
    if (this.credentials.token) {
      headers.Authorization = `Bearer ${this.credentials.token}`;
    }
    return headers;
  }

  private url(endpoint: string): string {
    const base = this.credentials.apiBaseUrl.replace(/\/$/, '');
    return `${base}/ilink/bot/${endpoint}`;
  }

  private async post<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T> {
    const bodyStr = JSON.stringify({ ...(body as object), base_info: { channel_version: this.channelVersion } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url(endpoint), {
        method: 'POST',
        headers: this.buildHeaders(bodyStr),
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${rawText}`);
      }
      return JSON.parse(rawText) as T;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /** 长轮询收消息;客户端超时(AbortError)属正常,返回空响应让调用方继续轮询。 */
  async getUpdates(cursor: string): Promise<GetUpdatesResponse> {
    try {
      return await this.post<GetUpdatesResponse>(
        'getupdates',
        { get_updates_buf: cursor },
        DEFAULT_POLL_TIMEOUT_MS + 10_000,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw err;
    }
  }

  /** 发一条文本消息。 */
  async sendMessage(request: SendMessageRequest): Promise<void> {
    const resp = await this.post<SendMessageResponse>('sendmessage', request, 15_000);
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`openclaw sendmessage failed: ret=${resp.ret}, errmsg=${resp.errmsg ?? 'unknown'}`);
    }
  }
}
