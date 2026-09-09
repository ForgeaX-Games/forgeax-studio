#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';

export type CommitRecord = { sha: string; message: string };
export type IssueLookup = (number: number) => Promise<{ kind: 'issue' | 'pull-request' | 'missing' }>;

const ZERO_SHA = /^0+$/;

export function isReleaseBranch(branch: string): boolean {
  return branch.startsWith('release');
}

export function issueNumbersFromMessage(message: string, repository = 'ForgeaX-Games/forgeax-studio'): number[] {
  const numbers = new Set<number>();
  const withoutIssueUrls = message.replace(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/[1-9]\d*\b/gi, '');
  for (const match of withoutIssueUrls.matchAll(/(?:^|[^\w])#([1-9]\d*)\b/gm)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}

export function releaseOnlyCommitRange(after: string): string[] {
  if (!after || ZERO_SHA.test(after)) throw new Error('release branch head SHA is required');
  return ['rev-list', '--reverse', `origin/main..${after}`];
}

export async function validateCommitIssueLinks(commits: CommitRecord[], lookup: IssueLookup) {
  const failures: Array<{ sha: string; code: 'issue-reference-missing' | 'issue-reference-invalid'; issueNumbers: number[] }> = [];
  for (const commit of commits) {
    const issueNumbers = issueNumbersFromMessage(commit.message, process.env.GITHUB_REPOSITORY);
    if (issueNumbers.length === 0) {
      failures.push({ sha: commit.sha, code: 'issue-reference-missing', issueNumbers });
      continue;
    }
    const records = await Promise.all(issueNumbers.map(lookup));
    if (!records.some((record) => record.kind === 'issue')) {
      failures.push({ sha: commit.sha, code: 'issue-reference-invalid', issueNumbers });
    }
  }
  return { ok: failures.length === 0, failures };
}

function githubApi(repository: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<any>;
  };
}

function commitsFromGit(after: string): CommitRecord[] {
  const shas = execFileSync('git', releaseOnlyCommitRange(after), { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  return shas.map((sha) => ({ sha, message: execFileSync('git', ['show', '-s', '--format=%B', sha], { encoding: 'utf8' }) }));
}

async function ensureMainPullRequest(api: ReturnType<typeof githubApi>, repository: string, branch: string, issueNumbers: number[]) {
  const owner = repository.split('/')[0];
  const query = `?state=all&base=main&head=${encodeURIComponent(`${owner}:${branch}`)}`;
  const existing = await api(`/pulls${query}`);
  const open = existing.find((pull: any) => pull.state === 'open');
  if (open) return { action: 'reused', url: open.html_url };
  const closed = existing.find((pull: any) => pull.state === 'closed' && !pull.merged_at);
  if (closed) {
    const reopened = await api(`/pulls/${closed.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    return { action: 'reopened', url: reopened.html_url };
  }
  try {
    const created = await api('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        base: 'main',
        head: branch,
        title: `release: synchronize ${branch} to main`,
        body: `Automated main synchronization for \`${branch}\`.\n\nTracked issues: ${issueNumbers.map((number) => `#${number}`).join(', ')}`,
      }),
    });
    return { action: 'created', url: created.html_url };
  } catch (error) {
    // Another actor (for example nightly-release) may win the create race.
    const raced = await api(`/pulls${query}`);
    const racedOpen = raced.find((pull: any) => pull.state === 'open');
    if (racedOpen) return { action: 'reused-after-race', url: racedOpen.html_url };
    throw error;
  }
}

export async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const branch = process.env.RELEASE_BRANCH ?? '';
  const after = process.env.RELEASE_HEAD_SHA ?? '';
  if (!repository || !token || !isReleaseBranch(branch)) throw new Error('GITHUB_REPOSITORY, GH_TOKEN, and a release-prefixed branch are required');

  const api = githubApi(repository, token);
  const commits = commitsFromGit(after);
  if (commits.length === 0) {
    console.log(JSON.stringify({ status: 'synchronized', branch, commits: [], issueNumbers: [], pullRequest: null }, null, 2));
    return;
  }
  const validation = await validateCommitIssueLinks(commits, async (number) => {
    try {
      const record = await api(`/issues/${number}`);
      return { kind: record.pull_request ? 'pull-request' as const : 'issue' as const };
    } catch (error) {
      if (String(error).includes(' returned 404:')) return { kind: 'missing' as const };
      throw error;
    }
  });
  if (!validation.ok) {
    for (const failure of validation.failures) console.error(`::error::${failure.sha}: ${failure.code} (${failure.issueNumbers.join(', ') || 'none'})`);
    process.exitCode = 1;
    return;
  }
  const issueNumbers = [...new Set(commits.flatMap((commit) => issueNumbersFromMessage(commit.message, repository)))];
  const pullRequest = await ensureMainPullRequest(api, repository, branch, issueNumbers);
  console.log(JSON.stringify({ status: 'passed', branch, commits: commits.map(({ sha }) => sha), issueNumbers, pullRequest }, null, 2));
}

if (import.meta.main) await main();
