// Editor panel renderers — the studio aggregation layer's wiring of the
// editor app into the interface shell's PanelRenderers injection point.
//
// This is where the studio→editor edge legally lives (studio aggregates
// interface + apps). interface itself stays editor-agnostic; studio supplies
// the real EditSurface/PlaySurface here and feeds them to <App panelRenderers>.
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@forgeax/interface/store';
import type { PanelRenderers } from '@forgeax/interface/components/DockShell/panelRenderers';
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
// Single-realm (feat-20260703): the editor engine boots IN-PROCESS in this
// studio host window — viewport + ep:* panels are in-process React components,
// not a /editor iframe. ViewportComponent (the in-process surface) + resetEditRealm
// (cross-game teardown) come from edit-runtime's D8 subpath; EDITOR_PANEL_COMPONENTS
// maps ep:<id> -> the panel component. Mirrors packages/editor/standalone/main.tsx.
import { ViewportComponent, resetEditRealm } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { EDITOR_PANEL_COMPONENTS } from '@forgeax/editor/panels';
import { PlaySurface } from '@forgeax/editor/play';
// import { ReelPlaySurface } from './ReelPlaySurface';
import { GameVideoPlaySurface } from './GameVideoPlaySurface';
// studio→chat is a legal aggregation edge (studio composes interface + apps).
// interface stays chat-agnostic (no @forgeax/chat import); studio injects the
// chat surface here through the renderChat slot, exactly like edit/preview.
import { ChatPanel } from '@forgeax/chat';
// studio→dashboard / studio→settings are legal aggregation edges too. interface
// stays dashboard/settings-agnostic; studio injects the overlay bodies here via
// the renderDashboard / renderSettings slots, exactly like chat/edit/preview.
import { Dashboard } from '@forgeax/dashboard';
import { SettingsPanel, SettingsSectionsRegister } from '@forgeax/settings';
// studio→workbench is a legal aggregation edge. interface stays workbench-UI
// agnostic (the plugin-host runtime stays L1); studio injects the workbench
// main-area body here via the renderWorkbench slot.
import { WorkbenchMode, WorkbenchModeDefault, AgentsMainArea } from '@forgeax/workbench';
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
// hand it to an iframe: after a "重置 GAMES" (or any out-of-band deletion) the
// pinned/auto slug can momentarily name a game that no longer exists on disk.
// Mounting <PlaySurface>/<EditSurface> on a 404'd `?game=` iframe is what gave
// the blank/frozen viewport that the React error boundary can't catch (it's a
// cross-origin iframe, not a render throw). When the resolved slug isn't in the
// list we drop to the first available game, or null → the "Loading..."
// placeholder — never a dead iframe.
function useActiveSlug(): string | null {
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
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
// server's safe-path whitelist). The editor holds ZERO layout convention, so the
// host injects the game root. Single-realm: the in-process engine boot
// (configureHostSession, host-boot) reads it ONLY from location.search
// (?scene=<slug>&gameRoot=<root>); localStorage['forgeax.gameRoot'] is kept in
// sync as the pre-boot signal (mirrors packages/editor/standalone/main.tsx:125).
function studioGameRoot(slug: string): string {
  return `.forgeax/games/${slug}`;
}

// Bridge the active game into location.search so the in-process engine boot reads
// the right scene. configureHostSession() reads ONLY the URL, so this MUST run
// before <ViewportComponent> mounts (and again before every re-mount on switch).
// Returns true if the URL changed (used to force a full teardown on game switch).
function bridgeGameToUrl(slug: string, gameRoot: string): boolean {
  try {
    const qp = new URLSearchParams(location.search);
    if (qp.get('scene') === slug && qp.get('gameRoot') === gameRoot) return false;
    qp.set('scene', slug);
    qp.set('gameRoot', gameRoot);
    history.replaceState(null, '', `${location.pathname}?${qp.toString()}${location.hash}`);
    return true;
  } catch { return false; }
}

// EditRealm — the in-process editor viewport surface (single realm). Replaces the
// old EditSurface iframe. It owns the studio-only multi-game orchestration:
//   - resolve the active slug (useActiveSlug: pinnedSlug + server active-slug,
//     validated against the live game list),
//   - keep localStorage['forgeax.gameRoot'] + ?scene=/?gameRoot= in sync,
//   - on a CROSS-GAME switch, tear the engine realm down (resetEditRealm: releases
//     the WebGPU device + resets the single-boot latch) and remount a fresh
//     <ViewportComponent key={slug}> so the new game boots clean (physics backend
//     + pack roots bind once at createApp, so a switch can't hot-swap).
// viewportOnly is accepted for renderEdit signature parity but is a no-op — the
// in-process component always renders the full surface.
function EditRealm(_props: { viewportOnly?: boolean } = {}) {
  const slug = useActiveSlug();
  // `bootedSlug` is the game the currently-mounted engine booted. null until the
  // first game mounts. When slug !== bootedSlug we do a teardown+remount.
  const [bootedSlug, setBootedSlug] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!slug) return;
    const gameRoot = studioGameRoot(slug);
    try { localStorage.setItem('forgeax.gameRoot', gameRoot); } catch { /* no storage */ }
    if (bootedSlug === slug) return;
    // Cross-game switch (or first boot). On a real switch, destroy the previous
    // engine realm BEFORE re-pointing the URL + remounting, so the old WebGPU
    // device is released and the boot latch is clear for the new game. First boot
    // (bootedSlug === null) has nothing to tear down.
    if (bootedSlug !== null) resetEditRealm();
    bridgeGameToUrl(slug, gameRoot);
    setBootedSlug(slug);
  }, [slug, bootedSlug]);

  if (!slug || bootedSlug !== slug) return null;
  // key={slug} forces a fresh mount per game; the pre-mount resetEditRealm above
  // guarantees the latch is clear so ViewportComponent actually re-boots.
  return <ViewportComponent key={slug} />;
}

