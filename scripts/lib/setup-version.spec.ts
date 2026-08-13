import { describe, expect, it } from 'bun:test';
import { computeInputDigest } from '../../packages/recursive-input-contract/src/digest.ts';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from '../../packages/recursive-input-contract/src/git-graph.ts';

describe('recursive input contract migration regression', () => {
  it('keeps identical root and recursive pin identity stable', () => {
    const graph: AuthoritativeGitGraph = {
      sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
      nodes: [{ path: 'packages/editor', pin: 'editor-pin-a' }],
    };
    const projected = projectGitlinkGraph(graph);
    expect(computeInputDigest({
      sourceIdentity: graph.sourceIdentity,
      recursivePins: projected.pins,
      requestedInputClasses: ['source'],
    })).toBe(computeInputDigest({
      sourceIdentity: graph.sourceIdentity,
      recursivePins: projected.pins,
      requestedInputClasses: ['source'],
    }));
  });

  it('detects recursive topology and pin drift without a legacy snapshot owner', () => {
    const projected = projectGitlinkGraph({
      sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
      nodes: [
        { path: 'packages/editor', pin: 'editor-pin-b' },
        { path: 'packages/server', pin: 'server-pin-a', reachable: false },
      ],
    });
    expect(projected.pins).toEqual([
      { path: 'packages/editor', pin: 'editor-pin-b' },
      { path: 'packages/server', pin: 'server-pin-a' },
    ]);
    expect(projected.unreachablePaths).toEqual(['packages/server']);
  });
});
