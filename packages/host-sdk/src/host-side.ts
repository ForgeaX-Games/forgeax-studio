/**
 * Host-side API — used in interface (iframe-parent) to wrap a plugin iframe.
 *
 * Usage:
 *   import { createPluginPort } from '@forgeax/host-sdk/host';
 *   const port = createPluginPort({ pluginId, transport });
 *   port.onChat(({ text }) => composer.appendUserMessage(text));
 *   port.onToolCall(async (call) => myToolRegistry.run(call));
 *   port.surface.subscribe((s) => surfaceStore.upsert(s));
 *   await port.surface.dispatch('wb-character', 'reload', { slug });
 *   port.setTheme({ theme: 'dark' });
 */
import type {
  HostSdkEnvelope,
  ToolCall,
  ToolResult,
} from '@forgeax/types';
import { RpcChannel } from './rpc';
import type { Transport } from './transport';

export interface CreatePluginPortOptions {
  pluginId: string;
  transport: Transport;
  /** Initial handshake response payload returned to the plugin. */
  initial?: {
    locale?: 'zh' | 'en' | 'ja';
    theme?: 'light' | 'dark';
    sessionId?: string;
    threadId?: string;
    pane?: 'left' | 'center';
  };
  defaultTimeoutMs?: number;
  onInvalid?: (raw: unknown, reason: string) => void;
}

export interface PluginPort {
  /** Underlying RPC for advanced use. */
  channel: RpcChannel;
  /** The plugin id this port talks to. */
  pluginId: string;

  /** Plugin posted text into our chat panel. Returns unsub. */
  onChat(handler: (e: { text: string; attachments?: string[] }) => void): () => void;

  /** Plugin requested we run a tool on its behalf. Handler returns the result;
   *  port wires the reply back. */
  onToolCall(handler: (call: ToolCall) => Promise<ToolResult> | ToolResult): () => void;

  surface: {
    /** Subscribe to surface.expose events from this plugin. */
    subscribe(
      handler: (e: {
        surfaceId: string;
        actions: Array<{
          id: string;
          label?: string;
          args?: unknown;
          enabled: boolean;
          hotkey?: string;
        }>;
        snapshot: unknown;
      }) => void,
    ): () => void;

    /** Tell the plugin to run an action (AI / human-from-host triggered).
     *  Resolves with plugin's ack. */
    dispatch(
      surfaceId: string,
      actionId: string,
      args?: unknown,
      opts?: { awaitAck?: boolean; timeoutMs?: number },
    ): Promise<{ ok: boolean; error?: string; result?: unknown }>;
  };

  setTheme(e: { locale?: 'zh' | 'en' | 'ja'; theme?: 'light' | 'dark' }): void;

  /** Keep-alive panel visibility. The host CSS-hides inactive plugin iframes
   *  instead of unmounting them (no reload / cold-start on tab switch); this
   *  tells the plugin whether it is the visible tab so heavy plugins can pause
   *  their render loop while hidden. See docs/.../06-WORKBENCH-THREE-PANE-V2.md. */
  setVisibility(visible: boolean): void;

  /** Plugin requested the host switch the active workbench to another plugin,
   *  handing off context (charId / role / slug). Returns unsub.
   *  See navigate.request in @forgeax/types host-sdk schema. */
  onNavigate(
    handler: (e: { targetPluginId: string; payload?: Record<string, unknown> }) => void,
  ): () => void;

  ui: {
    /** Doc 07 §9.2 — tell the plugin to flash the surface element that just
     *  got driven by AI / CLI / an event. Default duration 1.5s, default
     *  selector resolved by plugin SDK from `data-fx-surface` + `data-fx-action`
     *  attributes. */
    flash(input: {
      surfaceId: string;
      actionId?: string;
      selector?: string;
      durationMs?: number;
      cause?: 'ai' | 'cli' | 'event' | 'user';
    }): void;
  };

  close(): void;
}

export function createPluginPort(opts: CreatePluginPortOptions): PluginPort {
  const channel = new RpcChannel({
    transport: opts.transport,
    self: { kind: 'host' },
    defaultTimeoutMs: opts.defaultTimeoutMs,
    onInvalid: opts.onInvalid,
  });

  // Auto-handshake: when the plugin asks, reply with stored initial state.
  channel.on('handshake.request', (env) => {
    const { locale = 'zh', theme = 'dark', sessionId, threadId, pane } = opts.initial ?? {};
    channel.reply(env, {
      kind: 'handshake.response',
      protocol: 1,
      locale,
      theme,
      ctx: { sessionId, threadId, pane },
    });
  });

  return {
    channel,
    pluginId: opts.pluginId,

    onChat(handler) {
      return channel.on('chat.post', (env) => {
        handler({ text: env.text, attachments: env.attachments });
      });
    },

    onToolCall(handler) {
      return channel.on('tool.call', async (env) => {
        let result: ToolResult;
        try {
          result = await handler(env.call);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        channel.reply(env, { kind: 'tool.result', result });
      });
    },

    surface: {
      subscribe(handler) {
        return channel.on('surface.expose', (env) => {
          handler({
            surfaceId: env.surfaceId,
            actions: env.actions.map((a) => ({
              id: a.id,
              label: a.label,
              args: a.args,
              enabled: a.enabled ?? true,
              hotkey: a.hotkey,
            })),
            snapshot: env.snapshot,
          });
        });
      },

      async dispatch(surfaceId, actionId, args, opts2) {
        const awaitAck = opts2?.awaitAck !== false;
        if (!awaitAck) {
          channel.send({
            kind: 'surface.dispatch',
            surfaceId, actionId, args, awaitAck: false,
          });
          return { ok: true };
        }
        const resp = await channel.request<Extract<HostSdkEnvelope, { kind: 'surface.ack' }>>(
          { kind: 'surface.dispatch', surfaceId, actionId, args, awaitAck: true },
          'surface.ack',
          opts2?.timeoutMs,
        );
        return { ok: resp.ok, error: resp.error, result: resp.result };
      },
    },

    setTheme(e) {
      channel.send({ kind: 'theme.changed', locale: e.locale, theme: e.theme });
    },

    setVisibility(visible) {
      channel.send({ kind: 'visibility.changed', visible });
    },

    onNavigate(handler) {
      return channel.on('navigate.request', (env) => {
        handler({ targetPluginId: env.targetPluginId, payload: env.payload });
      });
    },

    ui: {
      flash(input) {
        channel.send({
          kind: 'ui.flash',
          surfaceId: input.surfaceId,
          actionId: input.actionId,
          selector: input.selector,
          durationMs: input.durationMs,
          cause: input.cause,
        });
      },
    },

    close() { channel.close(); },
  };
}
