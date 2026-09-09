import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

type SubmoduleEntry = {
  name: string;
  path: string;
};

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function git(cwd: string, args: string[]): string {
  return gitOutput(cwd, args).trim();
}

function submoduleReachable(repo: string, entry: SubmoduleEntry, child: string): boolean {
  try {
    const status = gitOutput(repo, ['submodule', 'status', '--', entry.path]);
    const line = status.split(/\r?\n/).find((candidate) => candidate.length > 0);
    // Git's leading status marker is meaningful here: '-' means that the
    // worktree is not initialized.  '+' and 'U' still have a reachable
    // worktree; pin correctness is enforced by the materializer post-check.
    if (line && line[0] !== '-') return true;
  } catch {
    // Fall through to the explicit module-cache check below.  Some runners
    // keep submodule gitdirs outside the worktree, which can make the status
    // command lose its leading marker even though Git can still operate on
    // the cached checkout.
  }

  try {
    const moduleGitDirValue = git(repo, ['rev-parse', '--git-path', `modules/${entry.name}`]);
    const moduleGitDir = resolve(repo, moduleGitDirValue);
    if (!existsSync(moduleGitDir) || !existsSync(child)) return false;
    if (!readdirSync(child).some((name) => name !== '.git')) return false;
    execFileSync(
      'git',
      ['--git-dir', moduleGitDir, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

function submoduleEntries(repo: string): SubmoduleEntry[] {
  try {
    return git(repo, ['config', '--file', '.gitmodules', '--get-regexp', 'path'])
      .split(/\r?\n/)
      .map((line) => {
        const [key, ...pathParts] = line.trim().split(/\s+/);
        if (!key?.startsWith('submodule.') || !key.endsWith('.path') || pathParts.length === 0) return null;
        return { name: key.slice('submodule.'.length, -'.path'.length), path: pathParts.join(' ') };
      })
      .filter((entry): entry is SubmoduleEntry => {
        if (entry === null || entry.name.length === 0 || entry.path.length === 0) return false;
        try {
          // update=none is the committed marketplace declaration for a retired
          // recursive input. It remains a gitlink for history, but is not part
          // of the current materialized input graph or its digest.
          return git(repo, ['config', '--file', '.gitmodules', '--get', `submodule.${entry.name}.update`]) !== 'none';
        } catch {
          return true;
        }
      });
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

  const walk = (repo: string, prefix: string): AuthoritativeGitGraphNode[] => submoduleEntries(repo).map((entry) => {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    const pin = git(repo, ['rev-parse', `:${entry.path}`]);
    const child = join(repo, entry.path);
    const reachable = submoduleReachable(repo, entry, child);
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
