/**
 * Plugin-side API — used inside an iframe-loaded plugin.
 *
 * Usage:
 *   import { createHost } from '@forgeax/host-sdk/plugin';
 *   const host = createHost({ pluginId: '@forgeax-plugin/wb-character', transport });
 *   const hand = await host.handshake();          // protocol negotiation
 *   await host.tool.call({ toolId: 'character:list', args: { slug: 'mini-gta' } });
 *   host.surface.expose('wb-character', { actions: [...], snapshot: {...} });
 *   const off = host.surface.onDispatch((env) => { ... reply ... });
 *
 * 当前文件不引 DOM 全局；window-bound transport 在 transport-window.ts，A3 一并写。
 */
import type {
  HostSdkEnvelope,
  HandshakeResponseSchema,
  ToolCall,
  ToolResult,
} from '@forgeax/types';
import { z } from 'zod';
import { RpcChannel } from './rpc';
import { installPluginDiagnosticsBridge } from './plugin-diagnostics';
import type { Transport } from './transport';

type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

export interface CreateHostOptions {
  pluginId: string;
  transport: Transport;
  defaultTimeoutMs?: number;
  onInvalid?: (raw: unknown, reason: string) => void;
}

export interface PluginHostApi {
  /** Underlying RPC for advanced use; prefer the typed sub-namespaces below. */
  channel: RpcChannel;

  handshake(opts?: { timeoutMs?: number }): Promise<HandshakeResponse>;

  chat: {
    post(text: string, attachments?: string[]): void;
  };

  tool: {
    call(call: ToolCall, timeoutMs?: number): Promise<ToolResult>;
  };

  /** Request the host switch the active workbench to another plugin, handing
   *  off context (charId / role / slug). Fire-and-forget (host has no ack). */
  navigate(targetPluginId: string, payload?: Record<string, unknown>): void;

  surface: {
    /** Push current UI state + actions to host. Cheap; call on every render. */
    expose(
      surfaceId: string,
      payload: {
        actions: Array<{
          id: string;
          label?: string;
          args?: unknown;
          enabled?: boolean;
          hotkey?: string;
        }>;
        snapshot?: unknown;
      },
    ): void;

    /** Receive surface.dispatch from host (AI driving the UI). Auto-acks via the
     *  callback's return value (or thrown error). Returns unsubscribe fn. */
    onDispatch(
      handler: (input: {
        surfaceId: string;
        actionId: string;
        args: unknown;
      }) => Promise<unknown> | unknown,
    ): () => void;
  };

  theme: {
    /** Subscribe to theme/locale changes. Returns unsubscribe fn. */
    subscribe(cb: (e: { locale?: 'zh' | 'en' | 'ja'; theme?: 'light' | 'dark' }) => void): () => void;
  };

  visibility: {
    /** Subscribe to keep-alive panel visibility changes. The host CSS-hides
     *  inactive plugin iframes (no reload on tab switch); `visible:false`
     *  means this panel is hidden but still alive — heavy plugins should pause
     *  their render loop / WS heartbeat and resume on `visible:true`.
     *  Returns unsubscribe fn. */
    subscribe(cb: (e: { visible: boolean }) => void): () => void;
  };

  ui: {
    /** Manually flash a DOM element with the `fx-ai-acting` class. Used when
     *  a plugin author wants to mirror the host-driven effect locally (e.g.
     *  a self-test mode). The default `flashElement` adds the class, then
     *  removes it after `durationMs`. Safe to call when DOM is unavailable
     *  (SSR / tests) — it no-ops. */
    flashElement(target: Element | string, durationMs?: number): void;

    /** Subscribe to host-pushed `ui.flash` envelopes. The default handler
     *  installed by the SDK already calls `flashElement` against the resolved
     *  selector (data-fx-surface + data-fx-action), so plugin authors only
     *  need this hook if they want custom behavior (e.g. typing animation
     *  for input surfaces). Returns unsubscribe fn. */
    onFlash(handler: (e: {
      surfaceId: string;
      actionId?: string;
      selector?: string;
      durationMs: number;
      cause?: 'ai' | 'cli' | 'event' | 'user';
    }) => void): () => void;
  };

  close(): void;
}

/** Single source of truth for the highlight class.
 *  Doc 07 §9.2 spells it `fx-ai-acting`. */
const FX_AI_ACTING = 'fx-ai-acting';
const FX_DEFAULT_MS = 1500;

function resolveTarget(
  target: Element | string,
): Element | null {
  if (typeof target !== 'string') return target;
  if (typeof document === 'undefined') return null;
  try {
    return document.querySelector(target);
  } catch {
    return null;
  }
}

