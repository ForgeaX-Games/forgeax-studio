/**
 * WechatChannel —— 微信远端通道(openclaw 外接 HTTP 长轮询)。RemoteChannel 的真实现。
 *
 * 取代旧的 wechaty 实现:openclaw 是微信官方对外开放的机器人接口,纯 fetch、无 wechaty、
 * 无付费网关、无 app secret(认证靠扫码现发的 bot_token)。生命周期映射到 RemoteChannel:
 *   connect() → 无凭证则走扫码(emit 'qr' + 'scan' 态,确认后落盘)→ 'online' → 启长轮询;
 *               有凭证则直接 'online' 启轮询。
 *   轮询 getupdates → 用户消息 emit 'message';按 from_user_id 记 context_token 供回复定址。
 *   send(peer) → 取该对端的 context_token,sendmessage 回去。
 *
 * 配置走 env(不污染 settings schema):
 *   FORGEAX_WECHAT_ENDPOINT         openclaw API base(默认 https://ilinkai.weixin.qq.com)
 *   FORGEAX_WECHAT_BOT_TYPE         扫码 bot_type(默认 '3';若服务端做厂商白名单,需登记自己的)
 *   FORGEAX_WECHAT_CHANNEL_VERSION  应用版本号(默认 'forgeax-1.0.0')
 *   FORGEAX_WECHAT_CREDENTIALS      凭证文件路径(默认 ~/.forgeax/channels/wechat/credentials.json)
 *
 * Boundary(HOST 层):node:os/path + 相对 import,无 react/ink、无第三方 bare 依赖。
 */
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  RemoteChannel,
  RemoteEvent,
  RemoteListener,
  RemotePeer,
  RemoteStatus,
} from '../channel';
import { OpenclawApi } from './openclaw-api';
import { clearCredentials, loadCredentials, performQrCodeAuth } from './openclaw-auth';
import {
  CREDENTIALS_DIR,
  CREDENTIALS_FILENAME,
  DEFAULT_API_BASE_URL,
  DEFAULT_CHANNEL_VERSION,
  DEFAULT_DEDUP_WINDOW_SIZE,
  DEFAULT_ILINK_BOT_TYPE,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  ERRCODE_SESSION_TIMEOUT,
  type OpenclawConfig,
  type WechatCredentials,
  type WechatMessage,
  WechatMessageItemType,
} from './openclaw-types';

export interface WechatChannelOptions extends Partial<OpenclawConfig> {
  /**
   * true = 每次 connect 都强制重新扫码,忽略磁盘已存凭证。
   * 「+ 添加微信账号」按钮语义就是「登录一个账号 → 出二维码」,故工厂传 true;
   * 留 false 时(自动重连 / 单测)走「有凭证则直接 online」的快路径。
   */
  freshScan?: boolean;
}

/** 从 env 读 openclaw 配置(显式参数优先)。 */
export function openclawConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<OpenclawConfig> = {},
): OpenclawConfig {
  return {
    baseUrl: overrides.baseUrl ?? env.FORGEAX_WECHAT_ENDPOINT ?? DEFAULT_API_BASE_URL,
    botType: overrides.botType ?? env.FORGEAX_WECHAT_BOT_TYPE ?? DEFAULT_ILINK_BOT_TYPE,
    channelVersion: overrides.channelVersion ?? env.FORGEAX_WECHAT_CHANNEL_VERSION ?? DEFAULT_CHANNEL_VERSION,
    credentialsPath:
      overrides.credentialsPath ??
      env.FORGEAX_WECHAT_CREDENTIALS ??
      path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILENAME),
  };
}

/** 从消息 item_list 抽取纯文本(媒体条目本通道忽略)。 */
function extractText(msg: WechatMessage): string {
  let text = '';
  for (const item of msg.item_list ?? []) {
    if (item.type === WechatMessageItemType.TEXT && item.text_item?.text) {
      text += (text ? '\n' : '') + item.text_item.text;
    }
  }
  return text;
}

