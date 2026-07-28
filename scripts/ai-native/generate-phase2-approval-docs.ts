#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { baselineBytesSha256, parseBaselineApprovals } from './baseline-approval.ts';
import { loadCurrentBaselineState } from './baseline-state.ts';
import {
  APPROVAL_MANIFEST_PATH,
  APPROVAL_PACKAGE_PATH,
  FINAL_EXECUTION_REPORT_PATH,
  GATE_LOG_DIRECTORY,
  PHASE2_DELIVERY_SURFACE_PATHS,
  PHASE2_METRICS_PATH,
  approvedApprovalReceipt,
  buildApprovalManifestFromMetrics,
  isPullRequestWorkflowUnconditional,
  pendingApprovalReceipt,
  renderApprovalManifest,
  renderApprovalReceipt,
  type ApprovalSource,
  verifyApprovalManifest,
  worktreeSource,
} from './verify-approval-manifest.ts';

const ROOT = resolve(import.meta.dir, '../..');

function baselineVersion(baselineId: string): string {
  const match = /-(\d+\.\d+\.\d+)$/.exec(baselineId);
  if (!match) throw new Error(`baseline id has no semantic version: ${baselineId}`);
  return match[1]!;
}
export const GATE_FILES = [
  {
    name: 'test:ai-native',
    file: '01-test-ai-native.txt',
    exampleCommand: 'bun run test:ai-native',
    command: () => ['bun', 'run', 'test:ai-native'],
  },
  {
    name: 'test:boundaries',
    file: '02-test-boundaries.txt',
    exampleCommand: 'bun run test:boundaries',
    command: () => ['bun', 'run', 'test:boundaries'],
  },
  {
    name: 'test:layers',
    file: '03-test-layers.txt',
    exampleCommand: 'bun run test:layers',
    command: () => ['bun', 'run', 'test:layers'],
  },
  {
    name: 'test:runtime-snapshot',
    file: '04-test-runtime-snapshot.txt',
    exampleCommand: 'bun run test:runtime-snapshot',
    command: () => ['bun', 'run', 'test:runtime-snapshot'],
  },
  {
    name: 'typecheck:ai-native',
    file: '05-typecheck-ai-native.txt',
    exampleCommand: 'bun run typecheck:ai-native',
    command: () => ['bun', 'run', 'typecheck:ai-native'],
  },
  {
    name: 'integrity-domain:check',
    file: '06-integrity-domain-check.txt',
    exampleCommand: 'bun run integrity-domain:check',
    command: () => ['bun', 'run', 'integrity-domain:check'],
  },
  {
    name: 'runtime-pin:verify',
    file: '07-runtime-pin-verify.txt',
    exampleCommand: 'bun run runtime-pin:verify',
    command: () => ['bun', 'run', 'runtime-pin:verify'],
  },
  {
    name: 'baseline:diff:verify',
    file: '08-baseline-diff-verify.txt',
    exampleCommand: 'bun run baseline:diff:verify',
    command: () => ['bun', 'run', 'baseline:diff:verify'],
  },
  {
    name: 'r6:calculate',
    file: '09-r6-calculate.txt',
    exampleCommand: 'bun run r6:calculate --json /tmp/sl.json --markdown /tmp/sl.md',
    command: (scratch: string) => [
      'bun', 'run', 'r6:calculate', '--json', join(scratch, 'r6-coverage.json'),
      '--markdown', join(scratch, 'r6-coverage.md'),
    ],
  },
  {
    name: 'r6:ci',
    file: '10-r6-ci.txt',
    exampleCommand: 'bun run r6:ci --actual /tmp/sl.json --expected scripts/ai-native/r6-coverage.json',
    command: (scratch: string) => [
      'bun', 'run', 'r6:ci', '--actual', join(scratch, 'r6-coverage.json'),
      '--expected', 'scripts/ai-native/r6-coverage.json',
    ],
  },
] as const;

