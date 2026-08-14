// Editor panel renderers — the studio aggregation layer's wiring of the
// editor app into the interface shell's PanelRenderers injection point.
//
// This is where the studio→editor edge legally lives (studio aggregates
// interface + apps). interface itself stays editor-agnostic; studio supplies
// the real edit/play surfaces here and feeds them to <App panelRenderers>.
//
// Single-realm (feat-20260703): the editor engine boots IN-PROCESS in this
// studio host window — the viewport and every ep:* editor panel are
// in-process React components, NOT a /editor iframe. Studio's vite.config.ts
// head comment locks this in ("editor viewport + ep:* panels are now in-process
// React components ... not a /editor iframe"); this file is the concrete wiring.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useShellStore } from '@forgeax/interface/store';
import type { RuntimeAssetBinding, RuntimeScopeState } from '@forgeax/interface/store';
import { useTranslation } from '@forgeax/interface/i18n';
import type { PanelRenderers, PanelDescriptor } from '@forgeax/interface/components/DockShell/panelRenderers';
import {
  createEditorPanelContributionsExtension,
  createEditorPageExtension,
  installInterfaceBridge,
  setContextMenuRenderer,
  panelBridge,
  gateway,
  hasPendingDiskSave,
  bindViewportRuntimeClient,
} from '@forgeax/editor/bridge';
import {
  createBroadcastViewportRuntimeClient,
  subscribeBroadcastViewportRuntimeReady,
} from '@forgeax/editor/viewport-runtime';
import type {
  MessagePortTransportClient,
  ViewportRuntimeIdentity,
} from '@forgeax/editor/viewport-runtime';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from '@forgeax/editor/default-dock-layout';
// ViewportComponent (the in-process edit surface) + resetEditRealm (active-game
// teardown) come from the editor facade's ./viewport subpath; EDITOR_PANEL_COMPONENTS
// maps ep:<id> → the panel's React component. Mirrors packages/editor/
// standalone/main.tsx (the standalone editor shell that first landed this).
import { ViewportComponent, resetEditRealm } from '@forgeax/editor/viewport';
// Host-injected preview viewports (material / mesh / vfx): without these the
// preview panels render their "not registered by the host" placeholder.
// Mirrors packages/editor/apps/standalone/main.tsx through the facade subpath.
import { registerEditorPreviewViewports } from '@forgeax/editor/previews';
import { EDITOR_PANELS, EDITOR_PANEL_COMPONENTS } from '@forgeax/editor/panels';
import { EditorOverlayProvider } from '@forgeax/editor/ui/overlays';
// studio→chat is a legal aggregation edge (studio composes interface + apps).
// interface stays chat-agnostic (no @forgeax/chat import); studio injects the
// chat surface here through the panels.chat descriptor, exactly like edit/preview.
import { ChatPanel } from '@forgeax/chat';
// studio→dashboard / studio→settings are legal aggregation edges too. interface
// stays dashboard/settings-agnostic; studio injects the overlay bodies here via
// the overlays.Dashboard / overlays.Settings slots, exactly like chat/edit/preview.
import { Dashboard } from '@forgeax/dashboard';
import { SettingsPanel, SettingsSectionsRegister } from '@forgeax/settings';
// studio→workbench is a legal aggregation edge. interface stays workbench-UI
// agnostic (the plugin-host runtime stays L1); studio injects the workbench
// main-area body here via slots.MainAreaBody + detached.AgentsBrowser/FilesBrowser.
import { WorkbenchMode, WorkbenchModeDefault, AgentsMainArea, AgentsPanel, WorkbenchAgentPicker, activateFile } from '@forgeax/ai-workbench';
// studio→marketplace is a legal edge at this aggregation layer. interface holds
// no specific plugin id; studio derives the inline panel map from manifests
// (ADR 0025 M4) — see deriveInlineWorkbenchPanels below.
// studio→host-sdk is legal here too. interface imports these as TYPES only and
// receives the runtime factories through the PanelRenderers injection.
import { createExtensionPort, createWindowTransport } from '@forgeax/host-sdk';
// ADR 0025 M1: studio assembles the shell by handing <App> a list of
// AppExtension manifests (overrides.extensions) instead of a monolithic
// PanelRenderers object. The factories below are interface's built-in
// extension wrappers; studio.editor-integration carries the leftover fields
// no factory covers (workbench layout seed / editor bridge / host-sdk ports).
import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { createPanelsEditorExtension } from '@forgeax/interface/core/extensions/panels-editor';
// D4 第一批(ADR 0025 / ADR 0027,双基座 Day 9):dashboard/settings 不再走
// 工厂注入,改由统一 manifest(forgeax-extension.json 语法)经 v9 适配器装载。
import { appExtensionFromManifest } from '@forgeax/interface/core/app-shell/manifest-adapter';
import { createDetachedAgentsBrowserExtension } from '@forgeax/interface/core/extensions/detached-agents-browser';
import { createDetachedFilesBrowserExtension } from '@forgeax/interface/core/extensions/detached-files-browser';
import { createPanelsWorkbenchInlineExtension } from '@forgeax/interface/core/extensions/panels-workbench-plugins';
import type {
  ActivityRegistration,
  PanelRenderContext,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResourceEditorRegistration,
} from '@forgeax/interface/core/page-platform';
import { createEditorTransportClient } from '../editor-product/client';
import {
  connectStudioEditorTransport,
  executeStudioAssetImportSource,
  studioEditorTransportRole,
} from '../editor-product/carrier';
import { type TransportResponse } from '@forgeax/editor/product';
import { installEditRealmPageLifecycle } from './editRealmPageLifecycle';

// Module-scope host injection (same contract as standalone main.tsx): the
// preview panels read their slots at render time, so registration must happen
// before any panel mounts.
registerEditorPreviewViewports();

