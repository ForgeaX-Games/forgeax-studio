import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  formatPinSummary,
  isHumanActor,
  parseGitlink,
  parseRemoteHead,
  planPinUpdates,
  type RootPin,
} from './daily-pin-bump.ts';
import { parseGitmodules, resolveSubmoduleUrl, trackingBranch } from '../check-submodule-pins.ts';

const baseSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const dailyWorkflow = readFileSync(join(import.meta.dir, '../../.github/workflows/daily-pin-bump.yml'), 'utf8');

describe('daily Studio pin bump planning', () => {
  it('resolves relative submodule URLs and defaults tracking branches to main', () => {
    const modules = parseGitmodules([
      '[submodule "chat"]',
      '\tpath = packages/chat',
      '\turl = ../forgeax-chat.git',
    ].join('\n'));
    expect(modules).toHaveLength(1);
    expect(resolveSubmoduleUrl(modules[0].url, 'https://github.com/ForgeaX-Games/forgeax-studio.git'))
      .toBe('https://github.com/ForgeaX-Games/forgeax-chat.git');
    expect(trackingBranch(modules[0])).toBe('main');
  });

  it('parses only the exact mode-160000 root gitlink', () => {
    expect(parseGitlink(`160000 commit ${baseSha}\tpackages/chat\n`, 'packages/chat')).toBe(baseSha);
    expect(() => parseGitlink(`100644 blob ${baseSha}\tpackages/chat\n`, 'packages/chat')).toThrow();
  });

  it('parses the requested remote branch and rejects ambiguous output', () => {
    expect(parseRemoteHead(`${nextSha}\trefs/heads/main\n`, 'refs/heads/main')).toBe(nextSha);
    expect(() => parseRemoteHead(`${nextSha}\trefs/heads/dev\n`, 'refs/heads/main')).toThrow();
    expect(() => parseRemoteHead(`${nextSha}\trefs/heads/main\n${baseSha}\trefs/heads/main\n`, 'refs/heads/main')).toThrow();
  });

  it('does not plan a pin when the remote head is unchanged', () => {
    const pins: RootPin[] = [{ path: 'packages/chat', url: 'https://example.test/chat.git', branch: 'main', currentSha: baseSha }];
    expect(planPinUpdates(pins, new Map([['packages/chat', baseSha]]))).toEqual([]);
    expect(formatPinSummary([])).toContain('No direct Studio submodule pins');
  });

  it('plans every changed direct pin without mutating unrelated entries', () => {
    const pins: RootPin[] = [
      { path: 'packages/chat', url: 'https://example.test/chat.git', branch: 'main', currentSha: baseSha },
      { path: 'packages/editor', url: 'https://example.test/editor.git', branch: 'main', currentSha: nextSha },
    ];
    const updates = planPinUpdates(pins, new Map([
      ['packages/chat', nextSha],
      ['packages/editor', nextSha],
    ]));
    expect(updates).toEqual([{ ...pins[0], nextSha }]);
    expect(formatPinSummary(updates)).toContain(`packages/chat: ${baseSha} -> ${nextSha}`);
  });

  it('fails closed for invalid remote heads and bot actors', () => {
    const pins: RootPin[] = [{ path: 'packages/chat', url: 'https://example.test/chat.git', branch: 'main', currentSha: baseSha }];
    expect(() => planPinUpdates(pins, new Map([['packages/chat', 'not-a-sha']]))).toThrow();
    expect(isHumanActor('maoruibin001')).toBe(true);
    expect(isHumanActor('github-actions[bot]')).toBe(false);
    expect(isHumanActor('')).toBe(false);
  });

  it('refreshes the root lockfile after materializing changed child pins', () => {
    const materialize = dailyWorkflow.indexOf('git submodule update --init --recursive --jobs 4');
    const commit = dailyWorkflow.indexOf('name: Commit and push pin batch');
    expect(materialize).toBeGreaterThanOrEqual(0);
    expect(dailyWorkflow).toContain('bun install --lockfile-only --ignore-scripts');
    expect(materialize).toBeLessThan(commit);
  });

  it('uses gh fields supported by the runner CLI for post-PR diagnostics', () => {
    expect(dailyWorkflow).toContain('--json number,url,state,isDraft,headRefName,baseRefName,mergeStateStatus,mergeable');
    expect(dailyWorkflow).not.toContain('autoMergeRequest');
  });
});
