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
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useShellStore } from '@forgeax/interface/store';
import { useTranslation } from '@forgeax/interface/i18n';
import type { PanelRenderers, PanelDescriptor } from '@forgeax/interface/components/DockShell/panelRenderers';
import { PulseFeeds } from '@forgeax/interface/components/StatusBar/feeds/PulseFeeds';
import { VersionBadge } from '@forgeax/interface/components/StatusBar/VersionBadge';
import { installInterfaceBridge, setContextMenuRenderer, panelBridge } from '@forgeax/editor-core';
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from '@forgeax/editor/default-dock-layout';
// ViewportComponent (the in-process edit surface) + resetEditRealm (cross-game
// teardown) come from edit-runtime's engine subpath; EDITOR_PANEL_COMPONENTS
// maps ep:<id> → the panel's React component. Mirrors packages/editor/
// standalone/main.tsx (the standalone editor shell that first landed this).
import { ViewportComponent, resetEditRealm } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { EDITOR_PANEL_COMPONENTS } from '@forgeax/editor/panels';
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
import { WorkbenchMode, WorkbenchModeDefault, AgentsMainArea, AgentsPanel, WorkbenchAgentPicker } from '@forgeax/ai-workbench';
// studio→marketplace is a legal edge at this aggregation layer. interface holds
// no specific plugin id; studio injects the concrete inline panel here.
import { PluginAuthorPanel, WB_PLUGIN_AUTHOR_ID } from '../../../marketplace/plugins/wb-plugin-author/src/panel';
// studio→host-sdk is legal here too. interface imports these as TYPES only and
// receives the runtime factories through the PanelRenderers injection.
import { createPluginPort, createWindowTransport } from '@forgeax/host-sdk';

// Resolve the active game slug: pinned slug first, else poll the workbench
// active-slug endpoint (carried over verbatim from the interface EditMode/
// PreviewMode mount points that used to live in interface).
//
// The resolved slug is then VALIDATED against the live game list before we
// hand it to the engine: after a "重置 GAMES" (or any out-of-band deletion) the
// pinned/auto slug can momentarily name a game that no longer exists on disk.
// Booting the in-process engine against a 404'd game (or mounting <PlaySurface>
// on one) was the blank/frozen viewport that the React error boundary can't
// catch. When the resolved slug isn't in the list we drop to the first
// available game, or null → the "Loading..." placeholder — never a dead mount.
function useActiveSlug(): string | null {
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  const [autoSlug, setAutoSlug] = useState<string | null>(null);
  const [liveSlugs, setLiveSlugs] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/workbench/active-slug');
        const j = (await r.json()) as { activeSlug?: string | null };
        if (!cancelled) setAutoSlug(j.activeSlug ?? null);
      } catch { /* keep last known slug */ }
      try {
        const r = await fetch('/api/workbench/games');
        const j = (await r.json()) as { games?: Array<{ slug: string }> };
        if (!cancelled) setLiveSlugs((j.games ?? []).map((g) => g.slug));
      } catch { /* keep last known list */ }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const resolved = pinnedSlug ?? autoSlug;
  // Until the first game-list fetch lands, trust the resolved slug (avoids a
  // spurious null flash on boot). Once we know the list, gate on membership.
  if (liveSlugs === null) return resolved;
  if (resolved && liveSlugs.includes(resolved)) return resolved;
  // `resolved` isn't in the live list. Before falling back, trust autoSlug:
  // /api/workbench/active-slug resolves it via getActiveGame, which only returns
  // a slug whose .forgeax/games/<slug>/ dir actually exists — so it's a real,
  // mountable game even when the /games list is momentarily incomplete (e.g. a
  // dangling symlink truncated the enumeration). Without this, a single bad
  // games-list response would silently switch the preview to games[0] (the
  // "wrong game in the viewport" bug). Only drop to games[0]/null when even the
  // server has no authoritative active game (fresh workspace / everything deleted).
  if (autoSlug) return autoSlug;
  return liveSlugs[0] ?? null;
}

// Studio owns its on-disk game layout (`.forgeax/games/<slug>`, matching the
// server's safe-path whitelist). The editor holds ZERO layout convention, so
// the host passes the game root to ViewportComponent as a prop.
function studioGameRoot(slug: string): string {
  return `.forgeax/games/${slug}`;
}

