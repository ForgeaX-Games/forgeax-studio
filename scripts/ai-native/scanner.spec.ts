import { describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildInventory,
  collectRegisteredOtherTeamRoutes,
  fixtureScan,
  fixtureDeclarativeMenuScan,
  loadScannerLifecycleConfig,
  renderInventory,
  scanServerEndpoints,
  stratifiedNegativeSample,
} from './scanner';
import { computeScannerConfigurationFingerprint } from './runtime-artifact-integrity.ts';
import { deriveIntegrityDomain, renderIntegrityDomainManifest } from './integrity-domain.ts';

const ROOT = resolve(import.meta.dir, '../..');

describe('registered other-team routes', () => {
  // This branch edited collectRegisteredOtherTeamRoutes: record mode now also
  // reports observed-but-unregistered routes. A mutation check showed the
  // default throwing path had no test left guarding it, so both modes are
  // pinned here -- the strict path must refuse an unverified pin, and the
  // record path must surface the same fact as data instead of an exception.
  const ROOT_DIR = resolve(import.meta.dir, '../..');
  const UNVERIFIED = { 'platform-io': '0'.repeat(40) };

  it('refuses an unverified pin on the default throwing path', () => {
    expect(() => collectRegisteredOtherTeamRoutes(ROOT_DIR, UNVERIFIED)).toThrow(/re-compare routes/);
  });

  it('records the same drift instead of throwing when asked to', () => {
    const recorded = collectRegisteredOtherTeamRoutes(ROOT_DIR, UNVERIFIED, 'record');
    expect(recorded.drift.some((line) => line.includes('platform-io'))).toBe(true);
  });
});

