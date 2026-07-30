import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveGateBase,
  resolveMigrationRefs,
  UnevaluableError,
  droppedAdjudications,
  migratedEffectIds,
  migratedRegressions,
  parseInvocation,
  unadjudicatedEffects,
  unadjudicatedManualEntries,
} from './pr-gates.ts';
import { collectRegisteredOtherTeamRoutes } from './scanner.ts';

function manifestRoot(names: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-'));
  mkdirSync(join(root, 'scripts/ai-native/evidence-manifests-v1'), { recursive: true });
  for (const name of names) {
    writeFileSync(join(root, 'scripts/ai-native/evidence-manifests-v1', `${name}.json`), '{}\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@forgeax.dev'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'ForgeaX Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
  return root;
}

const WITH_TOOL = { effect_id: 'role.create', agent_equiv: { tool: { name: 'role_create' } } };
const WITH_ACTION = { effect_id: 'role.list', agent_equiv: { action: { id: 'role.list' } } };

describe('migrated capability regression gate', () => {
  it('reads the migrated set from the evidence manifest directory', () => {
    expect(migratedEffectIds(manifestRoot(['role.list', 'role.create']), 'HEAD')).toEqual(['role.create', 'role.list']);
  });

  it('keeps a base manifest in the migrated set after the working tree deletes it', () => {
    const root = manifestRoot(['role.list']);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    rmSync(join(root, 'scripts/ai-native/evidence-manifests-v1/role.list.json'));
    expect(migratedEffectIds(root, base)).toEqual(['role.list']);
  });

  it('passes while every migrated capability keeps an agent equivalent', () => {
    expect(migratedRegressions(['role.create', 'role.list'], [WITH_TOOL, WITH_ACTION])).toEqual([]);
  });

  it('is red when a migrated capability vanishes from the live scan', () => {
    expect(migratedRegressions(['role.create', 'role.list'], [WITH_TOOL])).toEqual([
      { effect_id: 'role.list', reason: 'absent from the live scan' },
    ]);
  });

  it('is red when a migrated capability survives but loses its agent equivalent', () => {
    const stripped = { effect_id: 'role.list', agent_equiv: { headless: 'n-a' } };
    expect(migratedRegressions(['role.create', 'role.list'], [WITH_TOOL, stripped])).toEqual([
      { effect_id: 'role.list', reason: 'lost its agent equivalent' },
    ]);
  });
});

describe('other-team route registry drift', () => {
  it('records every newly observed route with its repo, factory, method and path', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-routes-'));
    mkdirSync(join(root, 'packages/example/src'), { recursive: true });
    mkdirSync(join(root, 'scripts/ai-native'), { recursive: true });
    writeFileSync(join(root, 'packages/example/src/mount.ts'), "app.route('/api', createExampleRoutes())\n");
    writeFileSync(
      join(root, 'packages/example/src/routes.ts'),
      "const r = new Hono()\nr.get('/known', handler)\nr.post('/new', handler)\n",
    );
    writeFileSync(join(root, 'scripts/ai-native/other-team-route-registry.json'), `${JSON.stringify({
      schema_version: 1,
      registrations: [{
        repo: 'example',
        owner: 'ForgeaX-Games/example',
        verified_pin: 'a'.repeat(40),
        mount_file: 'packages/example/src/mount.ts',
        mounts: [{
          prefix: '/api',
          factory: 'createExampleRoutes',
          source: 'packages/example/src/routes.ts',
          routes: [{ method: 'GET', path: '/known', introduced_in_anchor: false }],
        }],
      }],
    })}\n`);
    const result = collectRegisteredOtherTeamRoutes(root, { example: 'a'.repeat(40) }, 'record');
    expect(result.drift).toContain(
      'unregistered other-team route observed for example: factory=createExampleRoutes method=POST path=/new',
    );
  });
});

describe('non-blocking gate diagnostics', () => {
  it('carries sorted human-review notices in the queue payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-notices-'));
    const script = join(import.meta.dir, 'pr-gates.ts');
    const scanner = join(import.meta.dir, 'scanner.ts');
    const result = Bun.spawnSync([
      'bun',
      '-e',
      `import { mock } from 'bun:test';
       mock.module(${JSON.stringify(scanner)}, () => ({
         buildInventory: async () => ({
           pendingHumanReview: ['notice z', 'notice a'], manualPool: [], edges: [],
         }),
         loadScannerLifecycleConfig: () => ({ currentBaselineDate: '2026-01-01' }),
       }));
       const { runQueueReport } = await import(${JSON.stringify(`${script}?queue-notices`)});
       await runQueueReport(process.argv[0])`,
      root,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const payload = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      dropped_adjudications: string[];
      pending_human_review: string[];
    };
    expect(result.exitCode).toBe(0);
    expect(payload.dropped_adjudications).toEqual([]);
    expect(payload.pending_human_review).toEqual(['notice a', 'notice z']);
  });

  it('emits one parseable queue report with errors and exits zero when inputs are unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-report-'));
    const script = join(import.meta.dir, 'pr-gates.ts');
    const result = Bun.spawnSync([
      'bun',
      '-e',
      `import { runQueueReport } from ${JSON.stringify(script)}; await runQueueReport(process.argv[1])`,
      root,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const lines = new TextDecoder().decode(result.stdout).trim().split(/\r?\n/);
    expect(result.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pending_human_review: [], dropped_adjudications: [] });
    expect(JSON.parse(lines[0]).errors.length).toBeGreaterThan(0);
  });

  it('fails closed when the migrated-regression gate cannot evaluate', () => {
    const root = manifestRoot(['role.list']);
    const script = join(import.meta.dir, 'pr-gates.ts');
    const result = Bun.spawnSync([
      'bun',
      '-e',
      `import { runMigratedRegression, UnevaluableError } from ${JSON.stringify(script)};
       try {
         await runMigratedRegression(process.argv[1]);
         process.exit(3);
       } catch (error) {
         process.exit(error instanceof UnevaluableError ? 0 : 4);
       }`,
      root,
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
  });

  it('rejects a declared gate base that does not resolve', () => {
    expect(() => resolveGateBase('.', { FORGEAX_GATE_BASE: 'deadbeef'.repeat(5) }))
      .toThrow(/does not resolve/);
  });

  it('rejects a declared gate base that belongs to another history', () => {
    // Resolvable but not an ancestor: it describes a history this branch is not
    // on, so the set it would name is not this branch's protected floor.
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-foreign-'));
    for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'one']]) {
      Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
    }
    const foreign = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-other-'));
    for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'other']]) {
      Bun.spawnSync(['git', ...args], { cwd: foreign, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
    }
    const head = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: foreign, stdout: 'pipe' }).stdout)
      .trim();
    Bun.spawnSync(['git', 'fetch', '-q', foreign, head], { cwd: root });
    expect(() => resolveGateBase(root, { FORGEAX_GATE_BASE: head }))
      .toThrow(/not an ancestor|does not resolve/);
  });

  it('will not evaluate without a trunk ref to floor the protected set', () => {
    // A shallow checkout without origin/main used to fall back to the caller's
    // base, which let an old base shrink the set. That is now unevaluable.
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pr-gates-notrunk-'));
    for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'one']]) {
      Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
    }
    expect(() => resolveMigrationRefs(root, {})).toThrow(UnevaluableError);
  });
});

