import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatTable,
  GATE_ORDER,
  dirtyReposUnder,
  orderLeafFirst,
  parseLeftRight,
  parseSubmodulePaths,
  pickGates,
  planCommit,
  ROOT_GATE_ORDER,
  TAG_NUDGE_DISTANCE,
  tagDistance,
  tagNudge,
  type RepoInfo,
} from './lib/repos.ts';
import { repositoryCommandHelp } from './lib/repos-help.ts';

const repo = (over: Partial<RepoInfo>): RepoInfo => ({
  path: '',
  absPath: '/x',
  parent: null,
  branch: 'main',
  head: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  dirty: false,
  pin: '',
  ...over,
});

describe('scan helpers', () => {
  it('keeps every repository command self-describing without a repository scan', () => {
    for (const command of ['status', 'versions', 'sync', 'check', 'commit', 'bump']) {
      expect(repositoryCommandHelp(command)).toContain(`Usage: bun fx ${command}`);
    }
    expect(repositoryCommandHelp('unknown')).toBeUndefined();
  });

  it('places recursive-input preflight before the commit scan', () => {
    const source = readFileSync(resolve(import.meta.dir, 'repos.ts'), 'utf8');
    const commitBody = source.slice(source.indexOf('function commitCmd('), source.indexOf('// ── bump'));
    const preflight = commitBody.indexOf('verifyRecursiveInputForCommit');
    const scan = commitBody.indexOf('const repos = scanRepos(ROOT)');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(preflight);
    expect(commitBody).not.toContain('scanRepos(ROOT);\n  const preflight');
  });

  it('keeps commit preflight source-owned and does not add a build-output barrier', () => {
    const source = readFileSync(resolve(import.meta.dir, 'repos.ts'), 'utf8');
    const commitBody = source.slice(source.indexOf('function commitCmd('), source.indexOf('// ── bump'));

    expect(commitBody).toContain("'source'");
    expect(commitBody).toContain("'dependency-installation'");
    expect(commitBody).toContain("'toolchain'");
    expect(commitBody).toContain("'large-file-storage'");
    expect(commitBody).not.toContain("'build-output'");
  });

  it('runs boundary checker tests in CI', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../.github/workflows/boundaries.yml'), 'utf8');
    expect(workflow).toContain('run: bun run test:boundaries:fs');
  });

  it('parses submodule paths from git config output', () => {
    const out = 'submodule.packages/interface.path packages/interface\nsubmodule.packages/chat.path packages/chat\n';
    expect(parseSubmodulePaths(out)).toEqual(['packages/interface', 'packages/chat']);
    expect(parseSubmodulePaths('')).toEqual([]);
  });

  it('parses ahead/behind counts', () => {
    expect(parseLeftRight('3\t7')).toEqual({ ahead: 3, behind: 7 });
    expect(parseLeftRight('')).toEqual({ ahead: 0, behind: 0 });
  });

  it('orders leaf-first: nested before direct, root last', () => {
    const repos = [
      repo({ path: '' }),
      repo({ path: 'packages/editor', parent: '' }),
      repo({ path: 'packages/editor/packages/engine', parent: 'packages/editor' }),
    ];
    expect(orderLeafFirst(repos).map((r) => r.path)).toEqual([
      'packages/editor/packages/engine',
      'packages/editor',
      '',
    ]);
  });

  it('finds dirty nested repositories before a parent pin can be bumped', () => {
    const repos = [
      repo({ path: '', dirty: false }),
      repo({ path: 'packages/marketplace', parent: '', dirty: true }),
      repo({ path: 'packages/marketplace/extensions/node-editor', parent: 'packages/marketplace', dirty: true }),
      repo({ path: 'packages/chat', parent: '', dirty: true }),
    ];
    expect(dirtyReposUnder(repos, 'packages/marketplace').map((r) => r.path)).toEqual([
      'packages/marketplace',
      'packages/marketplace/extensions/node-editor',
    ]);
    expect(dirtyReposUnder(repos, 'packages/chat').map((r) => r.path)).toEqual(['packages/chat']);
  });

  it('picks only gates a repo defines, in run order', () => {
    expect(pickGates({ test: 'x', lint: 'y', irrelevant: 'z' }, GATE_ORDER)).toEqual(['lint', 'test']);
    expect(pickGates({
      'lint:layers': 'a',
      'lint:boundaries': 'b',
      'test:layers': 'c',
      'test:boundaries': 'd',
      'test:forgeax-build-game': 'e',
    }, ROOT_GATE_ORDER)).toEqual([
      'lint:layers',
      'lint:boundaries',
      'test:layers',
      'test:boundaries',
      'test:forgeax-build-game',
    ]);
    expect(pickGates(undefined, GATE_ORDER)).toEqual([]);
  });

  it('formats aligned tables', () => {
    const t = formatTable(['A', 'LONG'], [['xx', 'y']]);
    expect(t.split('\n')).toEqual(['A   LONG', '--  ----', 'xx  y']);
  });
});