export function createWechatChannel(opts: WechatChannelOptions = {}): RemoteChannel {
  const cfg = openclawConfigFromEnv(process.env, opts);
  const freshScan = opts.freshScan ?? false;
  const listeners = new Set<RemoteListener>();
  // 对端 → 回复定址信息(to_user_id + 最近 context_token)。有界 LRU 防长会话无界增长。
  const REPLIER_CAP = 256;
  const repliers = new Map<string, { toUserId: string; contextToken?: string }>();
  const rememberReplier = (id: string, info: { toUserId: string; contextToken?: string }): void => {
    repliers.delete(id);
    repliers.set(id, info);
    if (repliers.size > REPLIER_CAP) {
      const oldest = repliers.keys().next().value;
      if (oldest !== undefined) repliers.delete(oldest);
    }
  };
  // 去重(LRU):message_id 已处理过则跳过。
  const seen = new Set<string>();
  const seenQueue: string[] = [];
  const recordSeen = (id: string): void => {
    seen.add(id);
    seenQueue.push(id);
    if (seenQueue.length > DEFAULT_DEDUP_WINDOW_SIZE) {
      const old = seenQueue.shift();
      if (old !== undefined) seen.delete(old);
    }
  };

  let status: RemoteStatus = 'idle';
  let qr: string | null = null;
  let label = '微信账号';
  let api: OpenclawApi | null = null;
  let starting = false;
  let shouldPoll = false;
  let pollCursor = '';
  let reconnectAttempts = 0;

  const emit = (e: RemoteEvent): void => {
    for (const l of listeners) l(e);
  };
  const setStatus = (s: RemoteStatus, detail?: string): void => {
    status = s;
    emit({ type: 'status', status: s, detail });
  };

  const backoffDelay = async (): Promise<void> => {
    const delay = Math.min(1000 * 2 ** reconnectAttempts++, DEFAULT_MAX_RECONNECT_DELAY_MS);
    const jitter = Math.floor(delay * 0.2 * Math.random());
    await new Promise((r) => setTimeout(r, delay + jitter));
  };

  const handleMessage = (msg: WechatMessage): void => {
    const msgId = String(msg.message_id ?? msg.seq ?? '');
    if (msgId && seen.has(msgId)) return;
    if (msgId) recordSeen(msgId);
    const text = extractText(msg);
    if (!text) return;
    const fromUserId = msg.from_user_id || 'unknown';
    const peer: RemotePeer = { id: fromUserId, name: `微信用户 ${fromUserId.slice(0, 6)}` };
    rememberReplier(peer.id, { toUserId: fromUserId, contextToken: msg.context_token });
    emit({ type: 'message', inbound: { peer, text } });
  };

  const pollLoop = async (): Promise<void> => {
    while (shouldPoll && api) {
      try {
        const result = await api.getUpdates(pollCursor);
        if (result.ret && result.ret !== 0) {
          if (result.errcode === ERRCODE_SESSION_TIMEOUT) {
            // 会话过期:清凭证,回 error 态,停止轮询(下次 connect 重新扫码)。
            clearCredentials(cfg.credentialsPath);
            shouldPoll = false;
            api = null;
            setStatus('error', '会话已过期,请重新扫码登录');
            return;
          }
          await backoffDelay();
          continue;
        }
        if (result.get_updates_buf) pollCursor = result.get_updates_buf;
        for (const msg of result.msgs ?? []) {
          // 只处理用户消息(message_type=1)且非流式中(state!=1);跳过 bot 自己的(=2)防回环。
          if (msg.message_type === 1 && msg.message_state !== 1) handleMessage(msg);
        }
        reconnectAttempts = 0;
      } catch {
        if (!shouldPoll) break;
        await backoffDelay();
      }
    }
  };

  const goOnline = (creds: WechatCredentials): void => {
    api = new OpenclawApi(creds, cfg.channelVersion);
    label = creds.accountId ? `微信:${creds.accountId.slice(0, 8)}` : '微信账号';
    qr = null;
    shouldPoll = true;
    pollCursor = '';
    reconnectAttempts = 0;
    setStatus('online');
    void pollLoop().catch(() => {
      /* poll loop 自身已处理错误 */
    });
  };

  return {
    kind: 'wechat',
    get label() {
      return label;
    },
    on(listener: RemoteListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async connect(): Promise<void> {
      if (starting || status === 'online') return; // 已连接 / 连接中
      starting = true;
      try {
        setStatus('connecting');
        // 非强制扫码且有已存凭证 → 直接 online(自动重连快路径);
        // 「添加账号」按钮传 freshScan=true,跳过此路,总是出二维码重新扫。
        if (!freshScan) {
          const saved = loadCredentials(cfg.credentialsPath);
          if (saved) {
            goOnline(saved);
            return;
          }
        }
        // 扫码登录。
        const creds = await performQrCodeAuth(
          cfg,
          (s) => {
            if (s.type === 'qr_ready') {
              qr = s.qrPayload;
              setStatus('scan');
              emit({ type: 'qr', payload: s.qrPayload });
            }
            // scanned / expired / fetching / confirmed 仅作进度,不改 RemoteStatus(确认后由 goOnline 统一转 online)。
          },
          () => starting, // dispose 会把 starting 置 false → 中断扫码轮询
        );
        goOnline(creds);
      } catch (err) {
        setStatus('error', String((err as Error)?.message ?? err));
        api = null;
        shouldPoll = false;
      } finally {
        starting = false;
      }
    },

    status: () => status,
    qr: () => qr,

    async send(peer: RemotePeer, text: string): Promise<void> {
      if (!api) return;
      const replier = repliers.get(peer.id);
      const toUserId = replier?.toUserId ?? peer.id;
      try {
        await api.sendMessage({
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `forgeax-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            context_token: replier?.contextToken,
            item_list: [{ type: WechatMessageItemType.TEXT, text_item: { text } }],
          },
        });
      } catch {
        /* 发送失败静默放弃,避免打断主循环 */
      }
    },

    async dispose(): Promise<void> {
      starting = false;
      shouldPoll = false;
      listeners.clear();
      repliers.clear();
      api = null;
      status = 'offline';
    },
  };
}
