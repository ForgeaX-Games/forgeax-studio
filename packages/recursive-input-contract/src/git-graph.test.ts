import { describe, expect, test } from 'bun:test';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from './git-graph.ts';

describe('authoritative recursive gitlink graph projection', () => {
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
