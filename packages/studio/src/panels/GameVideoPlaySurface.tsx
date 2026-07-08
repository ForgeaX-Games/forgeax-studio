// GameVideoPlaySurface — Play-workspace preview surface for video-game
// (玩法优先) scenarios authored in the wb-game-video plugin.
//
// Parallel to ReelPlaySurface (wb-reel / FMV). Both embed a *player-only*
// standalone surface (`?surface=player`) so the iframe renders ONLY the
// immersive <Player /> with no editor chrome. Distinct from PlaySurface (3D
// ECS) and from ReelPlaySurface (interactive film).
//
// Address resolution mirrors StandalonePluginIframe.buildIframeSrc:
// wb-game-video declares `entry.standalone.port` with `embeddedAlso:false`, so
// it is served from its own dev server origin rather than the host
// `/plugins/<id>/` path.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Maximize2, Minimize2 } from 'lucide-react';

// Keep in sync with packages/marketplace/plugins/wb-game-video/forgeax-plugin.json
// → entry.standalone.port (15185).
const GAMEVIDEO_PORT = 15185;

export interface GameVideoPlaySurfaceProps {
  scenarioId: string;
  /**
   * 当前 game slug。必须透传给 player iframe(`&game=<slug>`):wb-game-video 的
   * gameScope 靠 URL 上的 slug/game 定位「按 game 隔离」的剧本库,不传则 player
   * 会去读全局库、找不到该 game 工程里的剧本(空白)。无 slug 时省略。
   */
  slug?: string;
}

export function GameVideoPlaySurface({ scenarioId, slug }: GameVideoPlaySurfaceProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const src = useMemo(() => {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    let q = `surface=player&scn=${encodeURIComponent(scenarioId)}`;
    if (slug) q += `&game=${encodeURIComponent(slug)}`;
    return `${proto}//${host}:${GAMEVIDEO_PORT}/?${q}`;
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
          <span className="pt-slug" title={`game-video scenario: ${scenarioId}`}>
            视频游戏 · {scenarioId}
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
          title={`game-video preview: ${scenarioId}`}
          allow="autoplay *; fullscreen *"
        />
      </div>
    </div>
  );
}