// The in-process body for a single ep:* editor panel. Resolves the panel's React
// component from EDITOR_PANEL_COMPONENTS (editor-panels SSOT); ids with no
// registered component (timeline / matgraph drift) fall back to a neutral
// placeholder. Mirrors packages/editor/standalone/main.tsx:62-70. The panels read
// the in-process @forgeax/editor-core store (same realm as ViewportComponent),
// so no extra Provider is needed beyond the shell's PanelRenderersProvider +
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

function PreviewMode() {
  const slug = useActiveSlug();
  if (!slug) {
    return <div className="preview-mode"><div className="preview-frame preview-frame--waiting"><div className="preview-center"><div className="preview-title">Loading...</div></div></div></div>;
  }
  // TODO gamevidoe play
  // if (entry?.projectType === 'game-video' && entry.reelScenarioId) {
  //   return <GameVideoPlaySurface scenarioId={entry.reelScenarioId} slug={slug} />;
  // }
  // Opening a project renders that project. Play always shows the game's own
  // engine PlaySurface — it does NOT reinterpret a game as an interactive-film
  // (影游) from a side-file. 影游 is its own independent project type and should
  // be rendered from the project itself (forge.json), not via a heuristic layer
  // ("reel-first") laid over every game.
  return <PlaySurface slug={slug} />;
}

const EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  material: 'Material', timeline: 'Timeline', matgraph: 'Mat Graph',
  mesh: 'Mesh', launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
};

/** PanelRenderers wired with the real editor surfaces + the editor-shared
 *  SSOT panel id list. Passed to <App panelRenderers={editorRenderers} />. */
export const editorRenderers: PanelRenderers = {
  editorPanelIds: [...EDITOR_PANELS],
  editorPanelTitles: EDITOR_PANEL_TITLES,
  // Single realm: the viewport is the in-process ViewportComponent (via EditRealm,
  // which owns multi-game teardown+remount), and each ep:* panel is an in-process
  // component. renderEditorPanel is what the interface DockShell reads to mount
  // Hierarchy/Inspector/Assets/... — its absence was why every panel showed
  // "Panel not mounted" after the single-realm editor bump.
  renderEdit: ({ viewportOnly }) => <EditRealm viewportOnly={viewportOnly} />,
  renderEditorPanel: (id) => <EditorPanelBody id={id} />,
  renderPreview: () => <PreviewMode />,
  renderChat: () => <ChatPanel />,
  renderDashboard: () => <Dashboard />,
  // The settings slot mounts BOTH the sections-register side-effect and the
  // panel, mirroring the old interface App.tsx ordering.
  renderSettings: () => (
    <>
      <SettingsSectionsRegister />
      <SettingsPanel />
    </>
  ),
  renderWorkbench: (variant) =>
    variant === 'agents' ? <AgentsMainArea />
      : variant === 'files' ? <WorkbenchModeDefault showGalleryWhenEmpty={false} />
        : <WorkbenchMode />,
  // Inline (non-iframe) workbench panels, keyed by bus plugin id.
  workbenchPanels: { [WB_PLUGIN_AUTHOR_ID]: PluginAuthorPanel },
  // Host-SDK port factories for the wb:* plugin iframe RPC (studio-only).
  createPluginPort,
  createWindowTransport,
};