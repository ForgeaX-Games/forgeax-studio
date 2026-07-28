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
import { executeScanner, parseScannerArgs, verificationArtifacts } from './scan';
import {
  computeInventoryScannerConfigurationFingerprint,
  computeScannerConfigurationFingerprint,
} from './runtime-artifact-integrity.ts';
import { deriveIntegrityDomain, renderIntegrityDomainManifest } from './integrity-domain.ts';

const ROOT = resolve(import.meta.dir, '../..');

describe('AI-native scanner', () => {
  it('freezes and byte-verifies after a vocabulary configuration change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-vocab-freeze-'));
    cpSync(join(ROOT, 'scripts/ai-native'), join(root, 'scripts/ai-native'), { recursive: true });
    cpSync(join(ROOT, 'docs/ai-native'), join(root, 'docs/ai-native'), { recursive: true });
    cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
    cpSync(join(ROOT, 'bun.lock'), join(root, 'bun.lock'));
    symlinkSync(join(ROOT, 'packages'), join(root, 'packages'));

    const scannerConfigPath = join(root, 'scripts/ai-native/scanner-config.json');
    const scannerConfig = JSON.parse(readFileSync(scannerConfigPath, 'utf8')) as Record<string, unknown>;
    scannerConfig.baseline_id = 'b1-2099-01-02-9.9.9';
    scannerConfig.scanner_version = '9.9.9';
    scannerConfig.previous_baseline_id = 'b1-2026-07-24-0.6.2';
    writeFileSync(scannerConfigPath, `${JSON.stringify(scannerConfig, null, 2)}\n`);

    const vocabConfigPath = join(root, 'scripts/ai-native/vocab-config.json');
    const vocabConfig = JSON.parse(readFileSync(vocabConfigPath, 'utf8')) as {
      overrides: { commands: Record<string, string> };
    };
    vocabConfig.overrides.commands['fixture.changed-vocabulary'] = 'fixture.changed_vocabulary';
    writeFileSync(vocabConfigPath, `${JSON.stringify(vocabConfig, null, 2)}\n`);
    writeFileSync(
      join(root, 'scripts/ai-native/integrity-domain.generated.json'),
      renderIntegrityDomainManifest(deriveIntegrityDomain(root)),
    );

    const freeze = parseScannerArgs(['--no-git', '--baseline-date', '2099-01-02']);
    await executeScanner(freeze, root, () => undefined);
    await executeScanner({ ...freeze, verify: true }, root, () => undefined);
    expect(readFileSync(join(root, 'scripts/ai-native/vocab-map.json'), 'utf8')).toBe(
      readFileSync(join(root, 'docs/ai-native/baseline/b1-2099-01-02-9.9.9/vocab-map.json'), 'utf8'),
    );
  }, 30_000);

  it('collects declarative menu data once and keeps labels out of identity', () => {
    const source = (label: string) => `
      import { registerMenuItem } from '../../lib/menu-registry';
      const items = [
        { id: 'file.save', menu: 'file', group: 'file', labelKey: '${label}', commandId: 'editor.save' },
        { id: 'file.pending', menu: 'file', group: 'file', labelKey: 'pending' },
        { id: 'file.more', menu: 'file', group: 'file', labelKey: 'more', children: [] },
        { id: 'file.unknown', menu: 'file', group: 'file', labelKey: 'unknown', commandId: 'missing.command' },
      ];
      for (const item of items) registerMenuItem(item);
    `;
    const first = fixtureDeclarativeMenuScan(source('menu.file.save'), { 'editor.save': 'editor.save' });
    const relabeled = fixtureDeclarativeMenuScan(source('menu.file.save.renamed'), { 'editor.save': 'editor.save' });
    expect(first.controls).toHaveLength(2);
    expect(first.edges).toHaveLength(1);
    expect(first.edges[0]?.effect_id).toBe('editor.save');
    expect(first.controls[0]?.control_id).toBe(relabeled.controls[0]?.control_id);
    expect(first.manual).toEqual([
      expect.objectContaining({ kind: 'menu-command', candidate: 'missing.command' }),
    ]);
    expect(first.audit.map((row) => row.disposition).sort()).toEqual([
      'control', 'manual-command', 'placeholder', 'submenu-container',
    ] as Array<(typeof first.audit)[number]['disposition']>);
    expect(new Set(first.edges.map((row) => `${row.control_id}|${row.effect_id}`)).size).toBe(first.edges.length);
  });

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

  it('requires a fresh route comparison record when a registered other-team pin advances', () => {
    const root = resolve(import.meta.dir, '../..');
    const pin = 'a939f6abe1b2e86bc8d3798c277c1ac1026381d9';
    const current = collectRegisteredOtherTeamRoutes(root, { 'platform-io': pin });
    expect(current.audit.filter((row) => row.introduced_in_anchor)).toHaveLength(9);
    expect(current.audit.filter((row) => row.registration_reason === 'known-other-team-call')).toHaveLength(4);
    expect(current.audit.filter((row) => row.registration_reason === 'effect-host-migration')).toHaveLength(1);
    expect(() => collectRegisteredOtherTeamRoutes(root, { 'platform-io': '0'.repeat(40) })).toThrow(/re-compare routes/);
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

  it('keeps a trusted receiver call and a different branch endpoint as separate effects', () => {
    const result = fixtureScan(`
      import { getWorkbenchClient } from '../../store';
      export function Host({ hardDelete }) {
        return <button onClick={async () => {
          if (hardDelete) await getWorkbenchClient().deleteGame('demo');
          else await fetch('/api/projects/registered', { method: 'DELETE' });
        }}>Delete</button>;
      }
    `);

    expect(result.edges.map((edge) => edge.effect_id).sort()).toEqual([
      'server.delete_api_projects_registered',
      'server.delete_api_workbench_games_slug',
    ]);
  });

  it('matches the current frozen real-repository inventory and menu registrations', async () => {
    const scannerConfig = loadScannerLifecycleConfig(ROOT);
    const result = await buildInventory({
      baselineDate: scannerConfig.currentBaselineDate,
      scannerConfig,
      noGit: true,
    });
    const rendered = renderInventory(result);
    const baselineDir = join(ROOT, 'docs/ai-native/baseline', result.baselineId);
    const retainedInputs = [
      'controls.jsonl',
      'edges.jsonl',
      'effects.jsonl',
      'manual-classification-pool.jsonl',
      'meta.json',
    ];
    const frozen = Object.fromEntries(
      retainedInputs.map((name) => [name, readFileSync(join(baselineDir, name), 'utf8')]),
    );
    const retainedRendered = Object.fromEntries(
      retainedInputs.map((name) => [name, rendered[name]!]),
    );
    expect(verificationArtifacts(retainedRendered)).toEqual(verificationArtifacts(frozen));

    const ids = new Set(result.controls.map((row) => row.control_id));
    const effectIds = new Set(result.effects.map((row) => row.effect_id));
    expect(ids.size).toBe(result.controls.length);
    expect(effectIds.size).toBe(result.effects.length);
    expect(result.edges.every((edge) => ids.has(edge.control_id) && effectIds.has(edge.effect_id))).toBe(true);
    expect(result.effects.every((effect) => effect.repo.length > 0)).toBe(true);
    expect(new Set(result.edges.map((edge) => `${edge.control_id}|${edge.effect_id}`)).size).toBe(result.edges.length);

    const menuAudit = result.declarativeMenuAudit.filter((row): row is typeof row & {
      control_id: string;
      effect_id: string;
      command_id: string;
    } => (
      row.disposition === 'control'
      && row.control_id !== null
      && row.effect_id !== null
      && row.command_id !== null
    ));
    const menuControls = result.controls.filter((row) => row.notes.includes('source=declarative-menu-registry'));
    expect(menuAudit.length).toBeGreaterThan(0);
    expect(menuControls.map((row) => row.control_id).sort()).toEqual(
      menuAudit.map((row) => row.control_id).sort(),
    );
    for (const row of menuAudit) {
      const sourceLines = readFileSync(join(ROOT, row.file), 'utf8').split(/\r?\n/);
      const entryStart = row.evidence_line - 1;
      let entryEnd = entryStart + 1;
      while (entryEnd < sourceLines.length && !/^\s*\{\s*id:/.test(sourceLines[entryEnd]!)) entryEnd += 1;
      const sourceEntry = sourceLines.slice(entryStart, entryEnd).join('\n');
      expect(sourceEntry, `${row.file}:${row.evidence_line}`).toContain('id:');
      expect(sourceEntry, `${row.file}:${row.evidence_line}`).toContain('commandId:');
      expect(sourceEntry, `${row.file}:${row.evidence_line}`).toContain(row.command_id);
      expect(row.effect_id).not.toBeNull();
      expect(row.control_id).not.toBeNull();
    }

    const promotionRegistry = JSON.parse(
      readFileSync(join(ROOT, 'scripts/ai-native/manual-pool-effect-promotions.json'), 'utf8'),
    ) as { promotions: Array<{ effect_id: string }> };
    expect(promotionRegistry.promotions.map((row) => row.effect_id).sort()).toEqual(
      result.effects
        .filter((effect) => promotionRegistry.promotions.some((row) => row.effect_id === effect.effect_id))
        .map((effect) => effect.effect_id)
        .sort(),
    );
    expect(result.stats.controls).toBeGreaterThan(500);
    expect(result.stats.manualControlRatio).toBeLessThanOrEqual(0.25);
    expect(result.stats.agentEquivalentEffects).toBeGreaterThan(0);

    const projectDelete = result.effects.find((effect) => effect.effect_id === 'platform_io.project.delete');
    expect(projectDelete?.repo).toEqual(['platform-io']);
    expect(projectDelete?.server_endpoints).toContain('DELETE /api/projects/:id');
    expect(result.controls.some((control) => control.effect_id === 'platform_io.project.delete')).toBe(false);
  });

  it('renders two complete scans byte-for-byte identically', async () => {
    const scannerConfig = loadScannerLifecycleConfig(ROOT);
    const options = {
      baselineDate: scannerConfig.currentBaselineDate,
      scannerConfig,
      noGit: true,
    } as const;
    const [a, b] = await Promise.all([
      buildInventory(options),
      buildInventory(options),
    ]);
    expect(renderInventory(a)).toEqual(renderInventory(b));
  });

  it('fingerprints true scanner inputs while enforcement-only bytes stay separately protected', () => {
    const fingerprint = computeScannerConfigurationFingerprint(resolve(import.meta.dir, '../..'));
    expect(fingerprint.domains.some((row) => row.path === 'scripts/ai-native/control-id.ts')).toBe(false);
    expect(fingerprint.domains.some((row) => row.path === 'scripts/ai-native/evidence-file.ts')).toBe(false);
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
    expect(enforcement.configuration_files).toContain('scripts/ai-native/evidence-file.ts');
    expect(enforcement.configuration_files).toContain('package.json');
    const inventoryFingerprint = computeInventoryScannerConfigurationFingerprint(ROOT);
    expect(inventoryFingerprint.domains.some((row) => row.path === 'scripts/ai-native/vocab-config.json')).toBe(true);
    expect(inventoryFingerprint.domains.some((row) => row.path === 'scripts/ai-native/vocab-map.json')).toBe(false);
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

  it('ignores only artifact_commit when comparing a frozen scan after a tooling commit', () => {
    const artifact = (commit: string, product = '496b4c26') => ({
      'controls.jsonl': '{"control_id":"ctl_example"}\n',
      'meta.json': `${JSON.stringify({
        baseline_id: 'b0-2026-07-17-0.5.0',
        scanner_version: '0.5.0',
        scanned_product_combo: { studio: product },
        artifact_commit: commit,
      }, null, 2)}\n`,
    });

    expect(verificationArtifacts(artifact('uncommitted'))).toEqual(verificationArtifacts(artifact('tooling-commit-sha')));
    expect(verificationArtifacts(artifact('uncommitted'))).not.toEqual(verificationArtifacts(artifact('tooling-commit-sha', 'changed-product')));
  });

  it('requires an explicit baseline date for verify and freeze paths', () => {
    expect(() => parseScannerArgs(['--verify'])).toThrow(/baseline-date/);
    expect(() => parseScannerArgs([])).toThrow(/baseline-date/);
    expect(parseScannerArgs(['--verify', '--baseline-date', '2026-07-22']).baselineDate).toBe('2026-07-22');
    expect(parseScannerArgs(['--baseline-date', '2026-07-22']).baselineDate).toBe('2026-07-22');
    expect(parseScannerArgs(['--dry-run']).baselineDate).toBeUndefined();
    expect(parseScannerArgs(['--dry-run', '--no-git']).noGit).toBe(true);
    expect(parseScannerArgs(['--no-git', '--baseline-date', '2026-07-24']).noGit).toBe(true);
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

  it('keeps deterministic .tsx and interaction-shaped .ts negative layers in one sample', async () => {
    const scannerConfig = loadScannerLifecycleConfig(ROOT);
    const result = await buildInventory({
      baselineDate: scannerConfig.currentBaselineDate,
      scannerConfig,
      noGit: true,
    });
    expect(result.negativeCandidates.some((row) => row.layer === 'tsx' && row.file.endsWith('.tsx'))).toBe(true);
    expect(result.negativeCandidates.some((row) => row.layer === 'ts' && row.file.endsWith('.ts'))).toBe(true);
    const sample = stratifiedNegativeSample(result.negativeCandidates, 10, result.baselineId);
    expect(new Set(sample.map((row) => row.layer)).size).toBe(2);
    expect(sample.filter((row) => row.layer === 'tsx')).toHaveLength(5);
    expect(sample.filter((row) => row.layer === 'ts')).toHaveLength(5);
  });
});
