/**
 * 微信 openclaw 通道端到端:用 Bun.serve 起一个仿真 openclaw 网关(/ilink/bot/*),
 * 驱动真实 createWechatChannel 走完整生命周期(全程真 fetch,无 wechaty):
 *   connect → get_bot_qrcode(emit 'qr' + 'scan') → get_qrcode_status(confirmed → 'online')
 *   → getupdates(投一条用户消息 → emit 'message')→ send(回复经 sendmessage 发回正确对端)。
 *
 * 验证「整套协议接线正确」:请求路径/头(Bearer + channel_version)、扫码态机、收发定址、凭证落盘。
 * 不碰真 ilinkai 服务、不需真人扫码 —— 把 baseUrl 指向本地 mock,credentialsPath 指向 tmp。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWechatChannel } from '../../src/tui/remote/wechat/wechat-channel';
import type { RemoteEvent } from '../../src/tui/remote/channel';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockState {
  qrPolls: number;
  updatesPolls: number;
  sent: Array<{ to_user_id: string; text: string; context_token?: string; channel_version?: string; auth?: string }>;
  baseUrl: string;
}

/** 起一个最小 openclaw 仿真网关。confirmed 立即返回;第一次 getupdates 投一条消息,之后空。 */
function startMockOpenclaw(): { stop: () => void; state: MockState; url: string } {
  const state: MockState = { qrPolls: 0, updatesPolls: 0, sent: [], baseUrl: '' };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/ilink/bot/get_bot_qrcode') {
        return Response.json({ qrcode: 'qrid-1', qrcode_img_content: 'https://weixin.qq.com/x/forgeax-qr' });
      }
      if (p === '/ilink/bot/get_qrcode_status') {
        state.qrPolls++;
        // 第一次回 scaned,第二次回 confirmed(覆盖扫码态机两步)。
        if (state.qrPolls < 2) return Response.json({ status: 'scaned' });
        return Response.json({
          status: 'confirmed',
          bot_token: 'tok-abc',
          ilink_bot_id: 'botid12345',
          ilink_user_id: 'useridXYZ',
          baseurl: state.baseUrl,
        });
      }
      if (p === '/ilink/bot/getupdates') {
        state.updatesPolls++;
        if (state.updatesPolls === 1) {
          return Response.json({
            ret: 0,
            get_updates_buf: 'cursor-1',
            msgs: [
              {
                message_id: 1001,
                from_user_id: 'wx-alice',
                message_type: 1,
                message_state: 2,
                context_token: 'ctx-77',
                item_list: [{ type: 1, text_item: { text: '现在几点' } }],
              },
            ],
          });
        }
        return Response.json({ ret: 0, get_updates_buf: 'cursor-1', msgs: [] });
      }
      if (p === '/ilink/bot/sendmessage') {
        const body = (await req.json()) as any;
        state.sent.push({
          to_user_id: body?.msg?.to_user_id,
          text: body?.msg?.item_list?.[0]?.text_item?.text,
          context_token: body?.msg?.context_token,
          channel_version: body?.base_info?.channel_version,
          auth: req.headers.get('authorization') ?? undefined,
        });
        return Response.json({ ret: 0 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  state.baseUrl = url;
  return { stop: () => server.stop(true), state, url };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wechat-openclaw-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('wechat openclaw channel e2e (mock gateway, real fetch)', () => {
  test('扫码 → online → 收消息 → 回复定址 → 凭证落盘', async () => {
    const mock = startMockOpenclaw();
    const credPath = join(tmp, 'credentials.json');
    const events: RemoteEvent[] = [];
    const channel = createWechatChannel({
      baseUrl: mock.url,
      botType: '3',
      channelVersion: 'forgeax-test-1.0.0',
      credentialsPath: credPath,
    });
    channel.on((e) => events.push(e));

    try {
      await channel.connect();
      // 扫码态机:performQrCodeAuth 每轮间隔 1s,等到 confirmed(qrPolls 达 2)。
      for (let i = 0; i < 50 && channel.status() !== 'online'; i++) await sleep(100);
      expect(channel.status()).toBe('online');

      // ① 扫码阶段 emit 了 qr + scan
      const qrEvent = events.find((e) => e.type === 'qr');
      expect(qrEvent && qrEvent.type === 'qr' && qrEvent.payload).toBe('https://weixin.qq.com/x/forgeax-qr');
      expect(events.some((e) => e.type === 'status' && e.status === 'scan')).toBe(true);
      expect(events.some((e) => e.type === 'status' && e.status === 'online')).toBe(true);

      // ② 凭证已落盘
      expect(existsSync(credPath)).toBe(true);
      const saved = JSON.parse(readFileSync(credPath, 'utf-8'));
      expect(saved.token).toBe('tok-abc');
      expect(saved.accountId).toBe('botid12345');

      // ③ 长轮询收到用户消息 → emit message
      for (let i = 0; i < 50 && !events.some((e) => e.type === 'message'); i++) await sleep(100);
      const msgEvent = events.find((e) => e.type === 'message');
      expect(msgEvent && msgEvent.type === 'message' && msgEvent.inbound.text).toBe('现在几点');
      const peer = (msgEvent as Extract<RemoteEvent, { type: 'message' }>).inbound.peer;
      expect(peer.id).toBe('wx-alice');

      // ④ 回复经 sendmessage 发回正确对端(带 context_token + forgeax channel_version + Bearer)
      await channel.send(peer, '现在 15:30');
      for (let i = 0; i < 30 && mock.state.sent.length === 0; i++) await sleep(50);
      expect(mock.state.sent.length).toBeGreaterThanOrEqual(1);
      const sent = mock.state.sent[0]!;
      expect(sent.to_user_id).toBe('wx-alice');
      expect(sent.text).toBe('现在 15:30');
      expect(sent.context_token).toBe('ctx-77');
      expect(sent.channel_version).toBe('forgeax-test-1.0.0');
      expect(sent.auth).toBe('Bearer tok-abc');
    } finally {
      await channel.dispose();
      mock.stop();
    }
  });

  test('已有凭证 → 直接 online,跳过扫码', async () => {
    const mock = startMockOpenclaw();
    const credPath = join(tmp, 'credentials.json');
    // 预置凭证
    const { saveCredentials } = await import('../../src/tui/remote/wechat/openclaw-auth');
    saveCredentials(credPath, { apiBaseUrl: mock.url, token: 'tok-pre', accountId: 'preacct', userId: 'u1' });

    const events: RemoteEvent[] = [];
    const channel = createWechatChannel({ baseUrl: mock.url, credentialsPath: credPath });
    channel.on((e) => events.push(e));
    try {
      await channel.connect();
      for (let i = 0; i < 30 && channel.status() !== 'online'; i++) await sleep(50);
      expect(channel.status()).toBe('online');
      // 没走扫码 → 无 qr / scan 事件
      expect(events.some((e) => e.type === 'qr')).toBe(false);
      expect(events.some((e) => e.type === 'status' && e.status === 'scan')).toBe(false);
      // 没碰 get_qrcode_status
      expect(mock.state.qrPolls).toBe(0);
    } finally {
      await channel.dispose();
      mock.stop();
    }
  });

  test('freshScan=true → 即使已有凭证也重新出二维码扫码', async () => {
    const mock = startMockOpenclaw();
    const credPath = join(tmp, 'credentials.json');
    const { saveCredentials } = await import('../../src/tui/remote/wechat/openclaw-auth');
    saveCredentials(credPath, { apiBaseUrl: mock.url, token: 'tok-pre', accountId: 'preacct', userId: 'u1' });

    const events: RemoteEvent[] = [];
    const channel = createWechatChannel({ baseUrl: mock.url, credentialsPath: credPath, freshScan: true });
    channel.on((e) => events.push(e));
    try {
      await channel.connect();
      for (let i = 0; i < 50 && channel.status() !== 'online'; i++) await sleep(100);
      // 强制扫码:出了 qr + scan 态,且确实轮询了二维码状态(走了扫码流程而非走缓存)
      expect(events.some((e) => e.type === 'qr')).toBe(true);
      expect(events.some((e) => e.type === 'status' && e.status === 'scan')).toBe(true);
      expect(mock.state.qrPolls).toBeGreaterThan(0);
      expect(channel.status()).toBe('online');
    } finally {
      await channel.dispose();
      mock.stop();
    }
  });
});
