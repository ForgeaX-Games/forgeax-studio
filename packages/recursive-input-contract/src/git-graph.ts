import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RecursivePin, SourceIdentity } from './schema.ts';

export type AuthoritativeGitGraphNode = {
  path: string;
  pin: string;
  reachable?: boolean;
  children?: AuthoritativeGitGraphNode[];
};

export type AuthoritativeGitGraph = {
  sourceIdentity: SourceIdentity;
  nodes: AuthoritativeGitGraphNode[];
};

export type ProjectedGitGraph = {
  sourceIdentity: SourceIdentity;
  pins: RecursivePin[];
  unreachablePaths: string[];
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function submodulePaths(repo: string): string[] {
  try {
    return git(repo, ['config', '--file', '.gitmodules', '--get-regexp', 'path'])
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((path): path is string => Boolean(path));
  } catch {
    return [];
  }
}

export function readAuthoritativeGitGraph(root: string): AuthoritativeGitGraph {
  const revision = git(root, ['rev-parse', 'HEAD']);
  const repository = (() => {
    try {
      return git(root, ['config', '--get', 'remote.origin.url']) || root;
    } catch {
      return root;
    }
  })();

  const walk = (repo: string, prefix: string): AuthoritativeGitGraphNode[] => submodulePaths(repo).map((path) => {
    const fullPath = prefix ? `${prefix}/${path}` : path;
    const pin = git(repo, ['rev-parse', `:${path}`]);
    const child = join(repo, path);
    const reachable = existsSync(join(child, '.git'));
    return {
      path: fullPath,
      pin,
      reachable,
      children: reachable ? walk(child, fullPath) : [],
    };
  });

  return {
    sourceIdentity: { repository, revision },
    nodes: walk(root, ''),
  };
}

export function projectGitlinkGraph(graph: AuthoritativeGitGraph): ProjectedGitGraph {
  const pins: RecursivePin[] = [];
  const unreachablePaths: string[] = [];
  const seen = new Set<string>();

  const visit = (nodes: readonly AuthoritativeGitGraphNode[]): void => {
    for (const node of nodes) {
      if (!node.path || !node.pin || seen.has(node.path)) {
        throw new Error(`invalid or duplicate gitlink graph node: ${node.path || '(empty)'}`);
      }
      seen.add(node.path);
      pins.push({ path: node.path, pin: node.pin });
      if (node.reachable === false) unreachablePaths.push(node.path);
      visit(node.children ?? []);
    }
  };

  visit(graph.nodes);
  pins.sort((left, right) => left.path.localeCompare(right.path));
  unreachablePaths.sort((left, right) => left.localeCompare(right));
  return { sourceIdentity: graph.sourceIdentity, pins, unreachablePaths };
}
