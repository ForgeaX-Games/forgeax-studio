import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectGitlinkGraph,
  readAuthoritativeGitGraph,
  type ProjectedGitGraph,
} from './git-graph.ts';
import { isRecursiveInputResult, type RecursiveInputResult } from './schema.ts';
import {
  createRecursiveInputResult,
  validateRecursiveInputResult,
} from './validator.ts';

const fixtureRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', join(cwd, '.git'), '--work-tree', cwd, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', '--local', 'user.name', 'recursive-input-fixture']);
  git(repo, ['config', '--local', 'user.email', 'recursive-input-fixture@example.invalid']);
  writeFileSync(join(repo, 'README.md'), `${name}\n`);
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', `initialize ${name}`]);
  return repo;
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', message]);
}

function addSubmodule(parent: string, source: string, path: string): void {
  git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, path]);
  commit(parent, `add ${path}`);
}

function createNestedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-deep-graph-'));
  fixtureRoots.push(root);

  const npcs = initRepo(root, 'npcs');
  const games = initRepo(root, 'games');
  addSubmodule(games, npcs, 'paopaotang/src/npcs');

  const types = initRepo(root, 'types');
  const contracts = initRepo(root, 'contracts');
  addSubmodule(contracts, types, 'types');

  const studio = initRepo(root, 'studio');
  addSubmodule(studio, games, 'packages/games');
  addSubmodule(studio, contracts, 'packages/contracts');
  git(studio, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);
  git(studio, ['remote', 'add', 'origin', 'fixture-root']);
  return studio;
}

function readyResult(graph: ProjectedGitGraph): RecursiveInputResult {
  return createRecursiveInputResult({
    graph,
    requestedInputClasses: ['source'],
    trustScope: 'ordinary-ci',
    job: 'deep-graph-consumer',
    attempt: 'deep-graph-attempt',
    producer: 'deep-graph-fixture',
    readiness: { source: { status: 'ready' } },
  });
}

function context(graph: ProjectedGitGraph) {
  return {
    graph,
    requestedInputClasses: ['source'] as const,
    trustScope: 'ordinary-ci' as const,
    job: 'deep-graph-consumer',
    attempt: 'deep-graph-attempt',
  };
}

describe('deep recursive input graph integration', () => {
  test('projects arbitrary two-level nested pins and rejects historical blocker-shaped gaps before consumption', () => {
    const root = createNestedFixture();
    const complete = projectGitlinkGraph(readAuthoritativeGitGraph(root));
    const expectedPaths = [
      'packages/contracts',
      'packages/contracts/types',
      'packages/games',
      'packages/games/paopaotang/src/npcs',
    ];

    expect(complete.pins.map((pin) => pin.path)).toEqual(expectedPaths);
    expect(complete.unreachablePaths).toEqual([]);

    const accepted = validateRecursiveInputResult(readyResult(complete), context(complete));
    expect(accepted.ok).toBe(true);

    rmSync(join(root, 'packages/games/paopaotang/src/npcs'), { recursive: true, force: true });
    rmSync(join(root, 'packages/contracts/types'), { recursive: true, force: true });
    const incomplete = projectGitlinkGraph(readAuthoritativeGitGraph(root));
    expect(incomplete.pins.map((pin) => pin.path)).toEqual(expectedPaths);
    expect(incomplete.unreachablePaths).toEqual([
      'packages/contracts/types',
      'packages/games/paopaotang/src/npcs',
    ]);

    const rejected = validateRecursiveInputResult(readyResult(incomplete), context(incomplete));
    expect(rejected.ok).toBe(false);
    expect(isRecursiveInputResult(rejected.result)).toBe(true);
    if (rejected.result.status === 'non-ready') {
      expect(rejected.result.failure.code).toBe('recursive-input.pin-unreachable');
      expect(rejected.result.failure.expected).toBe('all graph pins reachable');
      expect(rejected.result.failure.actual).toContain('packages/games/paopaotang/src/npcs');
      expect(rejected.result.failure.hint).toEqual(expect.any(String));
      expect(rejected.result.failure.recoveryActions.length).toBeGreaterThan(0);
      expect(rejected.result.failure.actual).not.toContain('ENOENT');
    }
  });
});

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
