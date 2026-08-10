import { describe, expect, test } from 'bun:test';
import {
  concreteWorkspacePaths,
  materializeWorkspaceSubmodules,
  missingWorkspacePackageJson,
  parseUnresolvedSubmoduleStatus,
  parseGitmodulesPaths,
  readWorkspaceGlobs,
} from './ensure-workspace-submodules.ts';

describe('ensure-workspace-submodules helpers', () => {
  test('parseGitmodulesPaths reads path = lines', () => {
    expect(
      parseGitmodulesPaths(`[submodule "forgeax-orchestrator"]
\tpath = packages/orchestrator
\turl = ../forgeax-orchestrator.git
[submodule "forgeax-cli"]
\tpath = packages/cli
\turl = ../forgeax-cli.git
`),
    ).toEqual(['packages/orchestrator', 'packages/cli']);
  });

  test('readWorkspaceGlobs + concreteWorkspacePaths skip globs', () => {
    const ws = readWorkspaceGlobs(
      JSON.stringify({
        workspaces: ['packages/cli', 'packages/editor/packages/engine/packages/*'],
      }),
    );
    expect(concreteWorkspacePaths(ws)).toEqual(['packages/cli']);
  });

  test('missingWorkspacePackageJson flags dirs without package.json', () => {
    const missing = missingWorkspacePackageJson('/tmp/does-not-exist-forgeax', [
      'packages/orchestrator',
      'packages/*/skip',
    ]);
    expect(missing).toEqual(['packages/orchestrator']);
  });

  test('keeps Unix and native Windows adapters on the same readiness fields', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      const isStatus = command === 'git' && args[0] === 'submodule' && args[1] === 'status';
      return {
        status: 0,
        stdout: isStatus ? ` ${'a'.repeat(40)} packages/editor\n` : '',
      };
    };

    const unix = materializeWorkspaceSubmodules('/tmp/recursive-input-unix-fixture', {
      platform: 'darwin',
      run,
    });
    const unixCallCount = calls.length;
    const windows = materializeWorkspaceSubmodules('/tmp/recursive-input-windows-fixture', {
      platform: 'win32',
      run,
    });

    expect(Object.keys(unix).sort()).toEqual(Object.keys(windows).sort());
    expect(unix.materializationStatus).toBe('ready');
    expect(unix.recursiveStatus).toBe('passed');
    expect(windows.materializationStatus).toBe('ready');
    expect(windows.recursiveStatus).toBe('passed');
    expect(unix.unresolvedPaths).toEqual([]);
    expect(windows.unresolvedPaths).toEqual([]);
    expect(unix.adapter).toBe('unix-shared-materializer');
    expect(windows.adapter).toBe('windows-direct-git');
    expect(calls.slice(0, unixCallCount)).toHaveLength(1);
    expect(calls.slice(unixCallCount).map(({ command, args }) => [command, args])).toEqual([
      ['git', ['submodule', 'sync', '--recursive']],
      ['git', ['submodule', 'update', '--init', '--recursive']],
      ['git', ['submodule', 'status', '--recursive']],
    ]);

    expect(windows.windowsLiveEvidence).toBe(
      process.platform === 'win32' ? 'native-runner-available' : 'external-acceptance-pending',
    );
  });

  test('turns an unresolved native Windows recursive status into non-ready', () => {
    const unresolved = `-${'b'.repeat(40)} packages/contracts/types\n`;
    const report = materializeWorkspaceSubmodules('/tmp/recursive-input-windows-fixture', {
      platform: 'win32',
      run: (command, args) => ({
        status: 0,
        stdout: command === 'git' && args[1] === 'status' ? unresolved : '',
      }),
    });

    expect(parseUnresolvedSubmoduleStatus(unresolved)).toEqual(['packages/contracts/types']);
    expect(report.status).toBe(1);
    expect(report.materializationStatus).toBe('non-ready');
    expect(report.recursiveStatus).toBe('failed');
    expect(report.unresolvedPaths).toEqual(['packages/contracts/types']);
  });
});
