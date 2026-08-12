import { describe, expect, test } from 'bun:test';
import {
  runtimeProcessBelongsToInstance,
  windowsSnapshotFromProcessTable,
  type RuntimeProcessSnapshot,
} from './runtime-process-owner.ts';
import { resolve } from 'node:path';

const root = resolve('/work/forgeax');
const snapshot = (commandLine: string | null, cwd: string | null): RuntimeProcessSnapshot => ({
  pid: 4242, commandLine, cwd,
});
const windowsSnapshot = (
  commandLine: string,
  ancestorCommandLines: readonly string[] = [],
): RuntimeProcessSnapshot => ({
  pid: 4242, commandLine, cwd: null, ancestorCommandLines,
});

test('ignores the Windows System Idle Process row when parsing process snapshots', () => {
  const output = JSON.stringify([
    { ProcessId: 0, ParentProcessId: 0, CommandLine: null },
    { ProcessId: 4242, ParentProcessId: 1, CommandLine: `bun ${root}/scripts/local-runtime.ts --profile web-dev` },
  ]);

  expect(windowsSnapshotFromProcessTable(4242, output)).toEqual({
    pid: 4242,
    commandLine: `bun ${root}/scripts/local-runtime.ts --profile web-dev`,
    cwd: null,
    ancestorCommandLines: [],
  });
});

