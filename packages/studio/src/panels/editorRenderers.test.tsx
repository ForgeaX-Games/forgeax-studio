import { expect, test } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  type TransportResponse,
} from '@forgeax/editor/product';
import { mock } from 'bun:test';

mock.module('react', () => ({
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, () => undefined],
}));
mock.module('react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null, Fragment: 'fragment' }));
mock.module('react-dom/client', () => ({ createRoot: () => ({ render: () => undefined, unmount: () => undefined }) }));
mock.module('@forgeax/interface/store', () => ({ useShellStore: () => null }));
mock.module('@forgeax/interface/i18n', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
mock.module('@forgeax/interface/components/DockShell/panelRenderers', () => ({}));
mock.module('@forgeax/interface/components/StatusBar/feeds/PulseFeeds', () => ({ PulseFeeds: () => null }));
mock.module('@forgeax/interface/components/StatusBar/VersionBadge', () => ({ VersionBadge: () => null }));
mock.module('@forgeax/editor/bridge', () => ({
  createEditorPanelContributionsExtension: () => ({}),
  installInterfaceBridge: () => undefined,
  setContextMenuRenderer: () => undefined,
  panelBridge: { on: () => () => undefined },
  gateway: { mode: 'edit', playPhase: 'idle', dispatch: () => undefined },
  hasPendingDiskSave: () => false,
}));
mock.module('@forgeax/editor/default-dock-layout', () => ({ DEFAULT_EDITOR_DOCK_LAYOUT: {} }));
mock.module('@forgeax/editor/viewport', () => ({ ViewportComponent: () => null, resetEditRealm: () => undefined }));
mock.module('@forgeax/editor/panels', () => ({ EDITOR_PANELS: [], EDITOR_PANEL_COMPONENTS: {} }));
mock.module('@forgeax/editor/ui/overlays', () => ({ EditorOverlayProvider: () => null }));
mock.module('@forgeax/chat', () => ({ ChatPanel: () => null }));
mock.module('@forgeax/dashboard', () => ({ Dashboard: () => null }));
mock.module('@forgeax/settings', () => ({ SettingsPanel: () => null, SettingsSectionsRegister: () => null }));
mock.module('@forgeax/ai-workbench', () => ({
  WorkbenchMode: {}, WorkbenchModeDefault: () => null, AgentsMainArea: () => null,
  AgentsPanel: () => null, WorkbenchAgentPicker: () => null,
}));
mock.module('@forgeax/host-sdk', () => ({ createExtensionPort: () => undefined, createWindowTransport: () => undefined }));
mock.module('@forgeax/interface/core/app-shell/types', () => ({}));
mock.module('@forgeax/interface/core/extensions/panels-editor', () => ({ createPanelsEditorExtension: () => ({}) }));
mock.module('@forgeax/interface/core/app-shell/manifest-adapter', () => ({ appExtensionFromManifest: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/chrome-status-feeds', () => ({ createChromeStatusFeedsExtension: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/detached-agents-browser', () => ({ createDetachedAgentsBrowserExtension: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/detached-files-browser', () => ({ createDetachedFilesBrowserExtension: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/panels-workbench-plugins', () => ({ createPanelsWorkbenchInlineExtension: () => ({}) }));

const { projectEditorRenderFacts } = await import('./editorRenderers');

function result(value: unknown, runId?: string): TransportResponse {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: 'response-id',
    correlationId: 'response-correlation',
    ...(runId === undefined ? {} : { runId }),
    result: value,
  };
}

test('projects canonical document, asset, run, and runtime facts while preserving UI transient state', () => {
  const projection = projectEditorRenderFacts({
    discover: result({
      runtime: {
        version: 'game-runtime/v1',
        host: 'transport',
        blocking: false,
        capabilities: {
          query: { available: true, code: 'runtime-ready' },
          play: { available: true, code: 'runtime-ready' },
        },
      },
    }),
    document: result({ revision: 'document:r1', content: 'edited' }),
    assets: result({
      resourceRevision: 'assets:r1',
      subjects: [{ id: 'asset:hero', path: 'assets/hero.glb' }],
    }),
    run: result({ runId: 'run-1', status: 'succeeded', revision: 'document:r1' }, 'run-1'),
    transient: {
      panelId: 'assets',
      layoutId: 'scene',
      timerPending: true,
      hmrActive: true,
    },
  });

  expect(projection).toMatchObject({
    document: { revision: 'document:r1', content: 'edited' },
    assets: {
      revision: 'assets:r1',
      importedSubjectIds: ['asset:hero'],
    },
    run: { id: 'run-1', status: 'succeeded', revision: 'document:r1' },
    runtime: {
      version: 'game-runtime/v1',
      capabilities: { query: { available: true }, play: { available: true } },
    },
    transient: {
      panelId: 'assets',
      layoutId: 'scene',
      timerPending: true,
      hmrActive: true,
    },
  });
});

test('session transient changes never mutate canonical Editor facts', () => {
  const input = {
    discover: result({ runtime: { version: 'game-runtime/v1', capabilities: { query: { available: true } } } }),
    document: result({ revision: 'document:r1', content: 'edited' }),
    assets: result({ resourceRevision: 'assets:r1', subjects: [{ id: 'asset:hero' }] }),
    run: result({ runId: 'run-1', status: 'succeeded', revision: 'document:r1' }, 'run-1'),
  };
  const first = projectEditorRenderFacts({
    ...input,
    transient: { panelId: 'assets', layoutId: 'scene', timerPending: false, hmrActive: false },
  });
  const second = projectEditorRenderFacts({
    ...input,
    transient: { panelId: 'viewport', layoutId: 'game', timerPending: true, hmrActive: true },
  });

  expect(second.document).toEqual(first.document);
  expect(second.assets).toEqual(first.assets);
  expect(second.run).toEqual(first.run);
  expect(second.runtime).toEqual(first.runtime);
  expect(second.transient).not.toEqual(first.transient);
});

test('projection parity rejects an old document revision or missing imported asset', () => {
  const canonical = projectEditorRenderFacts({
    discover: result({ runtime: { capabilities: {} } }),
    document: result({ revision: 'document:r1', content: 'edited' }),
    assets: result({ resourceRevision: 'assets:r1', subjects: [{ id: 'asset:hero' }] }),
    transient: { panelId: 'assets', layoutId: 'scene', timerPending: false, hmrActive: false },
  });
  const stale = projectEditorRenderFacts({
    discover: result({ runtime: { capabilities: {} } }),
    document: result({ revision: 'document:r0', content: 'initial' }),
    assets: result({ resourceRevision: 'assets:r0', subjects: [] }),
    transient: { panelId: 'assets', layoutId: 'scene', timerPending: false, hmrActive: false },
  });

  expect(canonical.document.revision).toBe('document:r1');
  expect(canonical.assets.importedSubjectIds).toEqual(['asset:hero']);
  expect(stale).not.toMatchObject({
    document: { revision: canonical.document.revision, content: canonical.document.content },
    assets: { revision: canonical.assets.revision, importedSubjectIds: ['asset:hero'] },
  });
});
