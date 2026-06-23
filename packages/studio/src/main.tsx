// L3 product entry — thin assembly. All real implementation lives in
// `forgeax-interface` (L1 framework + chrome). When P1+ extracts L2 packages
// (@forgeax/editor / @forgeax/chat / @forgeax/workbench), import them here too
// and feed into AppKit composition API. Currently only a single editor app is
// verified; multi-app composition is a planned API surface (not yet wired).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgeax/interface/styles/global.css';
import { applyTheme } from '@forgeax/design/theme';
import { App } from '@forgeax/interface/App';

// Dark-only today; dual-marks data-theme + .dark so tokens.css selectors and
// Tailwind's `dark:` variant stay in lockstep. A light skin later only adds
// token overrides — no .tsx change. index.html already sets these for no-flash;
// this keeps it correct if the attribute is ever cleared.
applyTheme('dark');

import { BrandProvider } from '@forgeax/interface/brand';
import { ErrorBoundary } from '@forgeax/interface/components/ErrorBoundary';
import { bootStageEntry } from '@forgeax/interface/boot/driver';
import { subscribeSessionStream } from '@forgeax/interface/lib/session-stream';
import { subscribeNarrativeCopilot } from '@forgeax/interface/lib/narrative-copilot';
import { subscribeFileActivityStream } from '@forgeax/interface/lib/file-activity-stream';
import { subscribePermissionStream } from '@forgeax/interface/lib/permission-stream';
import { subscribePerceptionStream } from '@forgeax/interface/lib/perception-stream';
import { syncBrowserPrefsFromServer, startBrowserPrefsSync } from '@forgeax/interface/lib/browser-prefs-sync';
import { useAppStore } from '@forgeax/interface/store';
import { decodeSurfaceFromLocation, getWindowManager, surfaceKey } from '@forgeax/interface/lib/platform';
import { DetachedSurface } from '@forgeax/interface/components/DetachedSurface';
import { PanelRenderersProvider } from '@forgeax/interface/components/DockShell/panelRenderers';
import { installHealthBridge } from '@forgeax/interface/components/StatusBar/healthBridge';
import { editorRenderers } from './panels/editorRenderers';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');

// Detached-window entry: when launched with `?surface=...` (a popped-out OS
// window in the Tauri shell), render ONLY that surface — not the full IDE
// shell. Same bundle, single index.html, no multi-entry build. The boot splash
// in index.html is dismissed immediately since there's no heavy shell to wait
// for. Business state stays consistent via the shared backend (/api · /ws).
const detachedSurface = decodeSurfaceFromLocation();
if (detachedSurface) {
  // Boot splash is keyed off window.__forgeaxBoot; tell it we're done so the
  // splash fades out for the lightweight detached view.
  (window as unknown as { __forgeaxBoot?: { done?: () => void } }).__forgeaxBoot?.done?.();
  // Detached windows still need the store + live streams: a popped-out plugin
  // routes chat.post → store.sendMessage into the active session and reads
  // pinnedSlug for per-game data. Each OS window is its own client; they stay
  // consistent via the shared backend (/api · /ws). We deliberately skip the
  // window-close→redock listener here (that's the main window's job).
  bootStore();
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary scope="detached-surface">
        <BrandProvider>
          <PanelRenderersProvider value={editorRenderers}>
            <DetachedSurface surface={detachedSurface} />
          </PanelRenderersProvider>
        </BrandProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  // Restore UI layout prefs from server snapshot (export/import migration path).
  void syncBrowserPrefsFromServer().finally(() => {
    startBrowserPrefsSync();
  });
  bootStageEntry();
  bootFullShell(rootEl);
}

// Shared store/stream bootstrap. Order matters: subscribeSessionStream must
// attach its onSessionEvent handler BEFORE initSessions → connectForgeaXWs, or
// the first WS frames have no listener.
function bootStore() {
  // Health/INFO bridge — capture shell errors + iframe-forwarded `forgeax:health`
  // signals (Play/Edit/plugin) into the status bar. Must run before any iframe
  // mounts so early createApp failures are caught. Idempotent.
  installHealthBridge();
  subscribeSessionStream();
  // 叙事工坊「完成即重唤醒」闭环：监听 Kotone 调 narrative:start-pipeline → 轮询后端
  // 直到管线进终态 → 投系统提示唤醒 Kotone 做完成总结。需在 session-stream 之后挂。
  subscribeNarrativeCopilot();
  subscribeFileActivityStream();
  subscribePermissionStream(); // 权限审批卡订阅(此前 studio bootStore 漏挂 → 默认内核 ask 卡从不渲染)
  subscribePerceptionStream();
  void useAppStore.getState().initSessions();
}

function bootFullShell(el: HTMLElement) {
  // R3 (2026-05-20 重做) —— boot 流程见 bootStore():subscribeSessionStream 先挂
  // handler,再 initSessions → connectForgeaXWs。store 是唯一真值源。
  bootStore();

  // Windowing: when a detached surface window is closed by the user, redock it
  // (the main window re-mounts its keep-alive iframe). No-op in the browser
  // (WindowManager.onSurfaceWindowClosed never fires there).
  getWindowManager().onSurfaceWindowClosed((d) => {
    useAppStore.getState().markSurfaceDocked(surfaceKey(d));
  });

  if (import.meta.env.DEV) {
    // DevTools bridge — exposes the Zustand store to window.__dev so that the
    // external forgeax-devtools panel (~/Dev/forgeax-devtools/) can read and
    // patch store state without being part of this repo. Stripped in production.
    (window as unknown as Record<string, unknown>)['__dev'] = useAppStore;
  }

  createRoot(el).render(
    <StrictMode>
      <ErrorBoundary scope="studio-shell">
        <BrandProvider>
          <App panelRenderers={editorRenderers} />
        </BrandProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