describe('runtimeProcessBelongsToInstance', () => {
  test('accepts only the exact local-runtime launcher path and cwd', () => {
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun ${root}/scripts/local-runtime.ts --profile web-dev`, root,
    ), { root, service: 'launcher', stateServiceKey: 'launcher', managedPortKey: 'launcher' })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun ${root}/scripts/local-runtime.ts`, `${root}-copy`,
    ), { root, service: 'launcher' })).toBe(false);
  });

  test('rejects root-prefix command lines and unrelated commands from the same root', () => {
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun ${root}-copy/scripts/local-runtime.ts`, root,
    ), { root, service: 'launcher' })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun ${root}/scripts/check-layers.ts`, root,
    ), { root, service: 'launcher' })).toBe(false);
  });

  test('requires the selected server entry and server package cwd', () => {
    const activeServer = { packageDir: `${root}/packages/server-override`, entry: 'src/override-main.ts' };
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun --watch ${root}/packages/server-override/src/override-main.ts`, activeServer.packageDir,
    ), { root, service: 'server', activeServer, stateServiceKey: 'server', managedPortKey: 'server' })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun --watch ${root}/packages/server-override/src/unrelated.ts`, activeServer.packageDir,
    ), { root, service: 'server', activeServer })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot(
      `bun --watch ${root}/packages/server-override/src/override-main.ts`, `${root}/packages/server`,
    ), { root, service: 'server', activeServer })).toBe(false);
  });

  test('accepts Vite only from its exact interface and engine cwd', () => {
    expect(runtimeProcessBelongsToInstance(snapshot('bun x vite', `${root}/packages/studio`), {
      root, service: 'interface', stateServiceKey: 'interface', managedPortKey: 'interface',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('bun x vite', `${root}/packages/interface`), {
      root, service: 'interface', interfaceDir: `${root}/packages/interface`,
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('bun x vite', `${root}/packages/interface`), {
      root, service: 'interface',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('bun x vite', `${root}/packages/editor/packages/play-runtime`), {
      root, service: 'engine', stateServiceKey: 'engine', managedPortKey: 'engine',
    })).toBe(true);
    for (const [service, cwd, commandLine] of [
      ['interface', `${root}/packages/interface`, `node ${root}/packages/interface/node_modules/.bin/vite`] as const,
      ['engine', `${root}/packages/editor/packages/play-runtime`, `node ${root}/packages/editor/packages/play-runtime/node_modules/vite/bin/vite.js`] as const,
      ['rhi-debug-reviewer', `${root}/packages/editor/packages/engine`, `node ${root}/packages/editor/packages/engine/node_modules/.bin/vite`] as const,
    ]) {
      expect(runtimeProcessBelongsToInstance(snapshot(commandLine, cwd), {
        root, service, ...(service === 'interface' ? { interfaceDir: cwd } : {}),
      })).toBe(true);
    }
    expect(runtimeProcessBelongsToInstance(snapshot(
      `node ${root}/packages/interface-copy/node_modules/.bin/vite`, `${root}/packages/interface`,
    ), { root, service: 'interface', interfaceDir: `${root}/packages/interface` })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot(
      `node ${root}/packages/interface/node_modules/.bin/vite`, `${root}/packages/interface-copy`,
    ), { root, service: 'interface', interfaceDir: `${root}/packages/interface` })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('node scripts/unrelated.js', `${root}/packages/interface`), {
      root, service: 'interface', interfaceDir: `${root}/packages/interface`,
    })).toBe(false);
  });

  test('handles narrative, reviewer, and all plugin process shapes with exact boundaries', () => {
    expect(runtimeProcessBelongsToInstance(snapshot(
      'npx tsx --env-file=.env src/api/server.ts', `${root}/packages/marketplace/extensions/wb-narrative`,
    ), { root, service: 'narrative', stateServiceKey: 'narrative', managedPortKey: 'narrative' })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('pnpm exec vite', `${root}/packages/editor/packages/engine`), {
      root, service: 'rhi-debug-reviewer', stateServiceKey: 'rhi-debug-reviewer', managedPortKey: 'rhi-reviewer',
    })).toBe(true);
    const pluginDir = `${root}/packages/marketplace/extensions/wb-lowpoly-obj`;
    expect(runtimeProcessBelongsToInstance(snapshot('bun run dev', pluginDir), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', stateServiceKey: 'plugin-lowpoly', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('bun run dev', `${pluginDir}-copy`), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('bun run dev', pluginDir), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', stateServiceKey: 'plugin-lowpoly', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('vite --host 127.0.0.1', pluginDir), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot(`node ${pluginDir}/node_modules/vite/bin/vite.js`, `${pluginDir}/frontend`), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('tsx --watch backend/src/main.ts', pluginDir), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('node backend/dist/main.js', `${pluginDir}/backend`), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('node scripts/serve-dist.mjs', `${pluginDir}/frontend`), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('vite --host 127.0.0.1', pluginDir), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('vite --host 127.0.0.1', pluginDir), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('python -m http.server', pluginDir), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('node unrelated.js', `${pluginDir}/backend`), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('node dist/server.js', pluginDir), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('node scripts/headless-renderer.mjs', pluginDir), {
      root, service: 'plugin-headless', pluginDir, pluginShortId: 'lowpoly', stateServiceKey: 'plugin-lowpoly-headless',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot('node scripts/headless-renderer.mjs', pluginDir), {
      root, service: 'plugin-headless', pluginDir, pluginShortId: 'lowpoly', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('bun run dev', pluginDir), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'not_valid', pluginCommand: 'dev',
    })).toBe(false);
  });

  test('fails closed for unknown services, unavailable snapshots, and PID reuse', () => {
    expect(runtimeProcessBelongsToInstance(snapshot('bun --watch unrelated.ts', `${root}/packages/server`), {
      root, service: 'server', activeServer: { packageDir: `${root}/packages/server`, entry: 'src/main.ts' },
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(null, { root, service: 'launcher' })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot(null, root), { root, service: 'launcher' })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot(`bun ${root}/scripts/local-runtime.ts`, null), { root, service: 'launcher' })).toBe(false);
    expect(runtimeProcessBelongsToInstance(snapshot('bun x vite', `${root}/packages/studio`), {
      root, service: 'unknown-service' as never,
    })).toBe(false);
  });

  test('uses Windows parent-chain evidence only when cwd is unavailable', () => {
    // local-runtime imports run.ts in-process, so run.ts is never an OS
    // ancestor of the services it starts.
    const localRuntimeAncestor = `bun ${root}/scripts/local-runtime.ts --profile web-dev`;
    const runOnlyAncestor = `bun ${root}/scripts/run.ts`;
    expect(runtimeProcessBelongsToInstance(windowsSnapshot(
      `bun ${root}/scripts/local-runtime.ts --profile web-dev`,
    ), { root, service: 'launcher' })).toBe(true);

    const activeServer = { packageDir: `${root}/packages/server`, entry: 'src/main.ts' };
    expect(runtimeProcessBelongsToInstance(windowsSnapshot(
      `bun --watch ${root}/packages/server/src/main.ts`,
    ), { root, service: 'server', activeServer, stateServiceKey: 'server' })).toBe(true);

    // The launcher is stored in RuntimeState without a cwd, while port scans
    // find its live Vite child after the wrapper has become an orphan.
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('vite --host 127.0.0.1', [localRuntimeAncestor]), {
      root, service: 'interface', stateServiceKey: 'interface', managedPortKey: 'interface',
    })).toBe(true);
    const pluginDir = `${root}/packages/marketplace/extensions/wb-lowpoly-obj`;
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('vite --host 127.0.0.1', [localRuntimeAncestor]), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(true);

    // Every non-launcher source service needs the actual local-runtime parent
    // in addition to its production command signature.
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('bun x vite', [localRuntimeAncestor]), {
      root, service: 'engine', stateServiceKey: 'engine', managedPortKey: 'engine',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot(
      'npx tsx --env-file=.env src/api/server.ts', [localRuntimeAncestor],
    ), { root, service: 'narrative', stateServiceKey: 'narrative', managedPortKey: 'narrative' })).toBe(true);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('pnpm exec vite', [localRuntimeAncestor]), {
      root, service: 'rhi-debug-reviewer', stateServiceKey: 'rhi-debug-reviewer', managedPortKey: 'rhi-reviewer',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('bun run dev', [localRuntimeAncestor]), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', stateServiceKey: 'plugin-lowpoly', managedPortKey: 'plugin-lowpoly-backend',
    })).toBe(true);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('node scripts/headless-renderer.mjs', [localRuntimeAncestor]), {
      root, service: 'plugin-headless', pluginDir, pluginShortId: 'lowpoly', stateServiceKey: 'plugin-lowpoly-headless',
    })).toBe(true);

    expect(runtimeProcessBelongsToInstance(windowsSnapshot('vite --host 127.0.0.1', [runOnlyAncestor]), {
      root, service: 'interface', stateServiceKey: 'interface', managedPortKey: 'interface',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('vite --host 127.0.0.1', [`bun ${root}-copy/scripts/local-runtime.ts`]), {
      root, service: 'interface', stateServiceKey: 'interface', managedPortKey: 'interface',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('vite --host 127.0.0.1'), {
      root, service: 'interface', stateServiceKey: 'interface', managedPortKey: 'interface',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('python -m http.server', [localRuntimeAncestor]), {
      root, service: 'plugin-frontend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', managedPortKey: 'plugin-lowpoly-frontend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot('bun run dev', [localRuntimeAncestor]), {
      root, service: 'plugin-backend', pluginDir, pluginShortId: 'lowpoly', pluginCommand: 'dev', stateServiceKey: 'plugin-lowpoly-unknown', managedPortKey: 'plugin-lowpoly-unknown-backend',
    })).toBe(false);
    expect(runtimeProcessBelongsToInstance(windowsSnapshot(
      `bun ${root}-copy/scripts/local-runtime.ts`,
    ), { root, service: 'launcher' })).toBe(false);
  });
});