export interface ProjectionTransientState {
  readonly panelId: string;
  readonly layoutId: string;
  readonly timerPending: boolean;
  readonly hmrActive: boolean;
}

export interface EditorRenderFactsInput {
  readonly discover: TransportResponse;
  readonly document: TransportResponse;
  readonly assets: TransportResponse;
  readonly run?: TransportResponse;
  readonly transient?: ProjectionTransientState;
}

export interface EditorRenderFacts {
  readonly status: 'ready' | 'unavailable';
  readonly document: { readonly revision: string | null; readonly content: unknown };
  readonly assets: { readonly revision: string | null; readonly importedSubjectIds: readonly string[] };
  readonly run: { readonly id: string | null; readonly status: string | null; readonly revision: string | null } | null;
  readonly gatewayOperations: readonly string[];
  readonly errors: readonly { readonly code: string; readonly recoveryActions: readonly string[] }[];
  readonly transient: ProjectionTransientState | null;
}

export const EDIT_REALM_READ_WRITE_CLASSIFICATION = Object.freeze({
  document: Object.freeze({
    owner: 'Editor product',
    category: 'canonical-fact',
    evidence: 'query response revision and content are rendered without a local document store',
  }),
  assets: Object.freeze({
    owner: 'Editor product AssetWorkspace',
    category: 'canonical-fact',
    evidence: 'asset.snapshot resourceRevision and subject ids are rendered without a local asset catalog',
  }),
  runs: Object.freeze({
    owner: 'Editor product RunJournal',
    category: 'canonical-fact',
    evidence: 'run.list is projected only when the typed response contains a run record',
  }),
  gatewayOperations: Object.freeze({
    owner: 'Editor Gateway capability registry',
    category: 'canonical-fact',
    evidence: 'discover publishes the registered Gateway operations; no runtime alias is projected',
  }),
  activeSlug: Object.freeze({
    owner: 'Studio workbench active-game route',
    category: 'derived-projection',
    evidence: 'useActiveSlug validates the route against the server game list before mounting the realm',
  }),
  panelLayout: Object.freeze({
    owner: 'Studio interface shell',
    category: 'ui-session-transient',
    evidence: 'dock layout and panel selection remain in the existing shell contribution path',
  }),
  timerAndViewportEpoch: Object.freeze({
    owner: 'Studio EditRealm',
    category: 'ui-session-transient',
    evidence: 'debounce, remount epoch, and display restoration only control local presentation timing',
  }),
  hmrAndDiskWatch: Object.freeze({
    owner: 'Studio EditRealm compatibility bridge',
    category: 'ui-session-transient',
    evidence: 'HMR and disk-watch events retain existing restart behavior and do not update canonical facts',
  }),
  hostTools: Object.freeze({
    owner: 'Studio/server host tools',
    category: 'legacy-writer',
    evidence: 'no host-tool writer is changed or deleted in M4; M5 red tests own its removal decision',
  }),
  evalRelay: Object.freeze({
    owner: 'Studio/server compatibility relay',
    category: 'legacy-writer',
    evidence: 'M4 emits no eval request and leaves executable relay deletion to M5 after parity gates',
  }),
} as const);

function projectionRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function projectionResult(response: TransportResponse): unknown {
  const result = projectionRecord(response.result);
  return result?.ok === true && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : response.result;
}

function projectionErrors(response: TransportResponse): { readonly code: string; readonly recoveryActions: readonly string[] }[] {
  return response.error === undefined ? [] : [{ code: response.error.code, recoveryActions: response.error.recoveryActions }];
}

/** Derive the panel read model from public transport responses and UI transient input. */
export function projectEditorRenderFacts(input: EditorRenderFactsInput): EditorRenderFacts {
  const documentEnvelope = projectionRecord(projectionResult(input.document)) ?? {};
  const document = projectionRecord(documentEnvelope.document) ?? documentEnvelope;
  const assets = projectionRecord(projectionResult(input.assets)) ?? {};
  const runValue = input.run === undefined ? undefined : projectionRecord(projectionResult(input.run));
  const discovery = projectionRecord(projectionResult(input.discover)) ?? {};
  const capabilityManifest = projectionRecord(discovery.capabilityManifest);
  const capabilities = Array.isArray(capabilityManifest?.capabilities) ? capabilityManifest.capabilities : [];
  const gatewayOperations = capabilities.flatMap((entry) => {
    const value = projectionRecord(entry);
    if (typeof value?.verb === 'string') return [value.verb];
    if (typeof value?.id === 'string' && value.id.startsWith('editor.')) return [value.id.slice('editor.'.length)];
    return [];
  });
  const subjects = Array.isArray(assets.subjects) ? assets.subjects : [];
  const importedSubjectIds = subjects.flatMap((subject) => {
    const value = projectionRecord(subject)?.id;
    return typeof value === 'string' ? [value] : [];
  });
  const errors = [input.discover, input.document, input.assets, ...(input.run === undefined ? [] : [input.run])].flatMap(projectionErrors);

  return Object.freeze({
    status: errors.length === 0 ? 'ready' : 'unavailable',
    document: Object.freeze({
      revision: typeof document.revision === 'string' ? document.revision : null,
      content: document.content,
    }),
    assets: Object.freeze({
      revision: typeof assets.resourceRevision === 'string' ? assets.resourceRevision : typeof assets.revision === 'string' ? assets.revision : null,
      importedSubjectIds: Object.freeze(importedSubjectIds),
    }),
    run: runValue === undefined ? null : Object.freeze({
      id: typeof input.run?.runId === 'string' ? input.run.runId : typeof runValue.runId === 'string' ? runValue.runId : null,
      status: typeof runValue.status === 'string' ? runValue.status : null,
      revision: typeof runValue.revision === 'string' ? runValue.revision : null,
    }),
    gatewayOperations: Object.freeze(gatewayOperations),
    errors: Object.freeze(errors),
    transient: input.transient === undefined ? null : Object.freeze({ ...input.transient }),
  });
}

