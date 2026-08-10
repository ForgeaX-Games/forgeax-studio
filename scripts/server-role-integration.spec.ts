import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (file: string): string => readFileSync(join(root, 'scripts', file), 'utf8');
const workflow = (file: string): string => readFileSync(join(root, '.github', 'workflows', file), 'utf8');

describe('server role script integration', () => {
  it.each(['run.ts', 'stop.ts', 'build-desktop.ts'])('%s delegates discovery to the shared resolver', (file) => {
    const text = source(file);

    expect(text).toContain("from './lib/server-role.ts'");
    expect(text).toContain('resolveActiveServerRole({');
    expect(text).not.toContain('runtimeRole');
    expect(text).not.toContain('forgeaxStudio');
  });

  it('run uses the active package for version output and launch', () => {
    const text = source('run.ts');

    expect(text).toContain("join(activeServer.packageDir, 'dist/version.json')");
    expect(text).toContain('serverRuntimeInvocation(activeServer)');
    expect(text).toContain("['--watch', activeServerRuntime.entryPath]");
    expect(text).toContain('cwd: activeServer.packageDir');
  });

  it('stop feeds active server selection into the current-instance ownership scope', () => {
    const text = source('stop.ts');

    expect(text).toContain('runtimeStateBelongsToInstance(instance, runtimeState)');
    expect(text).toContain('resolveInstanceStopScope(instance, runtimeState, { activeServer, interfaceDir })');
    expect(text).toContain('runtimeProcessBelongsToInstance');
    expect(text).not.toContain('activeServerSignature');
  });

  it('desktop build takes package metadata and copied server files from the active package', () => {
    const text = source('build-desktop.ts');

    expect(text).toContain("readJson(join(activeServer.packageDir, 'package.json'))");
    expect(text).toContain("copyTree(join(activeServer.packageDir, 'src')");
    expect(text).toContain("join(activeServer.packageDir, 'builtin')");
    expect(text).toContain("join(activeServer.packageDir, 'tsconfig.json')");
    expect(text).toContain('desktopServerEntryAdapter(activeServer.entry)');
  });

  it('CI smoke uses the canonical fx startup path and keeps auto server profile resolution', () => {
    const text = workflow('ci.yml');
    const smokeStep = text.match(
      /      - name: Smoke — bun fx start web \+ probe ports\n[\s\S]*?(?=\n      - name:)/,
    )?.[0];

    expect(smokeStep).toBeDefined();
    expect(smokeStep).toContain('nohup bun fx start web --skip-setup-check');
    expect(smokeStep).not.toContain('scripts/run.ts');
    expect(smokeStep).not.toContain('FORGEAX_SERVER_PROFILE: base');
  });
});
