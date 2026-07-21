import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (file: string): string => readFileSync(join(root, 'scripts', file), 'utf8');

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

  it('stop delegates active server orphan matching to the tested signature helper', () => {
    const text = source('stop.ts');

    expect(text).toContain('activeServerSignature');
    expect(text).toContain('serverRuntimeInvocation(activeServer).orphanSignature');
    expect(text).toContain('serverOrphanNeedles(ROOT, activeServer)');
    expect(text).not.toContain('FX_ROOT_WIN');
  });

  it('desktop build takes package metadata and copied server files from the active package', () => {
    const text = source('build-desktop.ts');

    expect(text).toContain("readJson(join(activeServer.packageDir, 'package.json'))");
    expect(text).toContain("copyTree(join(activeServer.packageDir, 'src')");
    expect(text).toContain("join(activeServer.packageDir, 'builtin')");
    expect(text).toContain("join(activeServer.packageDir, 'tsconfig.json')");
    expect(text).toContain('desktopServerEntryAdapter(activeServer.entry)');
  });
});
