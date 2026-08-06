// Editor-facts publisher — the studio-owned producer that feeds the interface
// footer's Events / Diagnostics panels over the shared cross-app bus.
//
// interface never imports the editor realm; studio (the product assembler)
// republishes flat view models with `retain: true`, so a footer panel mounted
// at any time immediately gets the latest snapshot. This is the data plane of
// ADR-0030 §4 kept decoupled: owner broadcasts read-only truth, panels are dumb
// subscribers.
//
// TWO SOURCES, deliberately different:
//   - Diagnostics FACTS (engine/project/scene/assets) come from the PUBLIC
//     editor transport client (discover / query / assetSnapshot), 5s poll.
//   - Events RUNS are the *precise `gateway.dispatch(...)` execution log* — the
//     same Gateway OperationRunRegistry the in-editor Operation Center reads.
//     The gateway is an in-process editor-core singleton (single-realm studio),
//     so we subscribe it directly through the `@forgeax/editor/bridge` facade
//     (a legal `@forgeax/editor/*` entry, same one carrier.ts uses) and push
//     each snapshot to the bus. transport `run.list` is a SEPARATE journal that
//     human dispatches never touch, so it's intentionally not used for events.

import { publish, clearRetained } from '@forgeax/interface/lib/bus';
import {
  EDITOR_FACTS_TOPIC,
  EDITOR_RUNS_TOPIC,
  type EditorFacts,
  type GatewayRun,
} from '@forgeax/interface/lib/editor-facts-bus';
import { useShellStore } from '@forgeax/interface/store';
import { gateway } from '@forgeax/editor/bridge';
import { createEditorTransportClient, type EditorTransportClient } from './client';
import type { OperationRun, TransportResponse } from '@forgeax/editor/product';

// Register the bus topics the publisher owns. interface's own BusTopics stays
// empty (it doesn't know the editor domain); the owner declares them here.
declare module '@forgeax/interface/lib/bus' {
  interface BusTopics {
    'editor:gatewayRuns': readonly GatewayRun[];
    'editor:facts': EditorFacts;
  }
}

const POLL_MS = 5000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Unwrap `{ ok, value }` envelopes to the payload, mirroring editorRenderers. */
function resultValue(response: TransportResponse): unknown {
  const result = record(response.result);
  return result?.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')
    ? result.value
    : response.result;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface SceneReadModel {
  currentScene?: { id?: string } | null;
  scenes?: Array<{ id?: string; name?: string; isCurrent?: boolean }>;
}

function parseScene(query: TransportResponse): SceneReadModel {
  const envelope = record(resultValue(query)) ?? {};
  const document = record(envelope.document) ?? {};
  const content = str(document.content);
  if (!content) return {};
  try {
    return (JSON.parse(content) as SceneReadModel) ?? {};
  } catch {
    return {};
  }
}

function mapFacts(
  slug: string,
  discover: TransportResponse,
  query: TransportResponse,
  assets: TransportResponse,
): EditorFacts {
  const discovery = record(resultValue(discover)) ?? {};
  const runtime = record(discovery.runtime);
  const engine = runtime
    ? [str(runtime.version), str(runtime.host)].filter(Boolean).join(' · ') || '—'
    : '—';

  const scene = parseScene(query);
  const scenes = Array.isArray(scene.scenes) ? scene.scenes : [];
  const current = scenes.find((s) => s?.isCurrent);
  const sceneName = current?.name ?? current?.id ?? scene.currentScene?.id ?? '—';

  const assetEnvelope = record(resultValue(assets)) ?? {};
  const subjects = Array.isArray(assetEnvelope.subjects) ? assetEnvelope.subjects : [];

  return {
    engine,
    project: slug,
    scene: sceneName,
    assets: subjects.length,
  };
}

/**
 * Flatten Gateway OperationRuns (the precise `gateway.dispatch` log) into the
 * footer's view model. Newest-first so the Events panel shows latest on top.
 */
function mapGatewayRuns(runs: readonly OperationRun[]): readonly GatewayRun[] {
  return runs
    .map((r): GatewayRun => {
      const ts = r.completedAt ?? r.startedAt ?? r.acceptedAt ?? 0;
      const error = r.error?.message;
      return {
        runId: r.runId,
        operationId: r.operationId,
        status: r.status,
        ts,
        ...(error ? { error } : {}),
      };
    })
    .slice()
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Start the footer facts publisher. Polls the active game's editor transport
 * every 5s and republishes onto the bus. Returns a stop function. Safe to run
 * before any editor carrier is registered: transport-unavailable responses just
 * clear the retained snapshots (panels fall back to empty).
 */
export function subscribeEditorFactsPublisher(): () => void {
  let clientSlug: string | null = null;
  let client: EditorTransportClient | null = null;
  let stopped = false;

  const ensureClient = (slug: string | null): void => {
    if (slug === clientSlug) return;
    clientSlug = slug;
    client = slug
      ? createEditorTransportClient({
          allowCarrierProvisioning: false,
          scope: `game:${slug}`,
          actor: { id: 'studio-footer', kind: 'human' },
          sessionId: `studio-footer:${slug}`,
        })
      : null;
  };

  // Only facts depend on the transport carrier; gateway runs live in the
  // in-process registry and persist regardless of carrier/slug state.
  const clearFacts = (): void => {
    clearRetained(EDITOR_FACTS_TOPIC);
  };

  // Interface projects the server-owned active-game binding into the shell
  // store. Consumers must observe that projection rather than recreate a second
  // pinned/fetch fallback chain.
  const resolveSlug = (): string | null => useShellStore.getState().activeGameSlug;

  const tick = async (): Promise<void> => {
    const slug = resolveSlug();
    ensureClient(slug);
    if (!client || !slug) {
      clearFacts();
      return;
    }
    const active = client;
    const [discover, query, assets] = await Promise.all([
      active.discover(),
      active.query(),
      active.assetSnapshot(),
    ]);
    if (stopped || active !== client) return;
    // Editor realm not carried (no live gateway) → wipe stale facts.
    if (discover.error !== undefined) {
      clearFacts();
      return;
    }
    publish(EDITOR_FACTS_TOPIC, mapFacts(slug, discover, query, assets), { retain: true });
  };

  // Events: mirror the in-process Gateway run registry onto the bus. Publish the
  // current snapshot now (retained → late-mounting panels get it) and on every
  // run transition. The gateway singleton is always present in this realm; it's
  // simply empty until a `gateway.dispatch(...)` happens.
  const publishRuns = (): void => {
    if (stopped) return;
    publish(EDITOR_RUNS_TOPIC, mapGatewayRuns(gateway.operationRunSnapshot().runs), {
      retain: true,
    });
  };
  publishRuns();
  const unsubscribeRuns = gateway.subscribeOperationRuns(() => publishRuns());

  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribeRuns();
  };
}