describe('AI-native scanner', () => {

  it('keeps manual identity stable across coordinate and reason drift', () => {
    const forwarded = fixtureScan(`
      export function Host({ onMystery }) {
        return <button onClick={() => onMystery()}>Mystery</button>;
      }
    `);
    const differentReasonAndLine = fixtureScan(`


      export function Host() {
        return <button onClick={() => unknownCall()}>Mystery</button>;
      }
    `);
    expect(forwarded.controls[0]?.control_id).toBe(differentReasonAndLine.controls[0]?.control_id);
    expect(forwarded.manual[0]?.reason).not.toBe(differentReasonAndLine.manual[0]?.reason);
    expect(forwarded.manual[0]?.manual_id).toBe(differentReasonAndLine.manual[0]?.manual_id);
  });


  it('propagates a DOM callback through a custom component to a business effect', () => {
    const result = fixtureScan(`
      function PickButton({ onPick }) {
        return <button data-testid="pick" onClick={() => onPick('hero')}>Pick</button>;
      }
      export function Parent() {
        return <PickButton onPick={() => toggleSidebar()} />;
      }
    `, { toggleSidebar: 'panel.toggle_sidebar' });

    const dom = result.controls.find((row) => row.component === 'PickButton');
    expect(dom).toBeDefined();
    expect(dom?.propagation).toBe('forwarded');
    expect(dom?.effect_id).toBe('panel.toggle_sidebar');
    expect(result.edges.some((edge) => edge.control_id === dom?.control_id && edge.via.some((v) => v.startsWith('forward:onPick')))).toBe(true);
    expect(result.manual.some((row) => row.control_id === dom?.control_id)).toBe(false);
  });

  it('keeps an unresolvable custom callback in the manual pool', () => {
    const result = fixtureScan(`
      export function Wrapper({ onMystery }) {
        return <button onClick={() => onMystery()}>Mystery</button>;
      }
    `);
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].propagation).toBe('manual-pool');
    expect(result.manual).toHaveLength(1);
  });

  it('collects direct postMessage effects without duplicating forwarded props', () => {
    const result = fixtureScan(`
      export function Host({ onNavigate }) {
        const onRawMessage = (event) => {
          if (event.data?.type === 'FORGEAX_NAVIGATE') {
            onNavigate?.(event.data.target);
            return;
          }
          if (event.data?.type === 'FORGEAX_COMPOSER_INSERT') {
            requestComposerInsert(event.data.payload);
          }
        };
        window.addEventListener('message', onRawMessage);
      }
    `);

    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].surface).toBe('postmessage-handler');
    expect(result.controls[0].event).toBe('message:FORGEAX_COMPOSER_INSERT');
    expect(result.controls[0].effect_id).toBe('chat.insert_reference');
    expect(result.controls[0].propagation).toBe('direct');
    expect(result.manual).toHaveLength(0);
  });

  it('keeps an unmapped direct postMessage effect in the manual pool', () => {
    const result = fixtureScan(`
      export function Host() {
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'NATIVE_EFFECT') invokeNative(event.data);
        });
      }
    `);

    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].event).toBe('message:NATIVE_EFFECT');
    expect(result.controls[0].effect_id).toBeNull();
    expect(result.controls[0].propagation).toBe('manual-pool');
    expect(result.manual).toHaveLength(1);
  });

  it('resolves same-file constant and constant-array listener event names', () => {
    const result = fixtureScan(`
      const PREFIX = 'forgeax:';
      const SYNC_EVENT = \`${'${PREFIX}'}sync\`;
      const STREAM_EVENTS = ['RUN_STARTED', 'RUN_FINISHED'] as const;
      export function Host() {
        window.addEventListener(SYNC_EVENT, sync);
        for (const event of STREAM_EVENTS) window.addEventListener(event, ingest);
      }
    `);

    expect(result.controls.map((row) => row.event).sort()).toEqual([
      'RUN_FINISHED',
      'RUN_STARTED',
      'forgeax:sync',
    ]);
  });

  it('applies an ordinary listener call-scoped exclusion without hiding a sibling effect', () => {
    const config = JSON.parse(readFileSync('scripts/ai-native/exclusions.json', 'utf8')) as {
      listener_rules: Array<{
        file?: string;
        event?: string;
        element?: string;
        calls?: string[];
        reason: string;
        verified_applicability?: string;
      }>;
    };
    const rule = config.listener_rules.find((row) => (
      row.file === 'packages/interface/src/i18n/index.ts'
      && row.event === 'forgeax:locale-changed'
      && row.element === 'window'
      && row.calls?.includes('setLocale')
    ));
    expect(rule).toBeDefined();
    expect(rule?.verified_applicability).toContain('i18n/index.ts:127');

    const exact = fixtureScan(`
      window.addEventListener('forgeax:locale-changed', () => setLocale(readPersisted(), { persist: false }));
    `, { setLocale: 'locale.set' }, {
      file: rule!.file,
      listenerRules: [rule!],
    });
    expect(exact.controls).toHaveLength(0);
    expect(exact.manual).toHaveLength(0);

    const sibling = fixtureScan(`
      window.addEventListener('forgeax:locale-changed', () => {
        setLocale(readPersisted(), { persist: false });
        setBannerOpen(true);
      });
    `, {
      setLocale: 'locale.set',
      setBannerOpen: 'banner.set_open',
    }, {
      file: rule!.file,
      listenerRules: [rule!],
    });
    expect(sibling.controls).toHaveLength(1);
    expect(sibling.edges.map((edge) => edge.effect_id).sort()).toEqual(['banner.set_open', 'locale.set']);
  });

  it('routes an unresolved imported listener event name to the manual pool', () => {
    const result = fixtureScan(`
      import EVENT_NAME from '@external/events';
      export function Host() {
        window.addEventListener(EVENT_NAME, onEvent);
      }
    `);

    expect(result.controls).toHaveLength(0);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0].kind).toBe('listener-event');
    expect(result.manual[0].details.collector).toBe('event-listener-constant');
  });

  it('collects custom onXxx subscriptions and traces an identifier callback', () => {
    const result = fixtureScan(`
      export function Shell() {
        const redock = (detail) => markSurfaceDocked(detail.id);
        getWindowManager().onSurfaceWindowClosed(redock);
      }
    `, { markSurfaceDocked: 'store.mark_surface_docked' });

    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].surface).toBe('subscription-handler');
    expect(result.controls[0].event).toBe('onSurfaceWindowClosed');
    expect(result.controls[0].effect_id).toBe('store.mark_surface_docked');
    expect(result.controls[0].notes).toContain('source=subscription-handler');
    expect(result.manual).toHaveLength(0);
  });

  it('collects only the exact lowercase on/once/subscribe method family', () => {
    const result = fixtureScan(`
      export function EditRealm() {
        const handleHealth = () => setHealthReady(true);
        const EVENT_NAME = 'dynamic';
        const callbacks = { handle: () => setIgnored(true) };
        panelBridge.on('assetsChanged', () => setViewportEpoch(1));
        panelBridge.once('editorHealth', handleHealth);
        panelBridge.subscribe((state) => setSnapshot(state));
        panelBridge.on(EVENT_NAME, callbacks.handle);
        panelBridge.observe(() => setIgnored(true));
        Promise.then(() => setIgnored(true));
      }
    `, {
      setViewportEpoch: 'edit_realm.set_viewport_epoch',
      setHealthReady: 'edit_realm.set_health_ready',
      setSnapshot: 'edit_realm.set_snapshot',
      setIgnored: 'edit_realm.set_ignored',
    });

    expect(result.controls.map((row) => row.event).sort()).toEqual(['on', 'once', 'subscribe']);
    expect(result.controls.every((row) => row.surface === 'subscription-handler')).toBe(true);
    expect(result.controls.find((row) => row.event === 'on')?.effect_id).toBe('edit_realm.set_viewport_epoch');
    expect(result.controls.find((row) => row.event === 'once')?.effect_id).toBe('edit_realm.set_health_ready');
    expect(result.controls.find((row) => row.event === 'subscribe')?.effect_id).toBe('edit_realm.set_snapshot');
    expect(result.subscriptionAudits.every((row) => row.family === 'lowercase-method')).toBe(true);
    expect(result.manual).toHaveLength(0);
  });

  it('applies the signed import.meta.hot.on exclusion with verified applicability', () => {
    const config = JSON.parse(readFileSync('scripts/ai-native/exclusions.json', 'utf8')) as {
      subscription_rules: Array<{
        file?: string;
        receiver?: string;
        method?: string;
        event?: string;
        reason: string;
        verified_applicability?: string;
      }>;
    };
    const rule = config.subscription_rules.find((row) => (
      row.file === 'packages/studio/src/panels/editorRenderers.tsx'
      && row.receiver === 'import.meta.hot'
      && row.method === 'on'
      && row.event === 'forgeax:game-code-change'
    ));
    expect(rule).toBeDefined();
    expect(rule?.verified_applicability).toContain('editorRenderers.tsx:194');

    const result = fixtureScan(`
      const onGameCodeChange = () => restartPreview();
      import.meta.hot.on('forgeax:game-code-change', onGameCodeChange);
    `, {}, {
      file: rule!.file,
      subscriptionRules: [rule!],
    });

    expect(result.controls).toHaveLength(0);
    expect(result.manual).toHaveLength(0);
    expect(result.subscriptionAudits).toEqual([expect.objectContaining({
      family: 'lowercase-method',
      disposition: 'excluded',
      receiver: 'import.meta.hot',
      method: 'on',
      topic: 'forgeax:game-code-change',
      exclusion_reason: rule!.reason,
      verified_applicability: rule!.verified_applicability,
    })]);
  });

  it('annotates a uniquely associated cross-package provider-DI callback branch', () => {
    const result = fixtureScan(`
      import { buildKeyboardRouterDeps } from '@forgeax/editor/keyboard-router-deps';
      export function DeleteButton() {
        return <button onClick={() => routerDeps.deleteAssets([])}>Delete</button>;
      }
      buildKeyboardRouterDeps({
        confirmDeleteAssets: (assets) => Promise.resolve(window.confirm('Delete?')),
      });
    `);

    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].effect_id).toBe('editor.delete_assets');
    expect(result.controls[0].notes).toContain('di_provider_branch=src/Fixture.tsx:7');
    expect(result.controls[0].notes).toContain('confirmDeleteAssets');
    expect(result.controls[0].notes).toContain('window.confirm');
    expect(result.manual).toHaveLength(0);
  });

  it('routes an unassociated cross-package provider-DI callback to the manual pool', () => {
    const result = fixtureScan(`
      import { buildDeps } from '@forgeax/editor/deps';
      buildDeps({ auditBeforeDelete: () => recordAudit() });
    `);

    expect(result.controls).toHaveLength(0);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0].kind).toBe('provider-di');
    expect(result.manual[0].details.collector).toBe('provider-di');
  });

  it('resolves same-named local handlers within their lexical component', () => {
    const result = fixtureScan(`
      function Left() {
        const act = () => toggleSidebar();
        return <button onClick={act}>Left</button>;
      }
      function Right() {
        const act = () => closeOverlay();
        return <button onClick={act}>Right</button>;
      }
    `, {
      toggleSidebar: 'panel.toggle_sidebar',
      closeOverlay: 'overlay.close',
    });
    expect(result.controls.find((row) => row.component === 'Left')?.effect_id).toBe('panel.toggle_sidebar');
    expect(result.controls.find((row) => row.component === 'Right')?.effect_id).toBe('overlay.close');
  });

  it('does not treat a same-named local function as an imported known product call', () => {
    const result = fixtureScan(`
      import { sendMessage } from '@forgeax/interface/lib/session-client';
      export function Host() {
        const onClick = () => {
          const sendMessage = () => setLocalResult(true);
          sendMessage();
        };
        return <button onClick={onClick}>Local</button>;
      }
    `, { setLocalResult: 'host.set_local_result' });

    expect(result.edges.map((edge) => edge.effect_id)).toEqual(['host.set_local_result']);
    expect(result.edges.some((edge) => edge.effect_id === 'chat.post_message')).toBe(false);
  });

  it('does not treat an arbitrary object method as a known product receiver', () => {
    const result = fixtureScan(`
      export function Host() {
        const localClient = { deleteGame: () => setLocalResult(true) };
        return <button onClick={() => localClient.deleteGame()}>Local</button>;
      }
    `, { setLocalResult: 'host.set_local_result' });

    expect(result.edges).toEqual([]);
    expect(result.edges.some((edge) => edge.effect_id === 'server.delete_api_workbench_games_slug')).toBe(false);
    expect(result.controls[0]?.propagation).toBe('manual-pool');
  });

  it('does not traverse a nested callback that the handler never invokes', () => {
    const result = fixtureScan(`
      import { useChatStore } from '../../session-store';
      export function Host() {
        const performRewind = useChatStore((state) => state.performRewind);
        const onClick = () => {
          const deferred = () => performRewind('sid', 'msg', 'both');
          setVisible(true);
        };
        return <button onClick={onClick}>Open</button>;
      }
    `, { setVisible: 'host.set_visible' });

    expect(result.edges.map((edge) => edge.effect_id)).toEqual(['host.set_visible']);
    expect(result.edges.some((edge) => edge.effect_id === 'server.post_api_sessions_sid_rewind')).toBe(false);
  });

  it('keeps a trusted receiver call as a distinct effect', () => {
    const result = fixtureScan(`
      import { getWorkbenchClient } from '../../store';
      export function Host({ hardDelete }) {
        return <button onClick={async () => {
          if (hardDelete) await getWorkbenchClient().deleteGame('demo');
          else await fetch('/api/workbench/games/demo', { method: 'DELETE' });
        }}>Delete</button>;
      }
    `);

    expect(result.edges.map((edge) => edge.effect_id)).toEqual([
      'server.delete_api_workbench_games_demo',
      'server.delete_api_workbench_games_slug',
    ]);
  });



  it('fingerprints true scanner inputs while enforcement-only bytes stay separately protected', () => {
    const fingerprint = computeScannerConfigurationFingerprint(resolve(import.meta.dir, '../..'));
    expect(fingerprint.domains.some((row) => row.path === 'scripts/ai-native/control-id.ts')).toBe(false);
    expect(fingerprint.domains.some((row) => row.path === 'scripts/ai-native/baseline-state.ts')).toBe(false);
    expect(fingerprint.domains.some((row) => row.path === 'package.json')).toBe(false);
    for (const path of [
      'scripts/ai-native/scanner-config.json',
      'scripts/ai-native/exclusions.json',
      'scripts/ai-native/vocab-config.json',
      'scripts/ai-native/alias-map.json',
      'scripts/ai-native/other-team-route-registry.json',
    ]) expect(fingerprint.domains.some((row) => row.path === path), path).toBe(true);
    expect(fingerprint.domains.some((row) => row.domain === 'identity-aliases')).toBe(true);
    expect(fingerprint.domains.some((row) => row.domain === 'ownership-adjudication')).toBe(true);
    expect(fingerprint.domains.every((row) => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);
    expect(fingerprint.bound_sha256).toMatch(/^[0-9a-f]{64}$/);
    const enforcement = deriveIntegrityDomain(resolve(import.meta.dir, '../..'));
    expect(enforcement.configuration_files).toContain('scripts/ai-native/control-id.ts');
    expect(enforcement.configuration_files).toContain('scripts/ai-native/baseline-state.ts');
    expect(enforcement.configuration_files).toContain('package.json');
    const inventoryFingerprint = computeScannerConfigurationFingerprint(ROOT);
    expect(inventoryFingerprint.domains.some((row: { path: string }) => row.path === 'scripts/ai-native/vocab-config.json')).toBe(true);
    expect(inventoryFingerprint.domains.some((row: { path: string }) => row.path === 'scripts/ai-native/vocab-map.json')).toBe(false);
  });

  it('rejects a scanner config that tries to select its own runtime pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-scanner-anchor-'));
    const configPath = join(root, 'scripts/ai-native/scanner-config.json');
    mkdirSync(join(root, 'scripts/ai-native'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      series: 'b1',
      scanner_version: '1.0.0',
      previous_baseline_id: null,
      product_pin_source: 'forged.json',
    }));
    expect(() => loadScannerLifecycleConfig(root)).toThrow(/unknown keys.*product_pin_source/);
  });



  it('samples negative component files deterministically and by stratum', () => {
    const candidates = [
      { stratum: 'components/A', file: 'a1.tsx' },
      { stratum: 'components/A', file: 'a2.tsx' },
      { stratum: 'components/B', file: 'b1.tsx' },
      { stratum: 'components/C', file: 'c1.tsx' },
    ];
    const a = stratifiedNegativeSample(candidates, 3, 'seed');
    const b = stratifiedNegativeSample(candidates, 3, 'seed');
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(new Set(a.map((row) => row.stratum)).size).toBe(3);
  });

});