describe('dropped adjudication report logic', () => {
  it('is red when an adjudication present at the base is gone at head', () => {
    expect(droppedAdjudications(['a.one', 'a.two'], ['a.one'])).toEqual(['a.two']);
  });

  it('reports every deletion, with no opt-out list to hide one behind', () => {
    expect(droppedAdjudications(['a.one', 'a.two', 'a.three'], ['a.one'])).toEqual(['a.three', 'a.two']);
  });

  it('never objects to adjudications being added', () => {
    expect(droppedAdjudications(['a.one'], ['a.one', 'a.two', 'a.three'])).toEqual([]);
  });
});

describe('a product pin advance alone', () => {
  // The whole point of the redesign: another team shipping into a submodule
  // shows up as extra live controls, edges and manual-pool entries that nobody
  // has adjudicated yet. That must feed the queue, never redden a gate.
  const driftedEdges = [
    { control_id: 'ctl_existing', effect_id: 'role.create' },
    { control_id: 'ctl_arrived_a', effect_id: 'newly.arrived_effect' },
    { control_id: 'ctl_arrived_b', effect_id: 'another.arrived_effect' },
  ];
  const driftedManual = [{ manual_id: 'manual_arrived_one' }, { manual_id: 'manual_arrived_two' }];

  it('leaves the migrated regression gate green', () => {
    expect(migratedRegressions(['role.create'], [WITH_TOOL, { effect_id: 'newly.arrived_effect' }])).toEqual([]);
  });

  it('does not report a dropped adjudication when no record was removed', () => {
    expect(droppedAdjudications(['role.create'], ['role.create'])).toEqual([]);
  });

  it('routes the arrivals into the queue report instead', () => {
    expect(unadjudicatedEffects(driftedEdges, [{ effect_id: 'role.create', disposition: 'tool' }])).toEqual([
      'another.arrived_effect',
      'newly.arrived_effect',
    ]);
    expect(unadjudicatedManualEntries(driftedManual, [])).toEqual([
      'manual_arrived_one',
      'manual_arrived_two',
    ]);
  });
});

describe('invocation parsing', () => {
  it('accepts the gate and the queue report', () => {
    expect(parseInvocation(['--gate', 'migrated-regression'])).toEqual({ kind: 'gate', gate: 'migrated-regression' });
    expect(parseInvocation(['--report', 'queue'])).toEqual({ kind: 'report' });
  });

  it('rejects the retired gates rather than silently passing them', () => {
    expect(() => parseInvocation(['--gate', 'adjudication-tampering'])).toThrow(/usage/);
    expect(() => parseInvocation(['--gate', 'manual-pool'])).toThrow(/usage/);
    expect(() => parseInvocation(['--gate', 'non-benign-edge'])).toThrow(/usage/);
  });
});
