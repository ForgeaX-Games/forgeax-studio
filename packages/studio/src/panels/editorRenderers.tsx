// Editor panel renderers — the studio aggregation layer's wiring of the
// editor app into the interface shell's PanelRenderers injection point.
//
// This is where the studio→editor edge legally lives (studio aggregates
// interface + apps). interface itself stays editor-agnostic; studio supplies
// the real EditSurface/PlaySurface here and feeds them to <App panelRenderers>.
import { useEffect, useState } from 'react';
import { useAppStore } from '@forgeax/interface/store';
import type { PanelRenderers } from '@forgeax/interface/components/DockShell/panelRenderers';
import { EDITOR_PANELS } from '@forgeax/editor-shared/manifest';
import { EditSurface } from '@forgeax/editor/edit';
import { PlaySurface } from '@forgeax/editor/play';
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

function EditMode({ viewportOnly }: { viewportOnly?: boolean } = {}) {
  const slug = useActiveSlug();
  if (!slug) return null;
  return <EditSurface slug={slug} viewportOnly={viewportOnly} />;
}

function PreviewMode() {
  const slug = useActiveSlug();
  if (!slug) {
    return <div className="preview-mode"><div className="preview-frame preview-frame--waiting"><div className="preview-center"><div className="preview-title">Loading...</div></div></div></div>;
  }
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
  renderEdit: ({ viewportOnly }) => <EditMode viewportOnly={viewportOnly} />,
  renderPreview: () => <PreviewMode />,
  // Inline (non-iframe) workbench panels, keyed by bus plugin id.
  workbenchPanels: { [WB_PLUGIN_AUTHOR_ID]: PluginAuthorPanel },
  // Host-SDK port factories for the wb:* plugin iframe RPC (studio-only).
  createPluginPort,
  createWindowTransport,
};
