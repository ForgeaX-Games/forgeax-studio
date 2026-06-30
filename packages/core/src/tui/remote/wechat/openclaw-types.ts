/**
 * openclaw-types —— 微信 openclaw(开爪/ClawBot)外接机器人 HTTP 协议类型与常量。
 *
 * openclaw 是微信官方「对外开放」的机器人接口(开放 HTTP 机器人协议),
 * 走纯 HTTP 长轮询,**不依赖 wechaty / 不依赖付费网关 / 不依赖企业微信**。所有端点挂在
 * `<baseUrl>/ilink/bot/<endpoint>`,认证只有「扫码时服务器现发的 bot_token」(Bearer),
 * 不存在写死的 app secret。
 *
 * 调用方身份只由两个明文标识决定:`bot_type`(扫码注册类型)+ `channel_version`(应用版本号)。
 * forgeax 用自己的 `channel_version`;`bot_type` 默认沿用通用值,如服务端做了厂商白名单,需到
 * 微信 openclaw 平台登记拿到自己的 bot_type(经 env `FORGEAX_WECHAT_BOT_TYPE` 覆盖)。
 *
 * Boundary(HOST 层):仅 core 相对 import + node:,无 react/ink、无第三方 bare 依赖。
 */

/** 消息条目类型(item_list 内每条)。 */
export const enum WechatMessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

/** 扫码登录后落盘的凭证(单账号一份)。 */
export interface WechatCredentials {
  /** openclaw API base url(扫码确认时服务端可能回一个专属 baseurl)。 */
  apiBaseUrl: string;
  /** Bearer token(ilink_bot_token);扫码确认时下发。 */
  token: string;
  /** ilink bot id(扫码得到,用于派生账号标识)。 */
  accountId?: string;
  /** 扫码用户的 ilink user id。 */
  userId?: string;
}

/** 通道运行配置(由 channel 从 env 组装后下传;auth/api 不直接读 env —— Pipeline Isolation)。 */
export interface OpenclawConfig {
  /** API base url,默认 https://ilinkai.weixin.qq.com。 */
  baseUrl: string;
  /** 扫码 bot_type,默认 '3'。 */
  botType: string;
  /** 应用版本号(base_info.channel_version),forgeax 自己的标识。 */
  channelVersion: string;
  /** 凭证文件路径(单账号)。 */
  credentialsPath: string;
}

// ============ getupdates(长轮询收消息) ============

export interface GetUpdatesResponse {
  ret: number; // 0 = 成功
  errcode?: number; // -14 = 会话超时(需重新扫码)
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf: string; // 下次请求游标
  longpolling_timeout_ms?: number;
}

// ============ sendmessage(发消息) ============

export interface SendMessageRequest {
  msg: {
    from_user_id?: string;
    to_user_id: string;
    client_id?: string;
    message_type?: number; // 1=用户,2=bot
    message_state?: number; // 0=new,1=generating,2=finish
    context_token?: string;
    item_list?: WechatMessageItem[];
  };
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

// ============ 消息体 ============

export interface WechatMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  /** 1=用户,2=bot。 */
  message_type?: number;
  /** 0=new,1=generating,2=done。 */
  message_state?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
}

export interface WechatMessageItem {
  type: WechatMessageItemType;
  text_item?: { text: string };
  // 媒体条目(image/voice/file/video)本通道暂不收发,RemoteChannel 仅承载文本。
}

// ============ 扫码鉴权 ============

/** get_bot_qrcode 响应。 */
export interface QRCodeResponse {
  /** 轮询用的二维码 id。 */
  qrcode: string;
  /** 二维码实际内容(供终端编码成可扫图;= RemoteChannel.qr() 的 payload)。 */
  qrcode_img_content: string;
}

/** get_qrcode_status 响应。 */
export interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// ============ 常量 ============

/** 默认 openclaw API base url。 */
export const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 默认扫码 bot_type。 */
export const DEFAULT_ILINK_BOT_TYPE = '3';
/** forgeax 自己的应用版本号(标识调用方;区别于 a peer agent CLI 的 'cbc-1.0.0')。 */
export const DEFAULT_CHANNEL_VERSION = 'forgeax-1.0.0';
/** getupdates 服务端长轮询时长(ms);客户端 fetch 超时再加 10s 余量。 */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000;
/** 扫码状态长轮询时长(ms)。 */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** 重连退避上限(ms)。 */
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
/** 收消息去重窗口大小。 */
export const DEFAULT_DEDUP_WINDOW_SIZE = 500;
/** 凭证目录(~/.forgeax 下),与文件名。 */
export const CREDENTIALS_DIR = '.forgeax/channels/wechat';
export const CREDENTIALS_FILENAME = 'credentials.json';
/** 会话超时错误码 —— 需重新扫码。 */
export const ERRCODE_SESSION_TIMEOUT = -14;