// EditRealm — the in-process editor viewport surface (single realm). It owns
// the studio-only multi-game orchestration:
//   - resolve the active slug (useActiveSlug: pinnedSlug + server active-slug,
//     validated against the live game list),
//   - pass the active game to ViewportComponent as props (NOT `?scene=`/
//     `?gameRoot=` URL params — the single realm removed the editor iframe those
//     addressed, so the props are the one source and can't drift from a stale URL),
//   - on a CROSS-GAME switch, tear the engine realm down (resetEditRealm:
//     releases the WebGPU device + resets the single-boot latch) and remount a
//     fresh <ViewportComponent key={slug}> so the new game boots clean (physics
//     backend + pack roots bind once at createApp, so a switch can't hot-swap).
// viewportOnly is accepted for the surfaces.Edit ComponentType signature parity
// but is a no-op — the in-process component always renders the full surface.
function EditRealm(_props: { viewportOnly?: boolean } = {}) {
  const slug = useActiveSlug();
  // `bootedSlug` is the game the currently-mounted engine booted. null until
  // the first game mounts. When slug !== bootedSlug we do a teardown+remount.
  const [bootedSlug, setBootedSlug] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!slug) return;
    if (bootedSlug === slug) return;
    // Cross-game switch (or first boot). On a real switch, destroy the previous
    // engine realm BEFORE remounting, so the old WebGPU device is released and the
    // boot latch is clear for the new game. First boot (null) has nothing to tear
    // down.
    if (bootedSlug !== null) resetEditRealm();
    setBootedSlug(slug);
  }, [slug, bootedSlug]);

  // The viewport is only mounted once bootedSlug has caught up with slug (the
  // pre-mount resetEditRealm ran). During that gap — and while the freshly
  // mounted engine boots + streams the game's assets — we overlay a loading
  // surface so a heavy game (e.g. hellforge, ~1.3GB of meshes) never presents as
  // a silent blank viewport with "所有接口 pending 但页面没提示" (the bug this fixes).
  const mounted = !!slug && bootedSlug === slug;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#16161a' }}>
      {mounted && (
        // key={slug} forces a fresh mount per game; the pre-mount resetEditRealm
        // above guarantees the latch is clear so ViewportComponent actually re-boots.
        // The game is passed as props — the engine boot reads it there, not from the URL.
        <ViewportComponent key={slug} gameSlug={slug} gameRoot={studioGameRoot(slug)} />
      )}
      {/* Keyed by slug so it resets its boot-progress state on every game switch. */}
      <ViewportBootOverlay key={`overlay:${slug ?? '_none'}`} slug={slug} />
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
function ViewportBootOverlay({ slug }: { slug: string | null }): ReactNode {
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
    >
      <div
        style={{
          width: 34, height: 34, borderRadius: '50%',
          border: '3px solid rgba(255,255,255,0.14)', borderTopColor: '#7aa2ff',
          animation: 'fx-viewport-spin 0.9s linear infinite',
        }}
      />
      <div style={{ fontSize: 14, color: '#e7e7ef' }}>
        {slug
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
// EDITOR_PANELS is the SSOT for editor panel ids (imported from @forgeax/editor-core/manifest).
// Each descriptor bakes in the title from EDITOR_PANEL_TITLES + a stable order.
const editorPanels: Record<string, PanelDescriptor> = Object.fromEntries(
  EDITOR_PANELS.map((id, i) => [id, {
    title: EDITOR_PANEL_TITLES[id] ?? id,
    order: 100 + i,
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

function StatusFeedsInjection(): ReactNode {
  return (
    <>
      <PulseFeeds />
      <VersionBadge />
    </>
  );
}

function WorkbenchAgents(): ReactNode {
  return <AgentsMainArea />;
}

function WorkbenchFiles(): ReactNode {
  return <WorkbenchModeDefault showGalleryWhenEmpty={false} />;
}

/** PanelRenderers wired with the in-process editor surfaces + the editor-core
 *  SSOT panel id list. Passed to <App panelRenderers={editorRenderers} />. */
export const editorRenderers: PanelRenderers = {
  editorPanelIds: [...EDITOR_PANELS],
  // Interface owns the workspace-key protocol; editor owns the actual chrome
  // layout. Studio and standalone both bind this same layout to `scene`.
  builtinWorkbenchLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
  // Single realm: the viewport is the in-process ViewportComponent (via
  // EditRealm, which owns multi-game teardown+remount), and each ep:* panel is
  // an in-process component. The panels registry (bare-id keyed) is what
  // the interface DockRegion's <DockPanelHost id={id}/> reads to mount
  // Hierarchy/Inspector/Assets/... — its absence was why every panel showed
  // "Panel not mounted" after the single-realm editor bump.
  panels: {
    ...editorPanels,
    chat: { title: 'ForgeaX CLI', order: 10, render: () => <ChatPanel /> },
    agents: { title: 'Agents', order: 20, render: () => <AgentsPanel /> },
  },
  overlays: {
    Dashboard,
    Settings: SettingsInjection,
  },
  surfaces: {
    SceneEditor: EditRealm,
  },
  editor: {
    setContextMenuRenderer,
    installBridge: installInterfaceBridge,
  },
  chrome: {
    StatusFeeds: StatusFeedsInjection,
  },
  detached: {
    AgentsBrowser: WorkbenchAgents,
    FilesBrowser: WorkbenchFiles,
  },
  slots: {
    // MainArea body when app mode is 'ai' (plugin-launcher / catalog view).
    MainAreaBody: WorkbenchMode,
    // Sidebar 内嵌 Agents 列表 + workbench 主区右上角 corner agent picker —
    // 都是 workbench-builtins 的具体 UI,interface(L1)只留槽。
    CornerAgentPicker: WorkbenchAgentPicker,
    SidebarAgents: AgentsPanel,
  },
  // Inline (non-iframe) workbench panels, keyed by bus plugin id.
  workbenchPanels: { [WB_PLUGIN_AUTHOR_ID]: PluginAuthorPanel },
  // Host-SDK port factories for the wb:* plugin iframe RPC (studio-only).
  hostSDK: {
    createPluginPort,
    createWindowTransport,
  },
};
