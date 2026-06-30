/**
 * Plugin ABI surface (Wave2 PLUGIN) — manifest + loaded model + loader, plus
 * `pluginToCapabilityPack`: the adapter that turns a `LoadedPlugin` into a C2
 * `CapabilityPack` whose single `Plugin` subscribes the plugin's hooks onto the
 * EventBus as side-effects.
 *
 * Design: a plugin's hooks (`hooksConfig`: event-name → matcher groups) are
 * wired so that, on `start`, the resulting `Plugin` subscribes to each declared
 * event on the bus. When an event of that type fires, the matching hook actions
 * are dispatched to the host via the injected `runHook` callback (the core ABI
 * itself never spawns shell commands — boundary). `start` returns a dispose that
 * tears down every subscription. This mirrors the C2 `Plugin` contract
 * (start → dispose, EventBus side-effects only).
 *
 * Boundary: only core-local relatives. No node:, no IO here.
 */
import type {
  CapabilityPack,
  Plugin,
  PluginContext,
} from '../types';
import type { CoreEvent, EventBusAPI } from '../../events/types';
import type {
  LoadedPlugin,
  PluginHookAction,
  PluginHookMatcher,
} from './loaded';

export * from './manifest';
export * from './loaded';
export * from './loader';

/**
 * Host-injected hook runner. The core ABI does not execute shell commands; it
 * hands the host the matched actions + the triggering event and lets the host
 * decide how to run them (subprocess, sandbox, etc.). Errors thrown by the
 * runner are swallowed so a bad hook can't poison bus propagation.
 */
export type HookRunner = (
  pluginName: string,
  event: CoreEvent,
  actions: PluginHookAction[],
) => void;

export interface PluginToPackOptions {
  /** Where to dispatch matched hook actions. Default: no-op (record-only). */
  runHook?: HookRunner;
}

/**
 * Build the EventBus `Plugin` that backs a LoadedPlugin's hooks.
 *
 * For each event name in `hooksConfig`, subscribe a handler that collects the
 * actions of every matching group and forwards them to `runHook`. Matching is
 * intentionally minimal at the core layer: a group with no `matcher` matches
 * any event of that type; a group with a `matcher` is forwarded as-is (the host
 * applies its permission-rule semantics). `start` returns a dispose that
 * unsubscribes all handlers.
 */
function buildHooksPlugin(
  loaded: LoadedPlugin,
  bus: EventBusAPI,
  runHook: HookRunner,
): Plugin {
  const config = loaded.hooksConfig ?? {};
  return {
    name: loaded.name,
    start(_ctx: PluginContext) {
      const unsubs: Array<() => void> = [];
      for (const [eventType, groups] of Object.entries(config)) {
        const unsub = bus.subscribe(eventType, (event) => {
          const actions = collectActions(groups);
          if (actions.length === 0) return;
          try {
            runHook(loaded.name, event, actions);
          } catch {
            // fail-soft: a throwing hook runner must not break bus propagation
          }
        });
        unsubs.push(unsub);
      }
      return () => {
        for (const u of unsubs) u();
      };
    },
  };
}

/** Flatten the actions of every matcher group (matcher filtering is host-side). */
function collectActions(groups: PluginHookMatcher[]): PluginHookAction[] {
  const out: PluginHookAction[] = [];
  for (const g of groups) {
    for (const a of g.hooks) out.push(a);
  }
  return out;
}

/**
 * Convert a LoadedPlugin into a C2 CapabilityPack.
 *
 * The pack's `layer` is derived from the plugin source:
 *   builtin → 'builtin', marketplace → 'user', session → 'session'
 * (agent-layer packs are not produced from plugins). When the plugin declares
 * no hooks, no `Plugin` is attached (the pack carries only its identity +
 * component paths via the LoadedPlugin the caller already holds). Commands /
 * agents / skills / output-styles are surfaced to the host through the
 * LoadedPlugin's `*Path` fields, not as core `tools`/`slots` — those are
 * higher-layer concerns.
 */
export function pluginToCapabilityPack(
  loaded: LoadedPlugin,
  bus: EventBusAPI,
  opts: PluginToPackOptions = {},
): CapabilityPack {
  const runHook: HookRunner = opts.runHook ?? (() => {});
  const hasHooks =
    loaded.hooksConfig !== undefined &&
    Object.keys(loaded.hooksConfig).length > 0;

  const layer =
    loaded.source === 'builtin'
      ? 'builtin'
      : loaded.source === 'marketplace'
        ? 'user'
        : 'session';

  return {
    name: loaded.name,
    layer,
    ...(hasHooks
      ? { plugins: [buildHooksPlugin(loaded, bus, runHook)] }
      : {}),
  };
}
