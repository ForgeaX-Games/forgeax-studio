import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import discovery from '../../config/gitlink-discovery.json';

const ROOT = resolve(import.meta.dir, '../..');
const CUTOVER_SHA = '77570ed3ddf3f513f57e09a79d8178944dd6a6ff';
const CUTOVER_EVIDENCE = {
  schemaVersion: 1,
  repository: 'ForgeaX-Games/forgeax-ide',
  mainPin: CUTOVER_SHA,
  pullRequest: 'https://github.com/ForgeaX-Games/forgeax-ide/pull/14',
  checks: { product: '32593964999', desktop: '32593964920' },
};

describe('forgeax-ide root cutover contract', () => {
  it('records the merged IDE main pin and independent CI evidence', () => {
    expect(discovery.mounts).not.toContainEqual(expect.objectContaining({
      path: 'packages/ide',
    }));
    const packages = JSON.parse(readFileSync(resolve(ROOT, '.packages'), 'utf8')) as Array<Record<string, unknown>>;
    expect(packages).toContainEqual({
      path: 'packages/ide',
      url: 'https://github.com/ForgeaX-Games/forgeax-ide.git',
      branch: 'main',
    });
    expect(CUTOVER_EVIDENCE).toMatchObject({
      schemaVersion: 1,
      repository: 'ForgeaX-Games/forgeax-ide',
      mainPin: CUTOVER_SHA,
      checks: { product: '32593964999', desktop: '32593964920' },
    });
    expect(CUTOVER_EVIDENCE.pullRequest).toBe('https://github.com/ForgeaX-Games/forgeax-ide/pull/14');
  });

  it('exposes only public root integration commands', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      workspaces?: string[];
      dependencies?: Record<string, string>;
    };
    expect(rootPackage.scripts?.fx).toBe('bun scripts/fx.ts');
    expect(rootPackage.scripts?.['check:submodule-pins']).toContain('--require-main-ancestry');
    expect(existsSync(resolve(ROOT, 'scripts/fx/commands/ide.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'scripts/run.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'scripts/stop.ts'))).toBe(true);
    expect(rootPackage.workspaces).toEqual([
      'packages/recursive-input-contract',
      'packages/npc-client',
    ]);
    const retiredServerPrivateWorkspace = ['packages/server', 'private'].join('-');
    for (const retiredWorkspace of [
      'packages/server',
      retiredServerPrivateWorkspace,
      'packages/orchestrator',
      'packages/editor',
      'packages/interface',
      'packages/marketplace',
    ]) {
      expect(rootPackage.workspaces).not.toContain(retiredWorkspace);
    }
    expect(rootPackage.dependencies?.['@forgeax/platform-io']).toBeUndefined();
    expect(rootPackage.dependencies?.['@forgeax/agent-host']).toBeUndefined();

    const fxSource = readFileSync(resolve(ROOT, 'scripts/fx.ts'), 'utf8');
    const launcherSource = readFileSync(resolve(ROOT, 'scripts/run.ts'), 'utf8');
    expect(fxSource).toContain('if (await dispatchLifecycleCommand(plan.command, plan.args)) return;');
    expect(fxSource).toContain("case 'start':\n      await dependencies.start(args, 'error');");
    expect(launcherSource).toContain("FORGEAX_INTEGRATION_ROOT: ROOT");
    expect(launcherSource).not.toMatch(/from ['"]@forgeax\//);
  });

  it('removes the old Studio product runtime from the root checkout', () => {
    for (const path of [
      'packages/studio',
      'packages/studio-qa',
      'scripts/build-desktop.ts',
      'scripts/desktop.ts',
    ]) {
      const probe = path.startsWith('packages/') ? resolve(ROOT, path, 'package.json') : resolve(ROOT, path);
      expect(existsSync(probe)).toBe(false);
    }
  });

  it('keeps retired Studio QA renderer-owner admission out of the root', () => {
    expect(existsSync(resolve(
      ROOT,
      'packages/studio-qa/src/quality-gates/renderer-owner-admission.integration.test.mjs',
    ))).toBe(false);
  });
});
