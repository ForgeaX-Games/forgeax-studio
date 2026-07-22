import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildInventory,
  fixtureScan,
  renderInventory,
  scanServerEndpoints,
  stratifiedNegativeSample,
} from './scanner';
import { verificationArtifacts } from './scan';

describe('AI-native scanner', () => {
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
    expect(rule?.verified_applicability).toContain('editorRenderers.tsx:188');

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

  it('produces a self-consistent real-repository inventory', async () => {
    const result = await buildInventory({ baselineDate: '2026-07-17' });
    expect(result.baselineId).toBe('b0-2026-07-17-0.5.0');
    expect(result.stats.controls).toBe(572);
    expect(result.stats.rawOnClick).toBe(263);
    expect(result.stats.rawOnClickFiles).toBe(54);
    expect(result.stats.repoControlCounts).toEqual({ chat: 124, interface: 441, studio: 7 });
    expect(result.stats.repoOnClickCounts).toEqual({ chat: 66, interface: 195, studio: 2 });
    expect(result.stats.sourceCounts['action-palette']).toBe(25);
    expect(result.stats.sourceCounts['command-bus']).toBe(13);
    expect(result.stats.sourceCounts.shortcut).toBe(25);
    expect(result.stats.sourceCounts['navigation-link']).toBe(8);
    expect(result.stats.sourceCounts['native-menu']).toBe(16);
    expect(result.stats.sourceCounts['postmessage-handler']).toBe(2);
    expect(result.stats.sourceCounts['subscription-handler']).toBe(11);
    expect(result.stats.manualPool).toBe(128);
    expect(result.stats.effects).toBe(346);
    expect(result.stats.excluded).toBe(111);
    expect(result.stats.narrowSubscriptionCandidates).toBe(18);
    expect(result.stats.narrowSubscriptionRetained).toBe(4);
    expect(result.stats.narrowSubscriptionExcluded).toBe(14);
    expect(result.stats.narrowSubscriptionExclusionRules).toBe(14);
    expect(result.stats.diProviderBranches).toBe(1);
    expect(result.stats.diProviderAnnotations).toBe(1);
    expect(result.stats.diProviderManual).toBe(0);
    expect(result.stats.constantListenerCallSites).toBe(7);
    expect(result.stats.constantListenerEvents).toBe(26);
    expect(result.stats.unresolvedListenerExpressions).toBe(0);
    expect(result.constantListeners.every((row) => row.disposition === 'excluded')).toBe(true);
    expect(result.constantListeners.find((row) => row.expression === 't')?.events).toHaveLength(20);
    expect(result.stats.agentEquivalentEffects).toBe(25);
    expect(result.controls.some((row) => row.surface === 'shortcut' && row.event === 'Backspace (macOS) / Delete (other)')).toBe(true);
    expect(result.controls.find((row) => row.surface === 'shortcut' && row.event === 'Esc')?.notes).toContain('editor-injected');
    expect(result.stats.actualUseSurfaceCalls).toBe(2);
    expect(result.stats.sourceCounts['use-surface']).toBe(4);
    expect(result.stats.endpoints).toBe(84);
    expect(result.manualPool.some((row) => row.kind === 'route')).toBe(false);
    const serverRoutes = scanServerEndpoints();
    expect(serverRoutes.some((route) => route.method === 'POST' && route.path === '/api/telemetry')).toBe(true);
    expect(serverRoutes.some((route) => route.method === 'POST' && route.path === '/api/commands/:name/execute')).toBe(true);
    expect(serverRoutes.some((route) => route.path === '/:name/execute')).toBe(false);

    const ids = new Set(result.controls.map((row) => row.control_id));
    const effectIds = new Set(result.effects.map((row) => row.effect_id));
    expect(ids.size).toBe(result.controls.length);
    expect(effectIds.size).toBe(result.effects.length);
    expect(result.controls.every((row) => /^ctl_[0-9a-f]{24}$/.test(row.control_id))).toBe(true);
    expect(result.controls.every((row) => ['interface', 'chat', 'studio'].includes(row.repo))).toBe(true);
    expect(result.controls.every((row) => ['button', 'palette', 'shortcut', 'menu', 'rpc-handler', 'postmessage-handler', 'subscription-handler', 'dom', 'link'].includes(row.surface))).toBe(true);
    expect(result.controls.every((row) => ['direct', 'forwarded', 'manual-pool'].includes(row.propagation))).toBe(true);
    expect(result.controls.every((row) => ['us', 'editor', 'marketplace'].includes(row.owner))).toBe(true);
    expect(result.controls.every((row) => row.effect_id === null || effectIds.has(row.effect_id))).toBe(true);
    expect(result.edges.every((edge) => ids.has(edge.control_id))).toBe(true);
    expect(result.edges.every((edge) => effectIds.has(edge.effect_id))).toBe(true);
    expect(result.effects.every((effect) => effect.repo.length > 0)).toBe(true);
    expect(new Set(result.edges.map((edge) => `${edge.control_id}|${edge.effect_id}`)).size).toBe(result.edges.length);
    expect(result.controls.every((row) => !/\.(test|spec)\./.test(row.file) && !row.file.includes('/__tests__/'))).toBe(true);
    expect(result.controls.every((row) => !row.file.includes('packages/editor/packages/interface'))).toBe(true);

    const palette = result.controls.filter((row) => row.notes.includes('source=action-palette'));
    expect(palette).toHaveLength(25);
    expect(palette.every((row) => /\/(builtin-actions|trajectory)\.ts$/.test(row.file))).toBe(true);
    expect(palette.every((row) => readFileSync(row.file, 'utf8').split(/\r?\n/)[row.evidence_line - 1].includes('registerAction'))).toBe(true);
    const overlayOpen = palette.find((row) => row.effect_id === 'overlay.open');
    expect(overlayOpen?.file).toBe('packages/interface/src/lib/builtin-actions.ts');
    expect(overlayOpen?.evidence_line).toBe(256);

    const sessionCreate = result.effects.find((effect) => effect.effect_id === 'session.create');
    expect(sessionCreate?.server_endpoints).toContain('POST /api/sessions/');
    expect(sessionCreate?.agent_equiv.headless).toBe('yes');
    expect(result.effects.some((effect) => effect.effect_id === 'server.post_api_sessions')).toBe(false);
    expect(result.effects.find((effect) => effect.effect_id === 'game.create')?.server_endpoints).toContain('POST /api/workbench/games');
    expect(result.effects.filter((effect) => effect.agent_equiv.headless === 'yes').map((effect) => effect.effect_id).sort()).toEqual([
      'session.close',
      'session.create',
      'sessions.list',
    ]);
    expect(result.effects.every((effect) => effect.agent_equiv.tool?.runtime_fill === true)).toBe(true);
    const rpcToolCall = result.controls.find((row) => row.surface === 'rpc-handler' && row.event === 'onToolCall');
    expect(rpcToolCall?.effect_id).toBe('server.post_api_tools_call');
    expect(rpcToolCall?.effect_id).not.toBe('role.list');
    expect(result.controls.find((row) => row.surface === 'rpc-handler' && row.event === 'onChatPost')?.effect_id).toBe('chat.post_message');
    expect(result.controls.filter((row) => row.surface === 'rpc-handler').every((row) => row.effect_id !== null)).toBe(true);
    const postMessageControls = result.controls.filter((row) => row.surface === 'postmessage-handler');
    expect(postMessageControls).toHaveLength(2);
    expect(postMessageControls.find((row) => row.component === 'ExtensionIframeHost')?.effect_id).toBe('chat.insert_reference');
    const pointerCapture = postMessageControls.find((row) => row.file === 'packages/interface/src/main.tsx');
    expect(pointerCapture?.event).toBe('message:fx-pointer-capture');
    expect(pointerCapture?.propagation).toBe('manual-pool');
    expect(result.manualPool.some((row) => row.control_id === pointerCapture?.control_id)).toBe(true);
    expect(postMessageControls.every((row) => ![
      'packages/interface/src/components/StatusBar/healthBridge.ts',
      'packages/interface/src/lib/vag-action-bridge.ts',
      'packages/interface/src/lib/ui-bridge.ts',
    ].includes(row.file))).toBe(true);

    const subscriptionControls = result.controls.filter((row) => row.surface === 'subscription-handler');
    expect(subscriptionControls).toHaveLength(11);
    for (const [file, line] of [
      ['packages/studio/src/main.tsx', 175],
      ['packages/interface/src/main.tsx', 145],
      ['packages/interface/src/components/DockShell/DockRegion.tsx', 699],
    ] as const) {
      expect(subscriptionControls.some((row) => row.file === file && row.evidence_line === line && row.event === 'onSurfaceWindowClosed')).toBe(true);
    }
    expect(subscriptionControls.filter((row) => row.effect_id === null)).toHaveLength(7);
    for (const [line, effect] of [
      [200, 'edit_realm.set_viewport_epoch'],
      [234, null],
      [327, 'viewport_boot_overlay.set_stage'],
    ] as const) {
      expect(subscriptionControls.find((row) => (
        row.file === 'packages/studio/src/panels/editorRenderers.tsx'
        && row.evidence_line === line
        && row.event === 'on'
      ))?.effect_id).toBe(effect);
    }
    const hmrAudit = result.methodSubscriptionAudit.find((row) => row.evidence_line === 188 && row.receiver === 'import.meta.hot');
    expect(hmrAudit).toEqual(expect.objectContaining({
      disposition: 'excluded',
      decision: 'infrastructure-plumbing',
      topic: 'forgeax:game-code-change',
      control_id: null,
    }));
    expect(hmrAudit?.verified_applicability).toContain('editorRenderers.tsx:188');

    const previousControls = readFileSync(
      'docs/ai-native/baseline/b0-2026-07-17-0.4.0/controls.jsonl',
      'utf8',
    ).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { control_id: string });
    const currentControlIds = new Set(result.controls.map((row) => row.control_id));
    expect(previousControls).toHaveLength(568);
    expect(previousControls.filter((row) => !currentControlIds.has(row.control_id))).toEqual([]);

    const deleteShortcut = result.controls.find((row) => row.control_id === 'ctl_bd2d9f3c4e414bb2185b6479');
    expect(deleteShortcut?.effect_id).toBe('editor.delete_assets');
    expect(deleteShortcut?.notes).toContain('di_provider_branch=packages/studio/src/main.tsx:191');
    expect(deleteShortcut?.notes).toContain('confirmDeleteAssets invokes Promise.resolve, window.confirm');

    expect(result.summary).toContain('## Diff from b0-2026-07-17-0.4.0');
    expect(result.summary).toContain('Controls: **568 → 572 (+4)**');
    expect(result.summary).toContain('Canonical effects: **343 → 346 (+3)**');
    expect(result.summary).toContain('Manual-classification pool: **126 → 128 (+2)**');
    expect(result.summary).toContain('removed: **0**; identity migrations: **0**');
    expect(result.summary).toContain('identity migrations: **0**');
    expect(result.summary).toContain('`interface` **1**, `chat` **0**, `studio` **3**');
    expect(result.summary).toContain('Custom-subscription additions (A): **4**');
    expect(result.summary).toContain('**18** candidates; **4** retained; **14** excluded by **14** new signed call-scoped rules');
    expect(result.summary).toContain('### Lowercase method-family adjudication (all candidates)');
    expect(result.summary).toContain('`packages/studio/src/panels/editorRenderers.tsx:188`');
    expect(result.summary).toContain('Provider-DI annotations (B): **1** of **1** detected branches; **0** unassociated');
    expect(result.summary).toContain('Resolved **7** non-literal call sites into **26** event registrations');
    expect(result.summary).toContain('Other-team scale disclosure: **887** raw JSX event props');
    expect(result.otherTeamSurface.map(({ repo, controls }) => [repo, controls])).toEqual([
      ['editor', 232],
      ['marketplace', 543],
      ['settings', 53],
      ['workbench', 34],
      ['dashboard', 25],
    ]);
    expect((result.meta.scanned_product_combo as Record<string, string>).studio).toBe('496b4c26d8ecedf5beb49389d26f13cdac127538');
    expect(String(result.meta.artifact_commit)).toMatch(/^[0-9a-f]{40}$/);
    expect(result.meta.combo).toBeUndefined();
    expect(result.negativeCandidates.filter((row) => /\/(App|main)\.tsx$/.test(row.file)).every((row) => row.stratum.endsWith(':src'))).toBe(true);
    expect(result.negativeCandidates.filter((row) => /\/components\/[^/]+\.tsx$/.test(row.file)).every((row) => row.stratum.includes(':components'))).toBe(true);
  });

  it('renders two complete scans byte-for-byte identically', async () => {
    const [a, b] = await Promise.all([
      buildInventory({ baselineDate: '2026-07-17' }),
      buildInventory({ baselineDate: '2026-07-17' }),
    ]);
    expect(renderInventory(a)).toEqual(renderInventory(b));
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