// Normal Studio pages derive from the server-authoritative active game. A
// managed runtime carrier has a separate, immutable scope proven by its runtime
// identity; an arbitrary `?gameId=` is never a page-local active-game override.
function useActiveSlug(): string | null {
  const activeGameSlug = useShellStore((s) => s.activeGameSlug);
  const params = new URLSearchParams(window.location.search);
  const managedCarrier = params.has('runtimeId') && params.has('ownershipChallenge');
  return managedCarrier ? (params.get('gameId') ?? activeGameSlug) : activeGameSlug;
}

// Studio owns its on-disk game layout (`.forgeax/games/<slug>`, matching the
// server's safe-path whitelist). The editor holds ZERO layout convention, so
// the host passes the game root to ViewportComponent as a prop.
function studioGameRoot(slug: string): string {
  return `.forgeax/games/${slug}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseWithLatestRun(
  response: Awaited<ReturnType<ReturnType<typeof createEditorTransportClient>['listRuns']>>,
): Awaited<ReturnType<ReturnType<typeof createEditorTransportClient>['listRuns']>> | undefined {
  const result = objectRecord(response.result);
  const first = Array.isArray(result?.items) ? objectRecord(result.items[0]) : undefined;
  if (first === undefined) return undefined;
  return {
    ...response,
    ...(typeof first.runId === 'string' ? { runId: first.runId } : {}),
    result: first,
  };
}

/**
 * Canonical Editor facts are a read projection. This component never dispatches
 * a runtime operation, so opening Studio cannot create a carrier or renderer.
 * Loading and unavailable states expose structured recovery codes instead of
 * guessing from an error message.
 */
function EditorCanonicalProjection({ slug }: { readonly slug: string | null }): ReactNode {
  const [facts, setFacts] = useState<EditorRenderFacts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const client = createEditorTransportClient({
      allowCarrierProvisioning: false,
      scope: `game:${slug}`,
      actor: { id: 'studio-ui', kind: 'human' },
      sessionId: `studio-ui:${slug}`,
    });
    const load = async (): Promise<void> => {
      const [discover, document, assets, runs] = await Promise.all([
        client.discover(),
        client.query({ documentId: 'scene:main' }),
        client.assetSnapshot(),
        client.listRuns(),
      ]);
      if (cancelled) return;
      const transient: ProjectionTransientState = {
        panelId: 'editor',
        layoutId: 'scene',
        timerPending: false,
        hmrActive: import.meta.hot !== undefined,
      };
      const nextFacts = projectEditorRenderFacts({
        discover,
        document,
        assets,
        run: responseWithLatestRun(runs),
        transient,
      });
      setFacts(nextFacts);
      setLoadError(null);
    };
    void load().catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : 'transport request failed');
    });
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [slug]);

  const status = facts?.status ?? 'loading';
  const recoveryActions = facts?.errors.flatMap((error) => error.recoveryActions) ?? [];
  const importedAssets = facts?.assets.importedSubjectIds.join(',') || 'none';
  const playAvailability = facts?.gatewayOperations.includes('play') ? 'available' : 'unavailable';
  const documentContent = typeof facts?.document.content === 'string' ? facts.document.content : 'unavailable';
  const documentRevision = facts?.document.revision ?? 'unavailable';
  const assetRevision = facts?.assets.revision ?? 'unavailable';
  const runStatus = facts?.run?.status ?? 'none';

  return (
    <div
      // This is a machine-readable parity seam, not a user-facing viewport overlay.
      data-testid="studio-editor-canonical-projection"
      data-forgeax-canonical-facts="true"
      data-scope={slug ? `game:${slug}` : 'unavailable'}
      data-projection-status={loadError === null ? status : 'unavailable'}
      data-document-revision={documentRevision}
      data-document-content={documentContent}
      data-asset-revision={assetRevision}
      data-imported-assets={importedAssets}
      data-run-status={runStatus}
      data-gateway-play-availability={playAvailability}
      data-recovery-actions={recoveryActions.join(',') || (loadError === null ? 'none' : 'request.retry')}
      style={{ display: 'none' }}
    />
  );
}

type ViewportDisplay = 'scene' | 'game';

function readViewportDisplay(): ViewportDisplay | null {
  const editor = (window as unknown as {
    __forgeax_editor?: { getViewportQuadrant?: () => { display?: unknown } };
  }).__forgeax_editor;
  const display = editor?.getViewportQuadrant?.().display;
  return display === 'scene' || display === 'game' ? display : null;
}

function dispatchEditorViewportRuntime(operation: 'play' | 'stop' | 'show-scene'): void {
  if (operation === 'play') {
    gateway.dispatch({ kind: 'play' }, 'human');
  } else if (operation === 'stop') {
    gateway.dispatch({ kind: 'stop' }, 'human');
  } else {
    gateway.dispatch({ kind: 'setDisplay', display: 'scene' }, 'human');
  }
}

/** Keep shell panels attached to the one popup/Tauri Runtime generation. */
function ViewportRuntimeWindowBridge() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('runtimeId') && params.has('runtimeGeneration')) return;

    let currentKey: string | null = null;
    let client: MessagePortTransportClient | null = null;
    let unbind: (() => void) | null = null;
    const disconnect = (): void => {
      unbind?.();
      unbind = null;
      client?.dispose();
      client = null;
      currentKey = null;
    };
    const connect = (runtime: ViewportRuntimeIdentity): void => {
      if (runtime.carrierKind !== 'browser-page' && runtime.carrierKind !== 'tauri-webview') return;
      const key = `${runtime.runtimeId}:${runtime.runtimeGeneration}:${runtime.carrierId}`;
      if (key === currentKey) return;
      disconnect();
      client = createBroadcastViewportRuntimeClient({ runtime });
      unbind = bindViewportRuntimeClient(runtime, client);
      currentKey = key;
    };
    const unsubscribe = subscribeBroadcastViewportRuntimeReady(connect);
    return () => {
      unsubscribe();
      disconnect();
    };
  }, []);
  return null;
}

// EditRealm — the in-process editor viewport surface (single realm). It owns
// the studio-only multi-game orchestration:
//   - resolve the active slug (managed carrier scope or server active-game projection,
//     validated against the live game list),
//   - pass the active game to ViewportComponent as props (NOT `?scene=`/
//     `?gameRoot=` URL params — the single realm removed the editor iframe those
//     addressed, so the props are the one source and can't drift from a stale URL),
//   - on a CROSS-GAME switch, tear the engine realm down (resetEditRealm:
//     releases the WebGPU device + resets the single-boot latch) and remount a
//     fresh <ViewportComponent key={slug}> so the new game boots clean (physics
//     backend + pack roots bind once at createApp, so a switch can't hot-swap).
// PanelShell owns all operation chrome; this component is always the pure
// renderer surface regardless of whether its panel is docked or detached.
function EditRealm() {
  const slug = useActiveSlug();
  const runtimeState = useShellStore((s) => s.activeGameRuntime);
  const runtimeBinding: RuntimeAssetBinding | undefined = (
    runtimeState.status === 'ready' || runtimeState.status === 'degraded'
  ) ? runtimeState.binding : undefined;
  const realmKey = slug !== null && runtimeBinding !== undefined
    ? `${slug}:${runtimeBinding.scopeId}:${runtimeBinding.generation}`
    : null;
  const transportRole = studioEditorTransportRole(window.location.search);
  const [carrierReadySlug, setCarrierReadySlug] = useState<string | null>(null);

  // Interface emits this synchronously before it removes the docked carrier.
  // Flush any dirty scene through the existing beacon seam, then release the
  // sole WebGPU/World lease before the popup or Tauri WebView starts.
  useEffect(() => {
    const onWillDetach = (): void => resetEditRealm({ flushPendingSave: true });
    window.addEventListener('forgeax:viewport-carrier-will-detach', onWillDetach);
    return () => window.removeEventListener('forgeax:viewport-carrier-will-detach', onWillDetach);
  }, []);

  // A reload creates a new in-process Editor and therefore a new WebGPU device.
  // Dispose the old realm synchronously during the navigation so Chromium never
  // has to overlap both devices. BFCache navigation is deliberately excluded:
  // its React tree will resume without remounting this component.
  useEffect(() => installEditRealmPageLifecycle(window, resetEditRealm), []);

  // Register this same in-process Editor realm as the typed AI/server carrier.
  // The page owns Gateway and the live World; the socket only carries the
  // versioned Editor transport and is torn down with the realm. The canonical
  // projection is mounted only after the hello/ready handshake; child passive
  // effects run before parent effects, so mounting it eagerly would issue four
  // requests before this carrier exists (eight under development StrictMode).
  useEffect(() => {
    if (!slug || runtimeBinding === undefined) {
      setCarrierReadySlug(null);
      return undefined;
    }
    let active = true;
    setCarrierReadySlug(null);
    const carrier = connectStudioEditorTransport(slug, { role: transportRole });
    void carrier.ready.then(() => {
      if (active) setCarrierReadySlug(slug);
    });
    return () => {
      active = false;
      carrier.dispose();
    };
  }, [slug, runtimeBinding?.scopeId, runtimeBinding?.generation, transportRole]);

  // `bootedRealmKey` is the exact slug+scope+generation currently mounted.
  // A slug alone is not an asset identity and can never authorize a remount.
  const [bootedRealmKey, setBootedRealmKey] = useState<string | null>(null);

  /**
   * EditRealm classification for the M4 projection boundary:
   * - canonical facts: document, asset, run, and runtime availability are
   *   fetched by EditorCanonicalProjection from the public transport client;
   * - derived projection: bootedSlug and viewportEpoch select the one mounted
   *   Editor realm for the active game;
   * - UI/session transient: timers, pendingAssetReload, display restoration,
   *   panelBridge HMR notifications, and gateway display mode stay local;
   * - legacy writer: gateway and panelBridge remain the in-process UI
   *   compatibility surfaces; AI/server access uses the typed carrier above and
   *   adds no executable eval relay.
   */
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const playRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetReloadToken = useRef(0);
  const pendingAssetReload = useRef<{
    token: number;
    resumePlay: boolean;
    display: ViewportDisplay | null;
  } | null>(null);
  const displayRestoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (bootedRealmKey === realmKey) return;
    // Active-game switch (or first boot). On a real switch, destroy the previous
    // engine realm BEFORE remounting, so the old WebGPU device is released and the
    // boot latch is clear for the new game. First boot (null) has nothing to tear
    // down.
    if (bootedRealmKey !== null) {
      pendingAssetReload.current = null;
      assetReloadToken.current += 1;
      resetEditRealm();
    }
    setBootedRealmKey(realmKey);
  }, [bootedRealmKey, realmKey]);

  useEffect(() => {
    if (!slug || !import.meta.hot) return;
    const onGameCodeChange = (data: { file?: string }): void => {
      const file = (data.file ?? '').replace(/\\/g, '/');
      if (!file.includes(`/.forgeax/games/${slug}/`)) return;
      if (gateway.mode !== 'play') return;
      if (playRestartTimer.current !== null) clearTimeout(playRestartTimer.current);
      playRestartTimer.current = setTimeout(() => {
        playRestartTimer.current = null;
        dispatchEditorViewportRuntime('stop');
        queueMicrotask(() => dispatchEditorViewportRuntime('play'));
      }, 80);
    };
    import.meta.hot.on('forgeax:game-code-change', onGameCodeChange);
    return () => {
      if (playRestartTimer.current !== null) {
        clearTimeout(playRestartTimer.current);
        playRestartTimer.current = null;
      }
      import.meta.hot?.off('forgeax:game-code-change', onGameCodeChange);
    };
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    const off = panelBridge.on('assetsChanged', ({ hint, source }) => {
      if (source !== 'disk-watch') return;
      if (hint === 'directory-only') return;
      if (assetRefreshTimer.current !== null) clearTimeout(assetRefreshTimer.current);
      assetRefreshTimer.current = setTimeout(() => {
        assetRefreshTimer.current = null;
        const shouldResumePlay = gateway.mode === 'play' || gateway.playPhase === 'starting';
        // bug-fix (导入资产刷新场景丢改动): a disk-watch asset change (an import
        // just wrote source bytes + .meta.json) previously ALWAYS tore down the
        // edit realm + remounted the viewport, which re-runs loadDocFromDisk()
        // and replaces gateway.doc.world with the last-SAVED disk scene —
        // silently destroying the user's unsaved in-memory edits. That remount
        // is only truly needed to restart a running game so it picks up new
        // bytes; in pure EDIT mode the imported asset is already made available
        // by installAssetCatalogRefresh (registry.refreshCatalog on this very
        // assetsChanged), so the reset is redundant AND destructive when there
        // are unsaved edits. Skip it: keep the live scene, the asset still shows
        // up via the catalog refresh + Content Browser.
        if (!shouldResumePlay && hasPendingDiskSave()) return;
        const token = assetReloadToken.current + 1;
        assetReloadToken.current = token;
        pendingAssetReload.current = {
          token,
          resumePlay: shouldResumePlay,
          display: shouldResumePlay ? readViewportDisplay() : null,
        };
        if (shouldResumePlay) dispatchEditorViewportRuntime('stop');
        resetEditRealm({ flushPendingSave: false });
        setViewportEpoch((epoch) => epoch + 1);
      }, 120);
    });
    return () => {
      off();
      if (assetRefreshTimer.current !== null) {
        clearTimeout(assetRefreshTimer.current);
        assetRefreshTimer.current = null;
      }
      if (displayRestoreTimer.current !== null) {
        clearTimeout(displayRestoreTimer.current);
        displayRestoreTimer.current = null;
      }
    };
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    const off = panelBridge.on('editorHealth', (event) => {
      const message = event.message ?? '';
      const pending = pendingAssetReload.current;
      if (!pending?.resumePlay) return;
      if (!/boot ✓|ready|input ▸ game input chain live/.test(message)) return;
      pendingAssetReload.current = null;
      queueMicrotask(() => {
        if (pending.token !== assetReloadToken.current) return;
        if (gateway.mode !== 'play') dispatchEditorViewportRuntime('play');
        if (pending.display !== 'scene') return;
        let attempts = 0;
        const restoreDisplay = (): void => {
          if (pending.token !== assetReloadToken.current) return;
          if (gateway.playPhase === 'play') {
            dispatchEditorViewportRuntime('show-scene');
            return;
          }
          if (gateway.playPhase === 'failed') return;
          if (attempts++ >= 120) return;
          displayRestoreTimer.current = setTimeout(restoreDisplay, 16);
        };
        restoreDisplay();
      });
    });
    return () => {
      off();
      pendingAssetReload.current = null;
      assetReloadToken.current += 1;
      if (displayRestoreTimer.current !== null) {
        clearTimeout(displayRestoreTimer.current);
        displayRestoreTimer.current = null;
      }
    };
  }, [slug]);

  // The viewport is only mounted once bootedSlug has caught up with slug (the
  // pre-mount resetEditRealm ran). During that gap — and while the freshly
  // mounted engine boots + streams the game's assets — we overlay a loading
  // surface so a heavy game (e.g. hellforge, ~1.3GB of meshes) never presents as
  // a silent blank viewport with "所有接口 pending 但页面没提示" (the bug this fixes).
  const mounted = realmKey !== null && bootedRealmKey === realmKey;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#16161a' }}>
      <EditorCanonicalProjection slug={carrierReadySlug === slug ? slug : null} />
      {mounted && (
        // key={realmKey} forces a fresh mount per binding; the pre-mount resetEditRealm
        // above guarantees the latch is clear so ViewportComponent actually re-boots.
        // The game and scoped URLs are passed as props — the engine boot reads
        // them there, not from a slug-selected URL.
        <ViewportComponent
          key={`${realmKey}:${viewportEpoch}`}
          gameSlug={slug!}
          gameRoot={studioGameRoot(slug!)}
          runtimeBinding={runtimeBinding}
        />
      )}
      {/* Keyed by slug/epoch so it resets boot-progress on game switches and asset-driven remounts. */}
      <ViewportBootOverlay
        key={`overlay:${realmKey ?? '_unbound'}:${viewportEpoch}`}
        slug={slug}
        runtimeState={runtimeState}
      />
    </div>
  );
}

// ── Viewport boot/loading overlay ─────────────────────────────────────────────
// Sits on top of the in-process engine viewport and shows a spinner + live boot
// stage while a game switch tears down/re-boots the engine realm and streams the
// new game's boot, then gets out of the engine's way. It hides the moment the
// engine reports "boot ✓ ready" — i.e. the render loop is live and the scene
// entities are spawned. Meshes/textures keep streaming in AFTER that (loadByGuid
// is async, ungated by boot), and the engine renders them progressively (ground
// first, then meshes, then textures pop in). That progressive fill is the engine
// doing its job, NOT an unfinished error state to mask — so the overlay's only
// job is to cover the pre-render blank, not to wait for "all assets settled".
//
// (History: this used to also wait for the asset-loading network to go "quiet"
// via a heuristic that sniffed fetch URLs. That was unsound — it guessed which
// requests were assets from a hand-maintained path/extension list, and the list
// drifted: it missed the shell's ~1s API pollers, which kept resetting the quiet
// timer forever, trapping the overlay on "正在加载游戏…" until a 90s cap even for
// a trivial game. The engine exposes no authoritative "assets settled" signal,
// so rather than sniff for one, we drop the overlay at boot ✓ ready — the one
// authoritative signal the engine DOES emit — and let the render loop show the
// progressive load.)
//
// Purely presentational — it reads editor boot breadcrumbs off the in-process
// panelBridge (editorHealth), never mutating state.
function ViewportBootOverlay({ slug, runtimeState }: { slug: string | null; runtimeState: RuntimeScopeState }): ReactNode {
  const { i18n } = useTranslation();
  const zh = i18n.language === 'zh';
  const [visible, setVisible] = useState(true);
  const [stage, setStage] = useState<string>(zh ? '正在启动引擎…' : 'Starting engine…');

  useEffect(() => {
    if (!slug) return; // no game resolved yet — keep the neutral "loading" state
    let disposed = false;
    const finish = (): void => {
      if (disposed) return;
      disposed = true;
      setVisible(false);
    };

    const offHealth = panelBridge.on('editorHealth', (e) => {
      const m = e.message ?? '';
      // A hard engine error paints its own diagnostic overlay — get out of its way.
      if (e.level === 'error') { finish(); return; }
      if (/createApp/.test(m)) setStage(zh ? '初始化渲染器…' : 'Initializing renderer…');
      else if (/plugins/.test(m)) setStage(zh ? '加载游戏插件…' : 'Loading game plugins…');
      else if (/scene/.test(m)) setStage(zh ? '加载场景资源…' : 'Loading scene…');
      // boot ✓ ready = render loop live + scene entities spawned. Drop the overlay
      // now; remaining meshes/textures fill in progressively on-screen.
      if (/boot ✓|ready|input ▸ game input chain live/.test(m)) finish();
    });

    return () => {
      disposed = true;
      offHealth();
    };
  }, [slug, zh]);

  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 5,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, background: '#16161a', color: '#c9c9d4', pointerEvents: 'none',
        font: '13px/1.5 system-ui, -apple-system, sans-serif',
      }}
      data-testid="studio-editor-viewport-boot-overlay"
      data-forgeax-viewport-boot-state="loading"
    >
      <div
        style={{
          width: 34, height: 34, borderRadius: '50%',
          border: '3px solid rgba(255,255,255,0.14)', borderTopColor: '#7aa2ff',
          animation: 'fx-viewport-spin 0.9s linear infinite',
        }}
      />
      <div style={{ fontSize: 14, color: '#e7e7ef' }}>
        {runtimeState.status === 'unavailable'
          ? (zh ? '当前游戏运行时不可用' : 'The active game runtime is unavailable')
          : runtimeState.status === 'unbound' || runtimeState.status === 'transitioning'
            ? (zh ? '正在绑定当前游戏运行时…' : 'Binding the active game runtime…')
            : slug
          ? (zh ? `正在加载游戏 “${slug}”…` : `Loading game “${slug}”…`)
          : (zh ? '加载中…' : 'Loading…')}
      </div>
      <div style={{ opacity: 0.7 }}>{stage}</div>
      <div style={{ opacity: 0.45, fontSize: 12, maxWidth: 360, textAlign: 'center' }}>
        {zh
          ? '大型游戏包含大量模型/贴图，首次加载可能需要一些时间。'
          : 'Large games ship many meshes/textures; the first load can take a while.'}
      </div>
      <style>{'@keyframes fx-viewport-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

// The in-process body for a single ep:* editor panel. Resolves the panel's
// React component from EDITOR_PANEL_COMPONENTS (editor-panels SSOT); an
// unavailable component falls back to a neutral placeholder. Mirrors
// packages/editor/standalone/main.tsx. The panels read the
// in-process @forgeax/editor-core store (same realm as ViewportComponent), so
// no extra Provider is needed beyond the shell's PanelRenderersProvider +
// <ContextMenu/> (both already mounted by interface App.tsx).
function EditorPanelBody({ id }: { id: string }): ReactNode {
  const Comp = EDITOR_PANEL_COMPONENTS[id];
  if (Comp) return <Comp />;
  return (
    <div className="surface-placeholder" data-panel={id} data-panel-unmounted="1">
      <div className="surface-placeholder-title">Panel not mounted</div>
    </div>
  );
}

// 2026-06-30 merged preview/edit into a single viewport; the standalone
// PreviewMode component (mounting <PlaySurface slug={slug} />) is retired.
// The surviving surface is EditRealm above, which switches between edit-time
// gizmos and play-time simulation on the same in-process engine.

const EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
};

// Build the panels registry: one entry per EDITOR_PANELS id + chat + agents.
// EDITOR_PANELS is the SSOT for editor panel ids (imported from @forgeax/editor/panels).
// Each descriptor bakes in the title from EDITOR_PANEL_TITLES + a stable order.
const editorPanels: Record<string, PanelDescriptor> = Object.fromEntries(
  EDITOR_PANELS.map((id, i) => [id, {
    title: id === 'assets' ? 'Content Browser' : (EDITOR_PANEL_TITLES[id] ?? id),
    order: 100 + i,
    ...(id === 'assets'
      ? {
          content: { padding: 'none' as const, scroll: 'none' as const, tone: 'tool' as const },
        }
      : id === 'hierarchy'
        ? {
            header: { visible: true, showTitle: false },
            content: { padding: 'none' as const, scroll: 'none' as const, tone: 'tool' as const },
          }
      : {}),
    render: () => <EditorPanelBody id={id} />,
  }]),
);

// Named ComponentType wrappers for multi-child injections. Keeping these at
// module scope (not inline lambdas) means React reconciles them by identity
// across renders — no accidental re-mounts of the child tree — and React
// DevTools shows meaningful component names in the tree.
function SettingsInjection(): ReactNode {
  return (
    <>
      <SettingsSectionsRegister />
      <SettingsPanel />
    </>
  );
}

function WorkbenchAgents(): ReactNode {
  return <AgentsMainArea />;
}

function WorkbenchFiles(): ReactNode {
  return <WorkbenchModeDefault showGalleryWhenEmpty={false} />;
}

function FileResourcePanel({ pageKey }: Pick<PanelRenderContext, 'pageKey'>): ReactNode {
  useEffect(() => {
    if (pageKey.cardinality === 'resource') activateFile(pageKey.resourceId);
  }, [pageKey]);
  return <WorkbenchFiles />;
}

/** Dockview requires the serialized root to be a branch, even when a Page owns
 * exactly one placement. Keep that transport detail in one factory so built-in
 * and manifest-derived singleton Pages cannot drift into invalid leaf roots. */
export function singlePanelPageLayout(
  placementId: string,
  title: string,
): PageTypeRegistration['layout'] {
  const groupId = `page-group:${placementId}`;
  return {
    grid: {
      height: 800,
      width: 1200,
      orientation: 'HORIZONTAL',
      root: {
        type: 'branch',
        size: 800,
        data: [{
          type: 'leaf',
          size: 1200,
          data: { views: [placementId], activeView: placementId, id: groupId },
        }],
      },
    },
    panels: { [placementId]: { id: placementId, contentComponent: placementId, title } },
    activeGroup: groupId,
  } as PageTypeRegistration['layout'];
}

const studioAgentsPageExtension: AppExtension = {
  id: '@forgeax/studio-agents',
  version: '2.0.0',
  requires: ['pages'],
  contributes: {
    panelTypes: [{
      id: '@forgeax/studio-agents#panel/main' as PanelTypeRegistration['id'],
      runtime: { kind: 'inline', render: () => <AgentsMainArea /> },
    }],
    pages: [{
      id: '@forgeax/studio-agents#page/main' as PageTypeRegistration['id'],
      title: 'Agents',
      cardinality: 'singleton',
      restorePolicy: 'project',
      layoutVersion: 1,
      panels: [{
        id: 'agents-page',
        panelTypeId: '@forgeax/studio-agents#panel/main' as PanelTypeRegistration['id'],
      }],
      layout: singlePanelPageLayout('agents-page', 'Agents'),
    }],
    activities: [{
      id: '@forgeax/studio-agents#activity/launcher' as ActivityRegistration['id'],
      title: 'Agents',
      titleI18n: { zh: '智能体', en: 'Agents', ja: 'エージェント' },
      icon: 'bot',
      category: 'builtin',
      sourceLayer: 'builtin',
      order: 10,
      pageTypeId: '@forgeax/studio-agents#page/main' as PageTypeRegistration['id'],
    }],
  },
};

const filesExplorerPanelExtension: AppExtension = {
  id: '@forgeax/files',
  version: '1.0.0',
  requires: ['pages'],
  contributes: {
    panelTypes: [
      {
        id: '@forgeax/files#panel/explorer' as PanelTypeRegistration['id'],
        runtime: { kind: 'inline', render: () => <WorkbenchFiles /> },
      },
      {
        id: '@forgeax/files#panel/preview' as PanelTypeRegistration['id'],
        runtime: { kind: 'inline', render: (context) => <FileResourcePanel pageKey={context.pageKey} /> },
      },
    ],
    pages: [{
      id: '@forgeax/files#page/explorer' as PageTypeRegistration['id'],
      title: 'Files',
      cardinality: 'singleton',
      restorePolicy: 'project',
      layoutVersion: 1,
      panels: [{ id: 'files-explorer', panelTypeId: '@forgeax/files#panel/explorer' as PanelTypeRegistration['id'] }],
      layout: singlePanelPageLayout('files-explorer', 'Files'),
    }, {
      id: '@forgeax/files#page/preview' as PageTypeRegistration['id'],
      title: 'File',
      cardinality: 'resource',
      restorePolicy: 'project',
      layoutVersion: 1,
      panels: [{ id: 'file-preview', panelTypeId: '@forgeax/files#panel/preview' as PanelTypeRegistration['id'] }],
      layout: singlePanelPageLayout('file-preview', 'File'),
    }],
    resourceEditors: [{
      id: '@forgeax/files#resource-editor/default' as ResourceEditorRegistration['id'],
      selector: { schemes: ['forgeax-file'] },
      pageTypeId: '@forgeax/files#page/preview' as PageTypeRegistration['id'],
      priority: 'default',
      sourceLayer: 'builtin',
    }],
  },
};

// The concrete implementation is selected by Vite's profile alias. Keeping
// this import at a stable package boundary lets full retain the historical
// eager manifest/panel map while lite resolves a zero-source implementation.
import { deriveInlineWorkbenchPanels } from '@forgeax/studio-inline-workbench-panels';

/** Fields no interface factory covers: workbench layout seed, the editor
 *  bridge hooks, and the host-sdk port factories. One custom extension keeps
 *  them on the same contributePanels channel (reversible, owner-tracked). */
const studioEditorIntegrationExtension: AppExtension = {
  id: 'studio.editor-integration', version: '1.0.0',
  requires: ['panels'],
  setup(ctx) {
    const overlayEl = document.createElement('div');
    overlayEl.id = 'editor-overlay-root';
    document.body.appendChild(overlayEl);
    const overlayRoot: Root = createRoot(overlayEl);
    overlayRoot.render(
      <EditorOverlayProvider>
        <ViewportRuntimeWindowBridge />
      </EditorOverlayProvider>,
    );

    const cleanupPanels = ctx.contributePanels({
      // Interface owns the workspace-key protocol; editor owns the actual chrome
      // layout. Studio and standalone both bind this same layout to `scene`.
      builtinWorkbenchLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
      editor: {
        importAssetSource: (input) => executeStudioAssetImportSource(input, 'human'),
        setContextMenuRenderer,
        installBridge: installInterfaceBridge,
      },
      // Host-SDK port factories for the wb:* plugin iframe RPC (studio-only).
      hostSDK: {
        createExtensionPort,
        createWindowTransport,
      },
    });

    return () => {
      cleanupPanels();
      overlayRoot.unmount();
      overlayEl.remove();
    };
  },
};

/** Studio's shell assembly, ADR 0025 M1: the concrete apps wired as
 *  AppExtension manifests, passed to <App overrides={{ extensions }} />.
 *  Replaces the former monolithic `editorRenderers: PanelRenderers` object. */
export const studioExtensions: readonly AppExtension[] = [
  // Single realm: the viewport is the in-process ViewportComponent (via
  // EditRealm, which owns multi-game teardown+remount); each ep:* panel is an
  // in-process component. The panels registry (bare-id keyed) is what the
  // interface DockRegion's <DockPanelHost id={id}/> reads.
  createPanelsEditorExtension({
    editorPanelIds: [...EDITOR_PANELS],
    panels: {
      ...editorPanels,
    },
    surfaces: { SceneEditor: EditRealm },
  }),
  createEditorPanelContributionsExtension(),
  createEditorPageExtension((id) => <EditorPanelBody id={id} />),
  appExtensionFromManifest({
    manifest: {
      schemaVersion: 1,
      id: 'overlays.dashboard',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { zh: '仪表盘', en: 'Dashboard' },
      description: { zh: '全屏仪表盘 overlay。', en: 'Full-screen dashboard overlay.' },
      author: { name: 'forgeax', email: 'dev@forgeax.local' },
      provides: { workbench: { id: 'dashboard', surface: 'overlay' } },
    },
    components: { Dashboard },
  }),
  appExtensionFromManifest({
    manifest: {
      schemaVersion: 1,
      id: 'overlays.settings',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { zh: '设置', en: 'Settings' },
      description: { zh: '全屏设置 overlay(含 sections 注册)。', en: 'Full-screen settings overlay with sections register.' },
      author: { name: 'forgeax', email: 'dev@forgeax.local' },
      provides: { workbench: { id: 'settings', surface: 'overlay' } },
    },
    components: { Settings: SettingsInjection },
  }),
  appExtensionFromManifest({
    manifest: {
      schemaVersion: 1,
      id: 'studio.panels.chat',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { zh: 'ForgeaX CLI', en: 'ForgeaX CLI' },
      description: { zh: 'ForgeaX CLI(D4 第二批 manifest 化)', en: 'ForgeaX CLI (D4 batch 2, manifest-declared)' },
      author: { name: 'forgeax', email: 'dev@forgeax.local' },
      provides: { workbench: { id: 'chat', position: 10, singleTab: 'hideTitle' } },
    },
    components: { Panel: ChatPanel },
  }),
  appExtensionFromManifest({
    manifest: {
      schemaVersion: 1,
      id: 'studio.panels.agents',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { zh: 'Agents', en: 'Agents' },
      description: { zh: 'Agents(D4 第二批 manifest 化)', en: 'Agents (D4 batch 2, manifest-declared)' },
      author: { name: 'forgeax', email: 'dev@forgeax.local' },
      provides: { workbench: { id: 'agents', position: 20 } },
    },
    components: { Panel: AgentsPanel },
  }),
  createDetachedAgentsBrowserExtension(WorkbenchAgents),
  createDetachedFilesBrowserExtension(WorkbenchFiles),
  studioAgentsPageExtension,
  filesExplorerPanelExtension,
  // MainArea body when app mode is 'ai' (plugin-launcher / catalog view);
  // sidebar agents list + workbench corner agent picker are ai-workbench UI —
  // interface (L1) only owns the slots.
  appExtensionFromManifest({
    manifest: {
      schemaVersion: 1,
      id: 'slots.ai-workbench',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { zh: 'AI 工作台槽件', en: 'AI Workbench Slots' },
      description: { zh: 'MainAreaBody / SidebarAgents / CornerAgentPicker(D4 第二批 manifest 化)', en: 'ai-workbench slot components (D4 batch 2, manifest-declared)' },
      author: { name: 'forgeax', email: 'dev@forgeax.local' },
      provides: { workbench: { id: 'ai-workbench-slots', surface: 'slot' } },
    },
    components: {
      MainAreaBody: WorkbenchMode,
      SidebarAgents: AgentsPanel,
      CornerAgentPicker: WorkbenchAgentPicker,
    },
  }),
  // Inline (non-iframe) workbench panels, keyed by bus plugin id — DERIVED
  // from manifests (ADR 0025 M4): any workbench extension whose entry is a
  // `./src/panel.tsx` React module with no standalone server is inline. The
  // two eager globs stay in perfect sync because both key off the extension
  // dir name; adding a new inline extension needs zero studio edits (§2.5).
  // Placeholder shims (admin/wb-code/…) export no component — filtered by
  // the `default` check, so only real panels (wb-plugin-author today) mount.
  createPanelsWorkbenchInlineExtension(deriveInlineWorkbenchPanels()),
  studioEditorIntegrationExtension,
];
