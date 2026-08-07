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
mock.module('@forgeax/interface/components/DockShell/panelRenderers', () => ({ usePanelRenderers: () => ({}) }));
mock.module('@forgeax/editor/bridge', () => ({
  createEditorPanelContributionsExtension: () => ({}),
  createEditorPageExtension: () => ({}),
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
  AgentsPanel: () => null, WorkbenchAgentPicker: () => null, activateFile: () => undefined,
}));
mock.module('@forgeax/host-sdk', () => ({ createExtensionPort: () => undefined, createWindowTransport: () => undefined }));
mock.module('@forgeax/interface/core/app-shell/types', () => ({}));
mock.module('@forgeax/interface/core/extensions/panels-editor', () => ({ createPanelsEditorExtension: () => ({}) }));
mock.module('@forgeax/interface/core/app-shell/manifest-adapter', () => ({ appExtensionFromManifest: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/detached-agents-browser', () => ({ createDetachedAgentsBrowserExtension: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/detached-files-browser', () => ({ createDetachedFilesBrowserExtension: () => ({}) }));
mock.module('@forgeax/interface/core/extensions/panels-workbench-plugins', () => ({ createPanelsWorkbenchInlineExtension: () => ({}) }));

const { projectEditorRenderFacts, singlePanelPageLayout } = await import('./editorRenderers');

test('single-panel Page layouts keep Dockview required branch roots', () => {
  const layout = singlePanelPageLayout('example-placement', 'Example');
  expect('grid' in layout).toBe(true);
  if (!('grid' in layout)) throw new Error('expected serialized Dockview layout');

  expect(layout.grid.root).toMatchObject({
    type: 'branch',
    data: [{
      type: 'leaf',
      data: { views: ['example-placement'], activeView: 'example-placement' },
    }],
  });
  expect(layout.panels['example-placement']).toMatchObject({
    id: 'example-placement',
    contentComponent: 'example-placement',
    title: 'Example',
  });
});

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

test('projects canonical document, asset, run, and Gateway operation facts while preserving UI transient state', () => {
  const projection = projectEditorRenderFacts({
    discover: result({
      capabilityManifest: {
        capabilities: [
          { id: 'editor.query', verb: 'query' },
          { id: 'editor.play', verb: 'play' },
        ],
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
    gatewayOperations: ['query', 'play'],
    transient: {
      panelId: 'assets',
      layoutId: 'scene',
      timerPending: true,
      hmrActive: true,
    },
  });
});

test('projects the live transport document envelope returned by the Studio carrier', () => {
  const projection = projectEditorRenderFacts({
    discover: result({ capabilityManifest: { capabilities: [] } }),
    document: result({
      document: { revision: 'scene:scene:1', content: '{"gameId":"spin-cube"}' },
      selection: { primary: null, ids: [] },
      dirty: false,
    }),
    assets: result({ resourceRevision: 'assets:r1', subjects: [] }),
  });

  expect(projection.document).toEqual({ revision: 'scene:scene:1', content: '{"gameId":"spin-cube"}' });
});

test('session transient changes never mutate canonical Editor facts', () => {
  const input = {
    discover: result({ capabilityManifest: { capabilities: [{ id: 'editor.query', verb: 'query' }] } }),
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
  expect(second.gatewayOperations).toEqual(first.gatewayOperations);
  expect(second.transient).not.toEqual(first.transient);
});

test('projection parity rejects an old document revision or missing imported asset', () => {
  const canonical = projectEditorRenderFacts({
    discover: result({ capabilityManifest: { capabilities: [] } }),
    document: result({ revision: 'document:r1', content: 'edited' }),
    assets: result({ resourceRevision: 'assets:r1', subjects: [{ id: 'asset:hero' }] }),
    transient: { panelId: 'assets', layoutId: 'scene', timerPending: false, hmrActive: false },
  });
  const stale = projectEditorRenderFacts({
    discover: result({ capabilityManifest: { capabilities: [] } }),
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
