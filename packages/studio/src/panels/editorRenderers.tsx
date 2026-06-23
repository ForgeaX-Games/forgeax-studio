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
import { ReelPlaySurface } from './ReelPlaySurface';

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
  return liveSlugs[0] ?? null;
}

function EditMode({ viewportOnly }: { viewportOnly?: boolean } = {}) {
  const slug = useActiveSlug();
  if (!slug) return null;
  return <EditSurface slug={slug} viewportOnly={viewportOnly} />;
}

// Detect whether the active game has an interactive film-game (影游) scenario
// active, and which one. The wb-reel dev server exposes the per-game scenario
// library at `/__reel__/scenarios?game=<slug>` (proxied same-origin by both the
// interface and studio vite dev servers → FORGEAX_REEL_URL); the response is
// `{ db: { activeId, items } }`. A non-null `activeId` means the Play workspace
// should show the wb-reel Player instead of the 3D PlaySurface.
//
// Polled (not one-shot) so toggling/generating scenarios in the wb-reel
// workbench flips the Play preview without a manual reload, mirroring how
// useActiveSlug polls the active slug.
function useReelActiveScenario(slug: string | null): string | null {
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  useEffect(() => {
    if (!slug) {
      setScenarioId(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(
          `/__reel__/scenarios?game=${encodeURIComponent(slug)}`,
          { cache: 'no-store' },
        );
        if (!r.ok) {
          if (!cancelled) setScenarioId(null);
          return;
        }
        const j = (await r.json()) as { db?: { activeId?: string | null } };
        if (!cancelled) setScenarioId(j.db?.activeId ?? null);
      } catch {
        // wb-reel dev server not running / not a reel project → no reel preview.
        if (!cancelled) setScenarioId(null);
      }
    };
    void check();
    const t = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [slug]);
  return scenarioId;
}

function PreviewMode() {
  const slug = useActiveSlug();
  const reelScenarioId = useReelActiveScenario(slug);
  if (!slug) {
    return <div className="preview-mode"><div className="preview-frame preview-frame--waiting"><div className="preview-center"><div className="preview-title">Loading...</div></div></div></div>;
  }
  // 影游优先：当前 game 有活动剧本时，Play 工作区放 wb-reel 的 player-only 预览；
  // 否则回退到 3D ECS 游戏的 PlaySurface。
  if (reelScenarioId) {
    return <ReelPlaySurface scenarioId={reelScenarioId} slug={slug} />;
  }
  return <PlaySurface slug={slug} />;
}

const EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  material: 'Material', timeline: 'Timeline', matgraph: 'Mat Graph',
  launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
};

/** PanelRenderers wired with the real editor surfaces + the editor-shared
 *  SSOT panel id list. Passed to <App panelRenderers={editorRenderers} />. */
export const editorRenderers: PanelRenderers = {
  editorPanelIds: [...EDITOR_PANELS],
  editorPanelTitles: EDITOR_PANEL_TITLES,
  renderEdit: ({ viewportOnly }) => <EditMode viewportOnly={viewportOnly} />,
  renderPreview: () => <PreviewMode />,
};
