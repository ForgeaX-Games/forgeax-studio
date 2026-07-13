// L3 product entry — thin assembly. All real implementation lives in
// `forgeax-interface` (L1 framework + chrome). When P1+ extracts L2 packages
// (@forgeax/editor / @forgeax/chat / @forgeax/ai-workbench), import them here too
// and feed into AppKit composition API. Currently only a single editor app is
// verified; multi-app composition is a planned API surface (not yet wired).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgeax/interface/styles/global.css';
import { applyTheme } from '@forgeax/design/theme';
import { App } from '@forgeax/interface/App';
import { initI18n } from '@forgeax/interface/i18n';

// Dark-only today; dual-marks data-theme + .dark so tokens.css selectors and
// Tailwind's `dark:` variant stay in lockstep. A light skin later only adds
// token overrides — no .tsx change. index.html already sets these for no-flash;
// this keeps it correct if the attribute is ever cleared.
applyTheme('dark');

// Restore locale from localStorage, or detect the OS/browser locale on first run
// (zh* → Chinese, else English). MUST run before first paint so the shell renders
// in the right language. (Was missing on the studio entry — the app was stuck on
// the module-default 'en' regardless of system locale.) Re-run after the server
// prefs restore below in case an imported snapshot carries an explicit choice.
initI18n();

import { BrandProvider } from '@forgeax/interface/brand';
import { ErrorBoundary } from '@forgeax/interface/components/ErrorBoundary';
import { bootStageEntry } from '@forgeax/interface/boot/driver';
import { bootBroadcast } from '@forgeax/interface/boot/broadcast';
import {
  subscribeSessionStream,
  subscribeDaemonTick,
  fetchSessionList,
  createSession,
  deleteSession,
  emitForgeaXMessage,
  listSessionAgents,
  connectForgeaXWs,
  disconnectForgeaXWs,
  onSessionEvent,
} from '@forgeax/chat/session-store';
import { initAgentPrefs } from '@forgeax/settings';
import { initFilePreview, createRestWorkbenchClient } from '@forgeax/ai-workbench';
import { subscribeNarrativeCopilot } from '@forgeax/interface/lib/narrative-copilot';
import { subscribeFileActivityStream } from '@forgeax/interface/lib/file-activity-stream';
import { subscribePermissionStream } from '@forgeax/interface/lib/permission-stream';
import { subscribePerceptionStream } from '@forgeax/interface/lib/perception-stream';
import { bootUiBridge } from '@forgeax/interface/lib/ui-bridge';
import { syncBrowserPrefsFromServer, startBrowserPrefsSync } from '@forgeax/interface/lib/browser-prefs-sync';
import { configureSessionClient, configureWorkbenchClient, useShellStore } from '@forgeax/interface/store';
import { decodeSurfaceFromLocation, getWindowManager, surfaceKey } from '@forgeax/interface/lib/platform';
import { DetachedSurface } from '@forgeax/interface/components/DetachedSurface';
import { PanelRenderersProvider } from '@forgeax/interface/components/DockShell/panelRenderers';
import { installHealthBridge } from '@forgeax/interface/components/StatusBar/healthBridge';
import { initAegis } from '@forgeax/interface/lib/aegis';
import { installAssetFetchGate } from './lib/asset-fetch-gate';
import { registerKeyboardRouterDeps, type KeyboardRouterDeps } from '@forgeax/interface/lib/global-shortcuts';
// keyboard-router deps builder is the shared edit-runtime SSOT so studio and the
// editor standalone host produce the SAME dep object. Without this registration
// studio's global keydown router has no editor callbacks, so G/Esc (display
// toggle: game↔scene, i.e. "▶ Play 后按 Esc 回到 edit 模式") does nothing while
// the GameOverlay button — which dispatches directly — still works. That split
// was the diagnostic signal. window.confirm backs the risky multi-asset delete
// (studio has no DeleteGuardDialog).
import { buildKeyboardRouterDeps } from '@forgeax/editor-edit-runtime/keyboard-router-deps';
import { editorRenderers } from './panels/editorRenderers';

