import { describe, expect, test } from 'bun:test';
import {
  concreteWorkspacePaths,
  missingWorkspacePackageJson,
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
});
