/**
 * remote/controller —— 用 FakeChannel 驱动:添加账号 → 入站 sink 触发 → send 定址到对端。
 * 全离线(无网络),验证 /remote-control 的双向中转编排(不含 React/UI)。
 */
import { test, expect, describe } from 'bun:test';
import { createRemoteController, type ChannelFactory, type RemoteInboundMsg } from '../../src/tui/remote/controller';
import { createFakeChannel, type FakeChannel } from '../../src/tui/remote/fake-channel';

describe('RemoteController over FakeChannel', () => {
  test('addAccount 连接并进入 scan 态(有二维码)', async () => {
    const created: FakeChannel[] = [];
    const factory: ChannelFactory = () => {
      const c = createFakeChannel({ qrPayload: 'qr-payload-1' });
      created.push(c);
      return c;
    };
    const controller = createRemoteController(factory);
    const id = await controller.addAccount('fake');
    const list = controller.listRemotes();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(id);
    expect(list[0]!.status).toBe('scan');
    expect(controller.getQr(id)).toBe('qr-payload-1');
    await controller.dispose();
  });

  test('入站消息触发 sink(带 remoteId + peer);send 定址回正确对端', async () => {
    const created: FakeChannel[] = [];
    const factory: ChannelFactory = () => {
      const c = createFakeChannel();
      created.push(c);
      return c;
    };
    const controller = createRemoteController(factory);
    const inbound: RemoteInboundMsg[] = [];
    controller.setInbound((m) => inbound.push(m));

    const id = await controller.addAccount('fake');
    const ch = created[0]!;
    ch.simulateLogin();
    expect(controller.listRemotes()[0]!.status).toBe('online');

    const peer = { id: 'p1', name: 'Alice' };
    ch.simulateInbound(peer, 'hi there');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toEqual({ remoteId: id, peer, text: 'hi there' });

    await controller.send({ remoteId: id, peer }, 'reply back');
    expect(ch.sent).toEqual([{ peer, text: 'reply back' }]);
    await controller.dispose();
  });

  test('on() 状态监听在 addAccount / 状态变化时触发', async () => {
    const created: FakeChannel[] = [];
    const controller = createRemoteController(() => {
      const c = createFakeChannel();
      created.push(c);
      return c;
    });
    let ticks = 0;
    controller.on(() => {
      ticks += 1;
    });
    await controller.addAccount('fake');
    const before = ticks;
    created[0]!.simulateLogin();
    expect(ticks).toBeGreaterThan(before);
    await controller.dispose();
  });

  test('dispose 后入站不再回灌(sink 清空)', async () => {
    const created: FakeChannel[] = [];
    const controller = createRemoteController(() => {
      const c = createFakeChannel();
      created.push(c);
      return c;
    });
    const inbound: RemoteInboundMsg[] = [];
    controller.setInbound((m) => inbound.push(m));
    await controller.addAccount('fake');
    const ch = created[0]!;
    await controller.dispose();
    ch.simulateInbound({ id: 'p9', name: 'Bob' }, 'should be dropped');
    expect(inbound).toHaveLength(0);
  });
});