// Perf fix for heavy-game loads (e.g. hellforge): keep a game's asset burst from
// exhausting the browser's per-origin connection pool and leaving the shell's
// own API/streams "pending". In dev this reroutes asset fetches to the dedicated
// play-engine origin (:15173) so they use a separate pool ("A"); with no asset
// origin (packaged) it caps asset concurrency on the shared origin ("C"). Must
// run before the engine viewport boots so the first asset burst is handled.
installAssetFetchGate();

// Boot Aegis (Galileo) front-end monitoring first, before any heavy boot work,
// so early throws are captured. Inert unless VITE_AEGIS_* is configured (PROD,
// or dev with VITE_AEGIS_DEV=1). studio is the default served package (STUDIO=1)
// so the .env* it reads live in packages/studio, not interface.
initAegis();

configureSessionClient({
  fetchSessionList,
  createSession,
  deleteSession,
  emitForgeaXMessage,
  listSessionAgents,
  connectForgeaXWs,
  disconnectForgeaXWs,
  onSessionEvent,
});

// Inject the workbench REST implementation before bootStore() — store.switchGame
// triggers activateGame() via the workbench client, so it must be wired first.
configureWorkbenchClient(createRestWorkbenchClient());

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
    // Re-init locale: the restored snapshot may carry an explicit language choice
    // that should win over the first-paint system detection above.
    initI18n();
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
  initAgentPrefs();         // ① agent 安装偏好 owner（settings）—— 发首帧 bus 快照 + 挂 seed 监听
  initFilePreview();        // ③ 文件预览 owner（workbench）—— 发首帧快照 + 挂 open-file 命令监听
  bootBroadcast();          // R5/P1 唯一公共广播 socket + telemetry/workspace-changed
  subscribeDaemonTick();    // daemon-tick-* 帧接到该广播流（chat 域）
  subscribeSessionStream();
  // 叙事工坊「完成即重唤醒」闭环：监听 Kotone 调 narrative:start-pipeline → 轮询后端
  // 直到管线进终态 → 投系统提示唤醒 Kotone 做完成总结。需在 session-stream 之后挂。
  subscribeNarrativeCopilot();
  subscribeFileActivityStream();
  subscribePermissionStream(); // 权限审批卡订阅(此前 studio bootStore 漏挂 → 默认内核 ask 卡从不渲染)
  subscribePerceptionStream();
  bootUiBridge(); // UI 语义操作层(ActionRegistry + lease + ui_* 应答;方案:产品AI化-语义操作层)
  void useShellStore.getState().initSessions();
}

function bootFullShell(el: HTMLElement) {
  // R3 (2026-05-20 重做) —— boot 流程见 bootStore():subscribeSessionStream 先挂
  // handler,再 initSessions → connectForgeaXWs。store 是唯一真值源。
  bootStore();

  // Windowing: when a detached surface window is closed by the user, redock it
  // (the main window re-mounts its keep-alive iframe). No-op in the browser
  // (WindowManager.onSurfaceWindowClosed never fires there).
  getWindowManager().onSurfaceWindowClosed((d) => {
    useShellStore.getState().markSurfaceDocked(surfaceKey(d));
  });

  if (import.meta.env.DEV) {
    // DevTools bridge — exposes the Zustand store to window.__dev so that the
    // external forgeax-devtools panel (~/Dev/forgeax-devtools/) can read and
    // patch store state without being part of this repo. Stripped in production.
    (window as unknown as Record<string, unknown>)['__dev'] = useShellStore;
  }

  // Inject the editor-side keyboard-router callbacks (interface stays
  // editor-agnostic). Must run before <App> mounts so useGlobalShortcuts reads
  // them at effect time. Mirrors editor/standalone/main.tsx.
  registerKeyboardRouterDeps(
    buildKeyboardRouterDeps({
      confirmDeleteAssets: (assets) =>
        Promise.resolve(
          window.confirm(`Delete ${assets.length} assets? This cannot be undone.`),
        ),
      // Cast through unknown: buildKeyboardRouterDeps returns the structural
      // KeyboardRouterDepsShape (edit-runtime declares it locally to stay off the
      // L1 framework); interface's KeyboardRouterDeps has since added richer asset
      // fields (kind/payload) the router doesn't read, so the shapes no longer
      // directly overlap. The builder is designed to be bridged at the call site.
    }) as unknown as KeyboardRouterDeps,
  );

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
