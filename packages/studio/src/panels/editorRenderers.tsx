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
import type { PanelRenderers, PanelDescriptor } from '@forgeax/interface/components/DockShell/panelRenderers';
import { PulseFeeds } from '@forgeax/interface/components/StatusBar/feeds/PulseFeeds';
import { VersionBadge } from '@forgeax/interface/components/StatusBar/VersionBadge';
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
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

  if (!slug || bootedSlug !== slug) return null;
  // key={slug} forces a fresh mount per game; the pre-mount resetEditRealm
  // above guarantees the latch is clear so ViewportComponent actually re-boots.
  // The game is passed as props — the engine boot reads it there, not from the URL.
  return <ViewportComponent key={slug} gameSlug={slug} gameRoot={studioGameRoot(slug)} />;
}

// The in-process body for a single ep:* editor panel. Resolves the panel's
// React component from EDITOR_PANEL_COMPONENTS (editor-panels SSOT); ids with
// no registered component (timeline / matgraph drift) fall back to a neutral
// placeholder. Mirrors packages/editor/standalone/main.tsx. The panels read the
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
  material: 'Material', timeline: 'Timeline', matgraph: 'Mat Graph',
  mesh: 'Mesh', launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
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