function text(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function json<T>(path: string): T {
  return JSON.parse(text(path)) as T;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function lineCount(path: string): number {
  const value = text(path).trim();
  return value ? value.split('\n').length : 0;
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitText(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function gitPaths(args: readonly string[]): string[] {
  return gitOutput(args).split('\n').filter(Boolean).sort();
}

function gateContentCommit(log: string): string {
  const match = /^# Gate run at content commit ([0-9a-f]{40})$/m.exec(log);
  if (!match) throw new Error('gate log is missing its machine-readable content commit');
  return match[1]!.trim();
}

function gateCommand(log: string): string {
  const match = /^\$ (.+)$/m.exec(log);
  if (!match) throw new Error('gate log is missing its machine-readable command');
  return match[1]!.trim();
}

function gateExitCode(log: string): number {
  const matches = [...log.matchAll(/^exit=(\d+)$/gm)];
  if (matches.length !== 1) {
    throw new Error(`gate log must contain exactly one machine-readable exit code, got ${matches.length}`);
  }
  const finalLine = log.trimEnd().split('\n').at(-1);
  if (finalLine !== matches[0]![0]) throw new Error('gate log exit code must be the final non-empty line');
  return Number(matches[0]![1]);
}

function gateCommandMatches(name: string, command: string): boolean {
  const definition = GATE_FILES.find((gate) => gate.name === name);
  if (!definition) return false;
  if (name === 'r6:calculate') {
    return /^bun run r6:calculate --json \/tmp\/\S+\.json --markdown \/tmp\/\S+\.md$/.test(command);
  }
  if (name === 'r6:ci') {
    return /^bun run r6:ci --actual \/tmp\/\S+\.json --expected scripts\/ai-native\/r6-coverage\.json$/.test(command);
  }
  return command === definition.exampleCommand;
}

export interface Phase2SealFacts {
  sealCommit: string;
  sealParent: string;
  changedPaths: readonly string[];
  logs: ReadonlyMap<string, string>;
}

export interface VerifiedPhase2Seal {
  sealCommit: string;
  contentCommit: string;
  gates: Array<{
    name: string;
    path: string;
    log: string;
    command: string;
    rc: number;
  }>;
}

export function verifyPhase2SealFacts(facts: Phase2SealFacts): VerifiedPhase2Seal {
  const expectedPaths = GATE_FILES.map((gate) => `${GATE_LOG_DIRECTORY}/${gate.file}`).sort();
  const changedPaths = [...facts.changedPaths].sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) {
    const expected = new Set(expectedPaths);
    const actual = new Set(changedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = changedPaths.filter((path) => !expected.has(path));
    throw new Error(
      `gate-log seal path mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`,
    );
  }
  const gates = GATE_FILES.map((definition) => {
    const path = `${GATE_LOG_DIRECTORY}/${definition.file}`;
    const log = facts.logs.get(path);
    if (log === undefined) throw new Error(`gate-log seal is missing committed bytes: ${path}`);
    const command = gateCommand(log);
    if (!gateCommandMatches(definition.name, command)) {
      throw new Error(`gate log command mismatch: gate=${definition.name} command=${command}`);
    }
    const rc = gateExitCode(log);
    if (rc !== 0) throw new Error(`gate is not green: ${definition.name} rc=${rc}`);
    return {
      name: definition.name,
      path,
      log,
      command,
      rc,
      contentCommit: gateContentCommit(log),
    };
  });
  const contentCommits = [...new Set(gates.map((gate) => gate.contentCommit))];
  if (contentCommits.length !== 1 || contentCommits[0] !== facts.sealParent) {
    throw new Error(
      `gate logs do not describe the seal parent content commit: `
      + `recorded=${contentCommits.join(',') || 'none'} parent=${facts.sealParent}`,
    );
  }
  const calculate = gates.find((gate) => gate.name === 'r6:calculate')!.command;
  const ci = gates.find((gate) => gate.name === 'r6:ci')!.command;
  const calculateActual = /--json (\/tmp\/\S+\.json) /.exec(calculate)?.[1];
  const ciActual = /--actual (\/tmp\/\S+\.json) /.exec(ci)?.[1];
  if (!calculateActual || calculateActual !== ciActual) {
    throw new Error(`r6 gate projection mismatch: calculate=${calculateActual} ci=${ciActual}`);
  }
  return {
    sealCommit: facts.sealCommit,
    contentCommit: facts.sealParent,
    gates: gates.map(({ contentCommit: _contentCommit, ...gate }) => gate),
  };
}

export function verifyPhase2SealFromRepository(): VerifiedPhase2Seal {
  const sealCommit = gitOutput(['log', '-1', '--format=%H', '--', GATE_LOG_DIRECTORY]);
  const parentLine = gitOutput(['rev-list', '--parents', '-n', '1', sealCommit]).split(/\s+/);
  if (parentLine.length !== 2) {
    throw new Error(`gate-log seal must have exactly one parent: seal=${sealCommit}`);
  }
  const sealParent = parentLine[1]!;
  const changedPaths = gitPaths(['diff-tree', '--no-commit-id', '--name-only', '-r', sealCommit]);
  const logs = new Map<string, string>();
  for (const gate of GATE_FILES) {
    const path = `${GATE_LOG_DIRECTORY}/${gate.file}`;
    const worktreeLog = text(path);
    const committedLog = gitText(['show', `${sealCommit}:${path}`]);
    if (worktreeLog !== committedLog) {
      throw new Error(`gate log bytes differ from the committed seal: ${path}`);
    }
    logs.set(path, worktreeLog);
  }
  return verifyPhase2SealFacts({ sealCommit, sealParent, changedPaths, logs });
}

function assertOnlyDeliverySurface(paths: readonly string[], label: string): void {
  const allowed = new Set<string>(PHASE2_DELIVERY_SURFACE_PATHS);
  const extra = [...new Set(paths)].filter((path) => !allowed.has(path)).sort();
  if (extra.length > 0) {
    throw new Error(`${label} contains non-delivery changes after gate capture: ${extra.join(',')}`);
  }
}

function assertDeliveryBoundary(seal: VerifiedPhase2Seal, approvalStatus: 'pending' | 'approved'): void {
  const workingPaths = [
    ...gitPaths(['diff', '--name-only']),
    ...gitPaths(['diff', '--cached', '--name-only']),
    ...gitPaths(['ls-files', '--others', '--exclude-standard']),
  ];
  assertOnlyDeliverySurface(workingPaths, 'approval worktree');
  if (approvalStatus === 'pending') {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', seal.sealCommit, 'HEAD'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    if (ancestry.status !== 0) throw new Error(`gate-log seal is not an ancestor of HEAD: ${seal.sealCommit}`);
    assertOnlyDeliverySurface(
      gitPaths(['diff', '--name-only', `${seal.sealCommit}..HEAD`]),
      'pending commits after gate-log seal',
    );
  }
}

function numericObservations(log: string): Record<string, number> {
  const result: Record<string, number> = {};
  const body = log.split('\n')
    .filter((line) => !/^(# Gate run at content commit |\$ |exit=)/.test(line))
    .join('\n');
  for (const match of body.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)=(\d+(?:\.\d+)?)\b/g)) {
    result[match[1]!] = Number(match[2]);
  }
  const coverage = /\bcoverage=(\d+)\/(\d+)\b/.exec(body);
  if (coverage) {
    result.coverage_numerator = Number(coverage[1]);
    result.coverage_denominator = Number(coverage[2]);
    delete result.coverage;
  }
  const tests = /\btests=(\d+)\/(\d+)\b/.exec(body);
  if (tests) {
    result.tests_pass = Number(tests[1]);
    result.tests_total = Number(tests[2]);
    delete result.tests;
  }
  const pass = [...body.matchAll(/\b(\d+) pass\b/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const fail = [...body.matchAll(/\b(\d+) fail\b/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (pass > 0) result.test_pass = pass;
  if (fail > 0) result.test_fail = fail;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function gateSummary(log: string): string {
  const meaningful = log.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(# Gate run at content commit |\$ |exit=)/.test(line));
  return meaningful.at(-1) ?? 'no command output';
}

interface SurfaceRow {
  repository: string;
  controls: number;
  files: number;
}

function surfaceRows(path: string): SurfaceRow[] {
  const rows: SurfaceRow[] = [];
  for (const line of text(path).split('\n')) {
    const match = /^\| ([a-z0-9-]+) \| [^|]+ \| (\d+) \| (\d+) \|$/.exec(line);
    if (match) rows.push({ repository: match[1]!, controls: Number(match[2]), files: Number(match[3]) });
  }
  if (rows.length === 0) throw new Error(`could not parse other-team surface table: ${path}`);
  return rows;
}

function gapRows(): Array<{ id: string; status: 'active' | 'closed'; title: string }> {
  const source = text('docs/ai-native/known-collector-gaps.md');
  const headings = [...source.matchAll(/^## (KG-(\d+)) — ([^\n]+)$/gm)];
  return headings.map((match, index) => {
    const body = source.slice(match.index! + match[0].length, headings[index + 1]?.index ?? source.length);
    const closed = /\*\*closed\b|\*\*closed\s+as\s+an\s+audit\s+mechanism\s+gap\*\*/i.test(body);
    return {
      id: match[1]!,
      status: closed ? 'closed' as const : 'active' as const,
      title: match[3]!.trim(),
    };
  }).sort((left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3)));
}

function renderObservations(values: Record<string, number>): string {
  const rows = Object.entries(values);
  return rows.length === 0 ? 'none' : rows.map(([key, value]) => `${key}=${value}`).join(', ');
}

export function collectPhase2Metrics() {
  const state = loadCurrentBaselineState(ROOT);
  const baselineRoot = `docs/ai-native/baseline/${state.currentBaselineId}`;
  const oldBaselineRoot = `docs/ai-native/baseline/${state.previousBaselineId}`;
  const previousVersion = baselineVersion(state.previousBaselineId);
  const approvals = parseBaselineApprovals(json('docs/ai-native/baseline/approvals.json'));
  const approval = approvals.records.find((record) => record.baseline_id === state.currentBaselineId);
  if (!approval || (approval.status !== 'pending' && approval.status !== 'approved')) {
    throw new Error('Phase 2 approval document generation requires pending or approved status');
  }
  const baselineBytes = baselineBytesSha256(ROOT, state.currentBaselineId);
  if (approval.baseline_bytes_sha256 !== baselineBytes) {
    throw new Error(
      `approval baseline bytes are stale: expected=${baselineBytes} actual=${approval.baseline_bytes_sha256}`,
    );
  }
  const r6 = json<{
    baseline_id: string;
    baseline_approval: string;
    numerator: number;
    denominator: number;
    coverage_percent: number;
    result_status: string;
    coverage_tier: string;
    test_runs: Array<{ ok: boolean }>;
    exclusion_disclosure: { excluded_effects_by_disposition: Record<string, number> };
    domains: Array<{ tool: number; read: number }>;
  }>('scripts/ai-native/r6-coverage.json');
  const capability = json<{ baseline_id: string; control_count: number; previous_sha256: string }>(
    'scripts/ai-native/capability-baseline.json',
  );
  const carry = json<{
    matched: unknown[];
    requires_incremental_adjudication: unknown[];
    unmatched_old: unknown[];
  }>('scripts/ai-native/manual-pool-carry-forward.json');
  const diffPath = `${baselineRoot}/diff-from-${previousVersion}.jsonl`;
  const diffMarkdown = text(`${baselineRoot}/diff-from-${previousVersion}.md`);
  const seal = verifyPhase2SealFromRepository();
  assertDeliveryBoundary(seal, approval.status);
  const gates = seal.gates.map((gate) => {
    return {
      name: gate.name,
      status: 'PASS' as const,
      path: gate.path,
      source_head: seal.contentCommit,
      command: gate.command,
      rc: gate.rc,
      raw_sha256: sha256(gate.log),
      observations: numericObservations(gate.log),
      summary: gateSummary(gate.log),
    };
  });
  const contentCommit = seal.contentCommit;
  const sealCommit = seal.sealCommit;
  const oldSurfaces = new Map(surfaceRows(`${oldBaselineRoot}/other-team-surface.md`).map((row) => [row.repository, row]));
  const newSurfaces = surfaceRows(`${baselineRoot}/other-team-surface.md`);
  const surfaces = newSurfaces.map((row) => {
    const old = oldSurfaces.get(row.repository);
    if (!old) throw new Error(`new other-team repository has no ${previousVersion} comparison row: ${row.repository}`);
    return {
      repository: row.repository,
      old_controls: old.controls,
      new_controls: row.controls,
      controls_delta: row.controls - old.controls,
      old_files: old.files,
      new_files: row.files,
      files_delta: row.files - old.files,
    };
  });
  const gaps = gapRows();
  if (!gaps.some((gap) => gap.id === 'KG-10' && gap.status === 'closed')) {
    throw new Error('KG-10 must remain machine-classified as closed');
  }
  const tool = r6.domains.reduce((sum, row) => sum + row.tool, 0);
  const read = r6.domains.reduce((sum, row) => sum + row.read, 0);
  if (tool + read !== r6.denominator) throw new Error('R6 domain tool/read sum disagrees with denominator');
  return {
    schema_version: 1,
    generated_from: {
      source_head_sha: contentCommit,
      source_head_binding: 'provenance-only-not-approval-binding',
      generated_at: gitOutput(['show', '-s', '--format=%cI', sealCommit]),
    },
    commit_protocol: {
      content_commit: contentCommit,
      seal_commit: sealCommit,
      content_commit_status: 'gates-recorded',
      seal_commit_status: 'main-thread-sealed',
    },
    baseline: {
      id: state.currentBaselineId,
      previous_id: state.previousBaselineId,
      previous_version: previousVersion,
      byte_sha256: baselineBytes,
      approval_status: approval.status,
      approval_receipt: {
        approved_content_commit: approval.approved_content_commit,
        approval_manifest_raw_sha256: approval.approval_manifest_raw_sha256,
        approval_scope_sha256: approval.approval_scope_sha256,
        approval_package_raw_sha256: approval.approval_package_raw_sha256,
      },
      inventory: {
        controls: lineCount(`${baselineRoot}/controls.jsonl`),
        effects: lineCount(`${baselineRoot}/effects.jsonl`),
        edges: lineCount(`${baselineRoot}/edges.jsonl`),
        manual_pool: lineCount(`${baselineRoot}/manual-classification-pool.jsonl`),
      },
    },
    diff: {
      rows: lineCount(diffPath),
      attribution_signal_cross_check: lineCount(diffPath) === 0
        ? 'not-applicable-empty-diff'
        : diffMarkdown.includes('cross-check: PERFORMED')
          ? 'performed'
          : 'not-performed',
    },
    manual_pool_transition: {
      carried: carry.matched.length,
      incremental: carry.requires_incremental_adjudication.length,
      unmatched_old: carry.unmatched_old.length,
    },
    coverage: {
      numerator: r6.numerator,
      denominator: r6.denominator,
      percent: r6.coverage_percent,
      tool,
      read,
      test_pass: r6.test_runs.filter((run) => run.ok).length,
      test_total: r6.test_runs.length,
      result_status: r6.result_status,
      tier: r6.coverage_tier,
      exclusions: r6.exclusion_disclosure.excluded_effects_by_disposition,
    },
    capability_ratchet: capability,
    other_team_surface: surfaces,
    gaps,
    workflow: {
      approval_manifest_pull_request_unconditional:
        existsSync(resolve(ROOT, '.github/workflows/approval-manifest.yml'))
        && isPullRequestWorkflowUnconditional(text('.github/workflows/approval-manifest.yml')),
    },
    errata: [
      'Earlier Phase 2 delivery documents interpreted a hand-edited gate-log format; this generator now parses the committed content-commit, command, exit code, and raw log hash directly.',
    ],
    stop_rule: {
      present: text('docs/ai-native/governance-known-limitations.md').includes(
        'Post-Phase-2-E main-tip stop rule',
      ),
    },
    gates,
  };
}

export type Phase2ApprovalMetrics = ReturnType<typeof collectPhase2Metrics>;
type Metrics = Phase2ApprovalMetrics;

function gateTable(metrics: Metrics): string {
  return metrics.gates.map((gate) => (
    `| \`${gate.name}\` | ${gate.status} | ${renderObservations(gate.observations)} | \`${gate.path}\` |`
  )).join('\n');
}

function surfaceTable(metrics: Metrics): string {
  return metrics.other_team_surface.map((row) => (
    `| ${row.repository} | ${row.old_controls} | ${row.new_controls} | ${row.controls_delta >= 0 ? '+' : ''}${row.controls_delta} | `
    + `${row.old_files} | ${row.new_files} | ${row.files_delta >= 0 ? '+' : ''}${row.files_delta} |`
  )).join('\n');
}

function gapTable(metrics: Metrics): string {
  return metrics.gaps.map((gap) => `| ${gap.id} | ${gap.status} | ${gap.title.replaceAll('|', '&#124;')} |`).join('\n');
}

function renderReport(metrics: Metrics): string {
  const inventory = metrics.baseline.inventory;
  const coverage = metrics.coverage;
  const runtimePin = metrics.gates.find((gate) => gate.name === 'runtime-pin:verify');
  if (!runtimePin) throw new Error('runtime-pin:verify gate is missing');
  const diffStatement = metrics.diff.rows === 0
    ? 'The incremental diff is empty, so there are no row labels to cross-check; no per-row cross-check claim is made.'
    : 'The cross-check proves only that the root-cause signal named by each diff row actually changed. It does **not** independently decide, row by row, whether product bytes or scanner configuration caused that row; row attribution still comes from the checked classifier/adjudication path.';
  return `# M2 Phase 2 machine-generated final execution report

> [!IMPORTANT]
> Gate evidence was run at content commit
> \`${metrics.commit_protocol.content_commit}\`; its gate-log seal commit is
> \`${metrics.commit_protocol.seal_commit}\`. Baseline approval remains
> \`${metrics.baseline.approval_status}\`; this report records no user decision.

## Outcome

| Item | Machine-derived result |
|:--|:--|
| Baseline | \`${metrics.baseline.id}\` from \`${metrics.baseline.previous_id}\` |
| Baseline bytes | \`${metrics.baseline.byte_sha256}\` |
| Approval | \`${metrics.baseline.approval_status}\` |
| Inventory | ${inventory.controls} controls / ${inventory.effects} effects / ${inventory.edges} edges / ${inventory.manual_pool} manual rows |
| Incremental diff | ${metrics.diff.rows} full-payload rows; attribution cross-check \`${metrics.diff.attribution_signal_cross_check}\` |
| Manual-pool transition | ${metrics.manual_pool_transition.carried} carried / ${metrics.manual_pool_transition.incremental} incremental / ${metrics.manual_pool_transition.unmatched_old} unmatched-old |
| Coverage | ${coverage.numerator}/${coverage.denominator} = ${coverage.percent.toFixed(2)}%; tool=${coverage.tool}, read=${coverage.read}; \`${coverage.result_status}\` / \`${coverage.tier}\` |
| Capability ratchet | ${metrics.capability_ratchet.control_count} unmigrated controls; previous SHA \`${metrics.capability_ratchet.previous_sha256}\` |

## Machine-derived delivery commit points

| Stage | Machine-derived value | Derivation |
|:--|:--|:--|
| Content commit | \`${metrics.commit_protocol.content_commit}\` | Unanimous content-commit header parsed from every gate log; source_head_binding is \`${metrics.generated_from.source_head_binding}\` |
| Seal commit | \`${metrics.commit_protocol.seal_commit}\` | Latest commit from \`git log -- ${GATE_LOG_DIRECTORY}\`; its direct parent is verified as the content commit |

These two commits describe gate production and sealing. They are not the
\`approved_content_commit\`: that receipt field identifies the later pending
approval-object commit containing the exact manifest and package the human saw.

## Attribution cross-check: exact meaning

${diffStatement}

## Other-team scale disclosure

| Repository | ${metrics.baseline.previous_version} controls | Current controls | Delta | ${metrics.baseline.previous_version} files | Current files | Delta |
|:--|--:|--:|--:|--:|--:|--:|
${surfaceTable(metrics)}

These scale-only rows remain outside the migration denominator. The table
reports every repository row, including unchanged rows, so the editor-pin
effect is visible without selectively omitting zero deltas.

## Collector-gap status cross-check

| Gap | Status | Registry heading |
|:--|:--|:--|
${gapTable(metrics)}

KG-10 is closed; neither this report nor the approval package describes its
supplemental audit bytes as still unbound.

## Final gate logs

All logs name the same content commit and contain machine-readable command and
exit-code fields. Each result below is derived from that exit code.

| Gate | Result | Numeric observations | Log |
|:--|:--|:--|:--|
${gateTable(metrics)}

## Workflow and stop rule

The approval-manifest pull-request workflow is unconditional:
\`${metrics.workflow.approval_manifest_pull_request_unconditional}\`. The
post-Phase-2-E main-tip stop rule is present:
\`${metrics.stop_rule.present}\`. Later main movement is handled by the final
pre-PR drift gate instead of another automatic full recomputation.

> [!NOTE]
> \`runtime-pin:verify\` is \`${runtimePin.status}\`, derived from
> \`exit=${runtimePin.rc}\` in \`${runtimePin.path}\`; no document-local status
> override is used.

> [!NOTE]
> Erratum: ${metrics.errata[0]}
`;
}

export function renderPhase2ApprovalPackage(metrics: Metrics, scopeSha: string): string {
  const inventory = metrics.baseline.inventory;
  const coverage = metrics.coverage;
  const runtimePin = metrics.gates.find((gate) => gate.name === 'runtime-pin:verify');
  if (!runtimePin) throw new Error('runtime-pin:verify gate is missing');
  const receipt = metrics.baseline.approval_receipt;
  const approved = metrics.baseline.approval_status === 'approved';
  const receiptSection = approved
    ? renderApprovalReceipt(approvedApprovalReceipt({
        approved_content_commit: receipt.approved_content_commit!,
        approval_manifest_raw_sha256: receipt.approval_manifest_raw_sha256!,
        approval_scope_sha256: receipt.approval_scope_sha256!,
        approval_package_raw_sha256: receipt.approval_package_raw_sha256!,
      }))
    : renderApprovalReceipt(pendingApprovalReceipt(scopeSha));
  return `# M2 Phase 2 ${approved ? 'approved receipt' : 'pending approval'} package

> [!CAUTION]
> Baseline \`${metrics.baseline.id}\` is \`${metrics.baseline.approval_status}\`.
> ${approved ? 'This document reproduces the recorded receipt and does not create or alter the approval fact.' : 'This package asks for a human decision and records none; decision evidence and receipt fields remain empty.'}

## Approval object

**The following generated JSON block is the sole authoritative receipt
representation. Human signs its compound approval identifier, not either
component alone.**

${receiptSection}

For a pending package, the validator computes the package-byte component from
this file's raw bytes and prints the compound identifier externally; the file
cannot contain its own hash. In approved state, the receipt reproduces the raw
hash of the replayed pending package.

## Machine-derived delivery commit points

| Stage | Machine-derived value | Derivation |
|:--|:--|:--|
| Content commit | \`${metrics.commit_protocol.content_commit}\` | Unanimous content-commit header parsed from every gate log; source_head_binding: \`${metrics.generated_from.source_head_binding}\` |
| Seal commit | \`${metrics.commit_protocol.seal_commit}\` | Latest commit from \`git log -- ${GATE_LOG_DIRECTORY}\`; its direct parent is verified as the content commit |

The table is gate provenance. \`approved_content_commit\` instead means the
pending approval-object commit containing the exact manifest and package shown
for the decision; filling it with either table row is invalid unless that
commit actually contains those bytes.

## Machine-derived decision inputs

| Input | Value | Source |
|:--|:--|:--|
| Baseline bytes | \`${metrics.baseline.byte_sha256}\` | approval record plus frozen byte manifest |
| Inventory | ${inventory.controls} controls / ${inventory.effects} effects / ${inventory.edges} edges / ${inventory.manual_pool} manual rows | current frozen JSONL |
| Incremental diff | ${metrics.diff.rows} rows | current frozen diff |
| Manual-pool transition | ${metrics.manual_pool_transition.carried} carried / ${metrics.manual_pool_transition.incremental} incremental / ${metrics.manual_pool_transition.unmatched_old} unmatched-old | carry-forward artifact |
| Denominator | ${coverage.denominator} effects: tool=${coverage.tool}, read=${coverage.read} | checked R6 artifact |
| Coverage | ${coverage.numerator}/${coverage.denominator} = ${coverage.percent.toFixed(2)}% | checked R6 artifact |
| Evidence tests | ${coverage.test_pass}/${coverage.test_total} | checked R6 artifact |
| Capability inventory | ${metrics.capability_ratchet.control_count} unmigrated controls | active ratchet artifact |

## Other-team scale disclosure

| Repository | ${metrics.baseline.previous_version} controls | Current controls | Delta | ${metrics.baseline.previous_version} files | Current files | Delta |
|:--|--:|--:|--:|--:|--:|--:|
${surfaceTable(metrics)}

These scale-only rows are excluded from the migration denominator.

## Attribution cross-check: exact meaning

${metrics.diff.rows === 0
    ? 'The incremental diff is empty, so there are no row labels to cross-check.'
    : 'The cross-check proves only that the named root-cause signal changed; it does not independently decide row attribution.'}

## Collector-gap status

| Gap | Status | Registry heading |
|:--|:--|:--|
${gapTable(metrics)}

KG-10 is closed and its bytes are bound by this manifest scope.

## Current scope versus approved scope

After approval takes effect, the current scope and the approved scope are two
deliberately separate projections. The current manifest validates bytes at the
current revision; the approved manifest is replayed from
\`approved_content_commit\`. Landing regenerates runtime and report bytes, so
their hashes necessarily diverge. The signed inventory and coverage numbers
bind only the approved commit replay, never an arbitrary later commit. The path
set remains stable unless an executable scope edit carries an explicit
added/removed declaration and reason.

## Known landing limitations

The landing script cannot create approval facts or commits. Every generating
stage must start from reviewed committed bytes in the real workflow, and the
main thread must commit each stage before the next. Git-free runs are
diagnostic-only, branch protection remains an external trust boundary, and the
final gate-log seal must be produced after the last implementation commit.

## Gate evidence

| Gate | Result | Numeric observations | Log |
|:--|:--|:--|:--|
${gateTable(metrics)}

## Decision requested

> [!NOTE]
> \`runtime-pin:verify\` is \`${runtimePin.status}\`, derived from
> \`exit=${runtimePin.rc}\` in \`${runtimePin.path}\`; no document-local status
> override is used.

${approved
    ? 'The approval fact is already recorded; this generated surface only reports and verifies it.'
    : 'Approve or reject the compound approval identifier printed by the validator. Until a later receipt records all fields and decision evidence, the baseline remains pending and coverage remains draft/provisional.'}
`;
}

function overlaySource(base: ApprovalSource, overlays: Map<string, Uint8Array>): ApprovalSource {
  return {
    read(path) {
      return overlays.get(path) ?? base.read(path);
    },
    list(directory) {
      return base.list(directory);
    },
    ...(base.atRevision ? { atRevision: (revision: string) => base.atRevision!(revision) } : {}),
    ...(base.revisionExists ? { revisionExists: (revision: string) => base.revisionExists!(revision) } : {}),
    ...(base.isAncestor ? { isAncestor: (revision: string) => base.isAncestor!(revision) } : {}),
  };
}

export function generatedPhase2ApprovalOutputs(): { metrics: Metrics; manifest: ReturnType<typeof buildApprovalManifestFromMetrics>; outputs: Map<string, string> } {
  const metrics = collectPhase2Metrics();
  const outputs = new Map<string, string>([
    [PHASE2_METRICS_PATH, `${JSON.stringify(metrics, null, 2)}\n`],
    [FINAL_EXECUTION_REPORT_PATH, renderReport(metrics)],
  ]);
  const overlays = new Map<string, Uint8Array>(
    [...outputs].map(([path, value]) => [path, new TextEncoder().encode(value)]),
  );
  const source = overlaySource(worktreeSource(ROOT), overlays);
  const first = buildApprovalManifestFromMetrics(source);
  const packageText = renderPhase2ApprovalPackage(metrics, first.approval_scope_sha256);
  outputs.set(APPROVAL_PACKAGE_PATH, packageText);
  overlays.set(APPROVAL_PACKAGE_PATH, new TextEncoder().encode(packageText));
  const final = buildApprovalManifestFromMetrics(source);
  const manifestText = renderApprovalManifest(final);
  outputs.set(APPROVAL_MANIFEST_PATH, manifestText);
  overlays.set(APPROVAL_MANIFEST_PATH, new TextEncoder().encode(manifestText));
  verifyApprovalManifest(final, source);
  return { metrics, manifest: final, outputs };
}

function assertCleanContentHead(expectedHead?: string): string {
  const head = gitOutput(['rev-parse', 'HEAD']);
  if (expectedHead && head !== expectedHead) {
    throw new Error(`content HEAD moved during gate capture: expected=${expectedHead} actual=${head}`);
  }
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error(`gate capture requires a clean worktree:\n${status}`);
  return head;
}

function externalOutputDirectory(path: string): string {
  const output = resolve(path);
  const rel = relative(ROOT, output);
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) {
    throw new Error('gate capture output must be outside the repository so the worktree stays clean');
  }
  mkdirSync(output, { recursive: true });
  const existing = readdirSync(output);
  if (existing.length > 0) {
    throw new Error(`gate capture output directory must be empty: ${output}`);
  }
  return output;
}

export function capturePhase2GateLogs(outputPath: string): void {
  const output = externalOutputDirectory(outputPath);
  const contentCommit = assertCleanContentHead();
  const scratch = mkdtempSync(join(tmpdir(), 'forgeax-phase2-gates-'));
  const logs = new Map<string, string>();
  try {
    for (const gate of GATE_FILES) {
      assertCleanContentHead(contentCommit);
      const command = (gate.command as (directory: string) => readonly string[])(scratch);
      process.stdout.write(`[phase2-gate-capture] RUN ${command.join(' ')}\n`);
      const result = spawnSync(command[0]!, command.slice(1), {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const rc = result.status ?? 1;
      assertCleanContentHead(contentCommit);
      const captured = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const body = captured && !captured.endsWith('\n') ? `${captured}\n` : captured;
      const log = `# Gate run at content commit ${contentCommit}\n`
        + `$ ${command.join(' ')}\n${body}exit=${rc}\n`;
      const path = `${GATE_LOG_DIRECTORY}/${gate.file}`;
      writeFileSync(resolve(output, gate.file), log);
      logs.set(path, log);
      if (result.error) throw result.error;
      if (rc !== 0) throw new Error(`gate capture failed: gate=${gate.name} rc=${rc}`);
    }
    verifyPhase2SealFacts({
      sealCommit: '0'.repeat(40),
      sealParent: contentCommit,
      changedPaths: [...logs.keys()],
      logs,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(
    `[phase2-gate-capture] PASS content=${contentCommit} logs=${logs.size} output=${output}\n`,
  );
}

function main(argv: string[]): void {
  if (argv[0] === '--capture-gates') {
    if (argv.length !== 2) {
      throw new Error('usage: generate-phase2-approval-docs.ts --capture-gates <external-empty-directory>');
    }
    capturePhase2GateLogs(argv[1]!);
    return;
  }
  if (argv[0] === '--verify-seal') {
    if (argv.length !== 1) throw new Error('usage: generate-phase2-approval-docs.ts --verify-seal');
    const seal = verifyPhase2SealFromRepository();
    process.stdout.write(
      `[phase2-seal] PASS content=${seal.contentCommit} seal=${seal.sealCommit} logs=${seal.gates.length}\n`,
    );
    return;
  }
  const mode = argv[0] ?? '--write';
  if (argv.length > 1 || !['--write', '--check'].includes(mode)) {
    throw new Error(
      'usage: generate-phase2-approval-docs.ts [--write|--check|--verify-seal|--capture-gates <external-empty-directory>]',
    );
  }
  const generated = generatedPhase2ApprovalOutputs();
  for (const [path, expected] of generated.outputs) {
    if (mode === '--write') writeFileSync(resolve(ROOT, path), expected);
    else if (text(path) !== expected) throw new Error(`generated approval surface is stale: ${path}`);
  }
  process.stdout.write(
    `[phase2-approval-docs] ${mode === '--write' ? 'WROTE' : 'PASS'} baseline=${generated.metrics.baseline.id} `
    + `files=${generated.manifest.files.length} scope=${generated.manifest.approval_scope_sha256}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[phase2-approval-docs] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
