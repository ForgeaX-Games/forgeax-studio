import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGitlinkGraph, readAuthoritativeGitGraph, type AuthoritativeGitGraph } from './git-graph.ts';

describe('authoritative recursive gitlink graph projection', () => {
  test('does not treat a cached submodule with only .git metadata as materialized source', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-git-graph-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    try {
      git(root, 'init', '--quiet');
      git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
        'commit', '--quiet', '--allow-empty', '-m', 'fixture');
      const pin = git(root, 'rev-parse', 'HEAD');
      const cache = join(root, '.git/modules/child');
      mkdirSync(join(root, '.git/modules'), { recursive: true });
      git(root, 'clone', '--quiet', '--bare', root, cache);
      git(root, 'config', '--file', '.gitmodules', 'submodule.child.path', 'packages/child');
      git(root, 'config', '--file', '.gitmodules', 'submodule.child.url', root);
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},packages/child`);
      const child = join(root, 'packages/child');
      mkdirSync(child, { recursive: true });
      writeFileSync(join(child, '.git'), 'gitdir: missing-worktree-metadata\n');

      expect(readAuthoritativeGitGraph(root).nodes[0]?.reachable).toBe(false);
      writeFileSync(join(child, 'source.txt'), 'materialized source\n');
      expect(readAuthoritativeGitGraph(root).nodes[0]?.reachable).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('projects every nested node without a fixed path-count assumption', () => {
    const graph: AuthoritativeGitGraph = {
      sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
      nodes: [
        {
          path: 'packages/editor',
          pin: 'editor-a',
          children: [
            {
              path: 'packages/editor/packages/engine',
              pin: 'engine-a',
              children: [{ path: 'packages/editor/packages/engine/packages/runtime', pin: 'runtime-a' }],
            },
          ],
        },
        { path: 'packages/contracts', pin: 'contracts-a' },
      ],
    };

    expect(projectGitlinkGraph(graph)).toEqual({
      sourceIdentity: graph.sourceIdentity,
      pins: [
        { path: 'packages/contracts', pin: 'contracts-a' },
        { path: 'packages/editor', pin: 'editor-a' },
        { path: 'packages/editor/packages/engine', pin: 'engine-a' },
        { path: 'packages/editor/packages/engine/packages/runtime', pin: 'runtime-a' },
      ],
      unreachablePaths: [],
    });
  });

  test('retains unreachable nodes as explicit graph facts instead of dropping them', () => {
    const graph: AuthoritativeGitGraph = {
      sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
      nodes: [{ path: 'packages/contracts/types', pin: 'types-a', reachable: false }],
    };

    expect(projectGitlinkGraph(graph).unreachablePaths).toEqual(['packages/contracts/types']);
  });
});
