// ReelPlaySurface — Play-workspace preview surface for interactive film-game
// (影游) scenarios authored in the wb-reel plugin.
//
// Lives in studio (not interface) because the studio aggregation layer owns the
// preview wiring: editorRenderers.PreviewMode decides 3D `<PlaySurface>` vs this
// reel surface and feeds it into interface's PanelRenderers injection point.
// interface stays editor/plugin-agnostic; the `preview-*` CSS it renders into is
// global (interface/MainArea.css), so this component picks it up unchanged.
//
// Distinct from PlaySurface (which previews 3D ECS games via play-runtime).
// We embed wb-reel's *player-only* surface — the dev server root with
// `?surface=player` — so the iframe renders ONLY the immersive <Player />,
// with no TopBar / Sidebar / editor chrome. Embedding the full wb-reel App
// here is what previously caused the whole studio UI to nest inside the
// preview pane ("复制整个界面 / 显示嵌套"); the player-only surface fixes that.
//
// Address resolution mirrors StandalonePluginIframe.buildIframeSrc: wb-reel
// declares `entry.standalone.port` with `embeddedAlso:false`, so it is served
// from its own dev server origin rather than the host `/plugins/<id>/` path.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Maximize2, Minimize2 } from 'lucide-react';

// Keep in sync with packages/marketplace/plugins/wb-reel/forgeax-plugin.json
// → entry.standalone.port, and the `/__reel__` proxy targets in
// interface/studio vite.config.ts (FORGEAX_REEL_URL).
const REEL_PORT = 15175;

export interface ReelPlaySurfaceProps {
  scenarioId: string;
  /**
   * 当前 game slug。必须透传给 player iframe(`&game=<slug>`):wb-reel 的
   * gameScope 靠 URL 上的 slug/game 定位「按 game 隔离」的影游库,不传则 player
   * 会去读全局库、找不到该 game 工程里的剧本(影游空白)。无 slug 时省略。
   */
  slug?: string;
}

export function ReelPlaySurface({ scenarioId, slug }: ReelPlaySurfaceProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const src = useMemo(() => {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    let q = `surface=player&scn=${encodeURIComponent(scenarioId)}`;
    if (slug) q += `&game=${encodeURIComponent(slug)}`;
    return `${proto}//${host}:${REEL_PORT}/?${q}`;
  }, [scenarioId, slug]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const onReload = () => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    // eslint-disable-next-line no-self-assign
    ifr.src = ifr.src;
  };

  const onFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  return (
    <div className="preview-mode preview-mode--reel">
      <div className="preview-toolbar top" data-reel-scn={scenarioId}>
        <div className="pt-left">
          <span className="pt-slug" title={`reel scenario: ${scenarioId}`}>
            影游 · {scenarioId}
          </span>
        </div>
        <div className="pt-center">
          <button className="pt-btn" onClick={onReload} title="Reload preview">
            <RotateCcw size={16} />
          </button>
        </div>
        <div className="pt-right">
          <button
            className="pt-btn"
            onClick={onFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="preview-frame" ref={frameRef}>
        <iframe
          ref={iframeRef}
          src={src}
          className="preview-iframe preview-iframe--reel"
          title={`reel preview: ${scenarioId}`}
          allow="autoplay *; fullscreen *"
        />
      </div>
    </div>
  );
}