describe('tag nudge (ADR 0022)', () => {
  it('computes tag distance from describe output', () => {
    expect(tagDistance('interface-v0.4.2')).toBe(0); // exactly on a tag
    expect(tagDistance('interface-v0.4.2-3-g1a2b3c4')).toBe(3);
    expect(tagDistance('ccfee0c')).toBe(Infinity); // bare sha — no tag reachable
    expect(tagDistance('883af099d54d2e900003068178fcfc6cddf8cda3')).toBe(Infinity);
  });

  it('stays quiet near a tag, nudges when far or untagged', () => {
    expect(tagNudge('packages/interface', 'interface-v0.4.2')).toBeNull();
    expect(tagNudge('packages/interface', `interface-v0.4.2-${TAG_NUDGE_DISTANCE - 1}-gabc1234`)).toBeNull();
    const far = tagNudge('packages/interface', `interface-v0.4.2-${TAG_NUDGE_DISTANCE}-gabc1234`);
    expect(far).toContain('commits past interface-v0.4.2');
    const untagged = tagNudge('packages/chat', 'ec5c285');
    expect(untagged).toContain('no tag reachable');
    expect(untagged).toContain('packages/chat/package.json');
  });
});

describe('planCommit', () => {
  it('commits dirty repos leaf-first and skips clean ones', () => {
    const repos = [
      repo({ path: '', dirty: true, branch: 'refactor/x' }),
      repo({ path: 'packages/chat', parent: '', dirty: true, branch: 'refactor/x', pin: 'b'.repeat(40) }),
      repo({ path: 'packages/server', parent: '', dirty: false }),
    ];
    const plan = planCommit(repos, { push: false });
    expect(plan.violations).toEqual([]);
    expect(plan.steps.map((s) => s.path)).toEqual(['packages/chat', '']);
  });

  it('hard-blocks dirty repos on detached HEAD', () => {
    const plan = planCommit([repo({ path: 'packages/chat', parent: '', dirty: true, branch: 'DETACHED' })], { push: false });
    expect(plan.violations).toHaveLength(1);
    expect(plan.violations[0]).toContain('detached HEAD');
    expect(plan.steps).toEqual([]);
  });

  it('refuses pushes to main (PR-only) while still committing', () => {
    const plan = planCommit([repo({ path: 'packages/server', parent: '', dirty: true, branch: 'main' })], { push: true });
    expect(plan.steps[0].push).toBe('refused-main');
  });

  it('records child pin checks on the parent step', () => {
    const childHead = 'c'.repeat(40);
    const repos = [
      repo({ path: '', dirty: true, branch: 'refactor/x' }),
      repo({ path: 'packages/chat', parent: '', dirty: false, branch: 'refactor/x', head: childHead, pin: 'd'.repeat(40) }),
    ];
    const plan = planCommit(repos, { push: false });
    const rootStep = plan.steps.find((s) => s.path === '')!;
    expect(rootStep.pinChecks).toEqual([{ child: 'packages/chat', sha: childHead }]);
  });

  it('flags a pin whose child commit can never be pushed (child on main, push refused)', () => {
    const childHead = 'c'.repeat(40);
    const repos = [
      repo({ path: '', dirty: true, branch: 'refactor/x' }),
      repo({ path: 'packages/server', parent: '', dirty: true, branch: 'main', head: childHead, pin: 'd'.repeat(40) }),
    ];
    const plan = planCommit(repos, { push: true });
    expect(plan.violations.some((v) => v.includes('cannot be pushed directly'))).toBe(true);
  });
});
