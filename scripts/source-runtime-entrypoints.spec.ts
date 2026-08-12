import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCRIPTS = import.meta.dir;

function executableScripts(dir = SCRIPTS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return executableScripts(path);
    if (/\.spec\.[cm]?[jt]s$/.test(entry.name)) return [];
    return /\.(?:[cm]?[jt]s|sh)$/.test(entry.name) ? [path] : [];
  });
}

describe('source runtime process entrypoints', () => {
  test('routes the production dev wrapper through fx while preserving argv', () => {
    const dev = readFileSync(join(SCRIPTS, 'dev.ts'), 'utf8');

    expect(dev).toContain("join(ROOT, 'scripts/fx.ts'), 'start', 'web', ...process.argv.slice(2)");
    expect(dev).toContain('source-runtime-launcher remains the only dotenv + RuntimeInstance');
    expect(dev).not.toContain("join(ROOT, 'scripts/local-runtime.ts')");
  });

  test('lets the isolated smoke tool use the service-graph child with an explicit profile', () => {
    const smoke = readFileSync(join(SCRIPTS, 'wave1/studio-compatibility-smoke.ts'), 'utf8');

    expect(smoke).toContain("['scripts/local-runtime.ts', '--profile', 'web-dev']");
    expect(smoke).toContain('FORGEAX_SERVER_PORT: String(serverPort)');
    expect(smoke).toContain('FORGEAX_INTERFACE_PORT: String(interfacePort)');
    expect(smoke).toContain('FORGEAX_ENGINE_PORT: String(enginePort)');
  });

  test('keeps local-runtime as the only service-graph child that imports run.ts', () => {
    const offenders: string[] = [];
    for (const file of executableScripts()) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*#(?!\!).*$/gm, '');
      const importsRun = /(?:\bimport\s*\(|\bfrom\s+)[\s\S]{0,120}?["'][^"']*run\.ts["']/.test(source);
      const spawnsRun = /\b(?:spawn|spawnSync)\s*\([\s\S]{0,240}?["'][^"']*run\.ts["']/.test(source);
      const shellsRun = /\bbun\s+[^\n]*scripts\/run\.ts/.test(source);
      if (importsRun || spawnsRun || shellsRun) offenders.push(relative(SCRIPTS, file));
    }

    expect(offenders).toEqual(['local-runtime.ts']);
    expect(readFileSync(join(SCRIPTS, 'local-runtime.ts'), 'utf8')).toContain("await import('./run.ts')");
  });

  test('rejects direct run.ts execution before touching run.lock', () => {
    const run = readFileSync(join(SCRIPTS, 'run.ts'), 'utf8');
    const contextGate = run.indexOf('const startup = consumeSourceRuntimeContext()');
    const lockAcquire = run.indexOf('StartLock.consumeRuntimeOwner(ROOT)');

    expect(contextGate).toBeGreaterThan(-1);
    expect(lockAcquire).toBeGreaterThan(contextGate);
    expect(run).not.toContain('new StartLock(ROOT)');
  });

});
