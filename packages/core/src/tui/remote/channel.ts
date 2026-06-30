/**
 * RemoteChannel —— /remote-control 的 SSOT 接缝(TUI-only)。
 *
 * 一个「远端通道」= 一个可扫码登录、能收发消息的外部账号传输(wechaty / fake / 将来直连网关)。
 * 上层(controller / overlay / relay)只认本接口,绝不依赖具体实现:
 *   - wechat/wechat-channel.ts 是真实现(openclaw 外接 HTTP 长轮询,纯 fetch,无 wechaty);
 *   - fake-channel.ts 是离线桩(脚本化 qr→login→inbound,供 --demo / 单测);
 *   - 换其它传输(企微 / 直连网关)只需另写一个 RemoteChannel,上层零改动。
 *
 * 事件流是 append-only(status/qr/message 顺序到达);status()/qr() 是「当前状态」快照。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink。
 */

/** 远端对端:消息来自谁 / 回复发给谁(wechaty contact 或 room)。 */
export interface RemotePeer {
  /** 通道内稳定 id(wechaty contact/room id)。 */
  id: string;
  /** 可读名(联系人昵称 / 群标题)。 */
  name: string;
  /** 群聊则 true(回复定址到 room)。 */
  isRoom?: boolean;
}

/** 一个账号/通道的连接生命周期态。 */
export type RemoteStatus =
  | 'idle' // 已创建,未连接
  | 'connecting' // 启动中
  | 'scan' // 等待扫码(此时 qr() 有值)
  | 'online' // 已登录
  | 'offline' // 已登出 / 掉线
  | 'error'; // 失败

/** 一条入站消息(来自远端对端)。 */
export interface RemoteInbound {
  peer: RemotePeer;
  text: string;
}

/** 通道在生命周期里吐出的事件(append-only 流)。 */
export type RemoteEvent =
  | { type: 'status'; status: RemoteStatus; detail?: string }
  | { type: 'qr'; payload: string } // 待渲染的扫码登录二维码字符串
  | { type: 'message'; inbound: RemoteInbound };

export type RemoteListener = (e: RemoteEvent) => void;

/** 通道种类标签(供 UI / 多后端区分)。 */
export type RemoteKind = 'wechat' | 'fake';

/** 远端控制传输的统一接缝。 */
export interface RemoteChannel {
  readonly kind: RemoteKind;
  /** 可读标签(账号名;未登录时为占位)。 */
  readonly label: string;
  /** 订阅生命周期事件;返回退订函数。 */
  on(listener: RemoteListener): () => void;
  /** 开始连接(随后吐 status/qr/message)。重复调用应安全。 */
  connect(): Promise<void>;
  /** 当前状态快照。 */
  status(): RemoteStatus;
  /** 处于 'scan' 时的最近二维码 payload,否则 null。 */
  qr(): string | null;
  /** 给对端回一条文本。 */
  send(peer: RemotePeer, text: string): Promise<void>;
  /** 登出 + 释放资源。 */
  dispose(): Promise<void>;
}