function flashElementImpl(target: Element | string, durationMs?: number): void {
  const el = resolveTarget(target);
  if (!el) return;
  const ms = durationMs && durationMs > 0 ? durationMs : FX_DEFAULT_MS;
  el.classList.add(FX_AI_ACTING);
  setTimeout(() => {
    try { el.classList.remove(FX_AI_ACTING); } catch { /* element gone */ }
  }, ms);
}

function defaultSelectorFor(surfaceId: string, actionId?: string): string {
  // CSS.escape is browser-only; fall back to a naive escaper for SSR/tests.
  const esc = (s: string): string => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/(["\\\]\[])/g, '\\$1');
  };
  if (actionId) {
    return `[data-fx-surface="${esc(surfaceId)}"][data-fx-action="${esc(actionId)}"], ` +
      `[data-fx-surface="${esc(surfaceId)}"] [data-fx-action="${esc(actionId)}"]`;
  }
  return `[data-fx-surface="${esc(surfaceId)}"]`;
}

export function createHost(opts: CreateHostOptions): PluginHostApi {
  // Forward this plugin iframe's console errors / uncaught exceptions to the
  // host health feed (was: plugin errors died in the plugin's own DevTools).
  installPluginDiagnosticsBridge(opts.pluginId);

  const channel = new RpcChannel({
    transport: opts.transport,
    self: { kind: 'plugin', pluginId: opts.pluginId },
    defaultTimeoutMs: opts.defaultTimeoutMs,
    onInvalid: opts.onInvalid,
  });

  return {
    channel,

    async handshake(o) {
      const resp = await channel.request<Extract<HostSdkEnvelope, { kind: 'handshake.response' }>>(
        { kind: 'handshake.request', protocols: [1] },
        'handshake.response',
        o?.timeoutMs,
      );
      return resp;
    },

    chat: {
      post(text, attachments) {
        channel.send({ kind: 'chat.post', text, attachments });
      },
    },

    tool: {
      async call(call, timeoutMs) {
        const resp = await channel.request<Extract<HostSdkEnvelope, { kind: 'tool.result' }>>(
          { kind: 'tool.call', call },
          'tool.result',
          timeoutMs,
        );
        return resp.result;
      },
    },

    navigate(targetPluginId, payload) {
      channel.send({ kind: 'navigate.request', targetPluginId, payload });
    },

    surface: {
      expose(surfaceId, payload) {
        channel.send({
          kind: 'surface.expose',
          surfaceId,
          actions: payload.actions.map((a) => ({
            id: a.id,
            label: a.label,
            args: a.args,
            enabled: a.enabled ?? true,
            hotkey: a.hotkey,
          })),
          snapshot: payload.snapshot,
        });
      },

      onDispatch(handler) {
        return channel.on('surface.dispatch', async (env) => {
          const { surfaceId, actionId, args, awaitAck } = env;
          let ok = true;
          let result: unknown;
          let error: string | undefined;
          try {
            result = await handler({ surfaceId, actionId, args });
          } catch (e) {
            ok = false;
            error = e instanceof Error ? e.message : String(e);
          }
          if (awaitAck !== false) {
            channel.reply(env, {
              kind: 'surface.ack',
              surfaceId,
              ok,
              error,
              result,
            });
          }
        });
      },
    },

    theme: {
      subscribe(cb) {
        return channel.on('theme.changed', (env) => {
          cb({ locale: env.locale, theme: env.theme });
        });
      },
    },

    visibility: {
      subscribe(cb) {
        return channel.on('visibility.changed', (env) => {
          cb({ visible: env.visible });
        });
      },
    },

    ui: (() => {
      // Default handler: when host says "flash X", resolve selector + apply
      // the class. Authors who installed onFlash will run *in addition* —
      // both fire. If a custom handler wants exclusive control it can read
      // a flag in its own snapshot and skip our default by stripping the
      // class itself.
      channel.on('ui.flash', (env) => {
        const sel = env.selector ?? defaultSelectorFor(env.surfaceId, env.actionId);
        flashElementImpl(sel, env.durationMs);
      });
      return {
        flashElement(target: Element | string, durationMs?: number) {
          flashElementImpl(target, durationMs);
        },
        onFlash(handler) {
          return channel.on('ui.flash', (env) => {
            handler({
              surfaceId: env.surfaceId,
              actionId: env.actionId,
              selector: env.selector,
              durationMs: env.durationMs ?? FX_DEFAULT_MS,
              cause: env.cause,
            });
          });
        },
      };
    })(),

    close() { channel.close(); },
  };
}
