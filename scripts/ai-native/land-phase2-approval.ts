#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseBaselineApprovals } from './baseline-approval.ts';
import { loadCurrentBaselineState } from './baseline-state.ts';

export type ApprovalLandingStage = 'anchor' | 'runtime' | 'coverage' | 'documents' | 'check';

const ROOT = resolve(import.meta.dir, '../..');
const ANCHOR_EVIDENCE_PATH = 'docs/ai-native/evidence/m2-runtime-pin-product-combo.json';
const RUNTIME_PIN_PATH = 'docs/ai-native/pins/m2-2026-07-23.json';

function pinCommand(baseMain: string): string[] {
  return [
    'bun', 'scripts/ai-native/build-runtime-pin.ts',
    '--base-main', baseMain,
    '--write-evidence',
    '--reuse-scanned-product-combo',
  ];
}

export function approvalLandingCommands(
  stage: ApprovalLandingStage,
  baseMain?: string,
  isolatedTempDirectory = '{isolated-temp-dir}',
): string[][] {
  if ((stage === 'anchor' || stage === 'runtime') && !baseMain) {
    throw new Error(`--base-main is required for ${stage}`);
  }
  if (stage === 'anchor') return [pinCommand(baseMain!)];
  if (stage === 'runtime') return [
    [
      'bun', 'scripts/ai-native/runtime-snapshot-runner.ts',
      '--mode', 'development',
      '--profile', 'scripts/ai-native/profiles/main.json',
      '--snapshot', 'scripts/ai-native/runtime-snapshots/main.development.json',
      '--report', 'scripts/ai-native/runtime-snapshot-reports/main.development.json',
      '--no-git',
    ],
    [
      'bun', 'scripts/ai-native/runtime-snapshot-runner.ts',
      '--mode', 'formal',
      '--profile', 'scripts/ai-native/profiles/main.json',
      '--snapshot', 'scripts/ai-native/runtime-snapshots/main.formal.json',
      '--report', 'scripts/ai-native/runtime-snapshot-reports/main.formal.json',
      '--no-git',
    ],
    ['bun', 'scripts/ai-native/derive-positive-evidence-manifests.ts', '--write'],
    pinCommand(baseMain!),
  ];
  if (stage === 'coverage') return [
    [
      'bun', 'scripts/ai-native/calculate-r6-coverage.ts',
      '--json', 'scripts/ai-native/r6-coverage.json',
      '--markdown', 'docs/ai-native/r6-coverage.md',
    ],
    ['bun', 'scripts/ai-native/derive-capability-baseline.ts', '--write'],
  ];
  if (stage === 'documents') return [
    ['bun', 'scripts/ai-native/generate-phase2-approval-docs.ts', '--write'],
  ];
  return [
    ['bun', 'run', 'test:ai-native'],
    ['bun', 'run', 'test:boundaries'],
    ['bun', 'run', 'test:layers'],
    ['bun', 'run', 'test:runtime-snapshot'],
    ['bun', 'run', 'typecheck:ai-native'],
    ['bun', 'run', 'integrity-domain:check'],
    ['bun', 'run', 'runtime-pin:verify'],
    ['bun', 'run', 'baseline:diff:verify'],
    [
      'bun', 'run', 'r6:calculate', '--json', join(isolatedTempDirectory, 'r6-coverage.json'),
      '--markdown', join(isolatedTempDirectory, 'r6-coverage.md'),
    ],
    [
      'bun', 'run', 'r6:ci', '--actual', join(isolatedTempDirectory, 'r6-coverage.json'),
      '--expected', 'scripts/ai-native/r6-coverage.json',
    ],
    ['bun', 'run', '--cwd', 'scripts/ai-native', 'generated:check'],
    ['bun', 'run', '--cwd', 'scripts/ai-native', 'approval-manifest:verify'],
    ['bun', 'run', '--cwd', 'scripts/ai-native', 'test:approval-manifest'],
  ];
}

export function assertBaseMainMatchesAnchor(baseMain: string, anchorBaseMain: string): void {
  if (!/^[0-9a-f]{40}$/.test(baseMain)) {
    throw new Error(`--base-main must be a full lowercase commit SHA, got ${baseMain}`);
  }
  if (baseMain !== anchorBaseMain) {
    throw new Error(
      `--base-main does not match the recorded runtime anchor: expected=${anchorBaseMain} actual=${baseMain}`,
    );
  }
}

function recordedAnchorBaseMain(): string {
  const parse = (path: string): string => {
    const value = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as { base_main_sha?: unknown };
    if (typeof value.base_main_sha !== 'string' || !/^[0-9a-f]{40}$/.test(value.base_main_sha)) {
      throw new Error(`runtime anchor has an invalid base_main_sha: ${path}`);
    }
    return value.base_main_sha;
  };
  const evidenceBase = parse(ANCHOR_EVIDENCE_PATH);
  const pinBase = parse(RUNTIME_PIN_PATH);
  if (evidenceBase !== pinBase) {
    throw new Error(
      `runtime anchor base_main_sha disagreement: evidence=${evidenceBase} pin=${pinBase}`,
    );
  }
  return evidenceBase;
}

export interface ApprovalLandingExecution {
  approvalStatus(): string;
  assertClean(): void;
  run(command: string[]): number;
}

export function executeApprovalLandingStage(
  stage: ApprovalLandingStage,
  commands: string[][],
  execution: ApprovalLandingExecution,
): void {
  if (execution.approvalStatus() !== 'approved') {
    throw new Error('approval landing execution requires an already recorded approved receipt');
  }
  execution.assertClean();
  for (const command of commands) {
    if (execution.run(command) !== 0) {
      throw new Error(`stage ${stage} failed: ${command.join(' ')}`);
    }
  }
}

function currentApprovalStatus(): string {
  const state = loadCurrentBaselineState(ROOT);
  const approvals = parseBaselineApprovals(JSON.parse(
    readFileSync(resolve(ROOT, 'docs/ai-native/baseline/approvals.json'), 'utf8'),
  ) as unknown);
  const record = approvals.records.find((row) => row.baseline_id === state.currentBaselineId);
  if (!record) throw new Error(`approval record is missing: ${state.currentBaselineId}`);
  return record.status;
}

function assertCleanStart(): void {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  if (result.stdout.trim()) {
    throw new Error('approval landing stage requires a clean committed start; commit the previous stage first');
  }
}

function parseArgs(argv: string[]): { stage: ApprovalLandingStage; baseMain?: string; plan: boolean } {
  let stage: ApprovalLandingStage | undefined;
  let baseMain: string | undefined;
  let plan = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stage') {
      const value = argv[++index] as ApprovalLandingStage | undefined;
      if (!value || !['anchor', 'runtime', 'coverage', 'documents', 'check'].includes(value)) {
        throw new Error('--stage requires anchor|runtime|coverage|documents|check');
      }
      stage = value;
    } else if (arg === '--base-main') {
      baseMain = argv[++index];
      if (!baseMain) throw new Error('--base-main requires a commit');
    } else if (arg === '--plan') plan = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!stage) throw new Error('--stage is required');
  return { stage, ...(baseMain ? { baseMain } : {}), plan };
}

function main(argv: string[]): void {
  const options = parseArgs(argv);
  if (options.baseMain) {
    assertBaseMainMatchesAnchor(options.baseMain, recordedAnchorBaseMain());
  }
  const tempDirectory = options.stage === 'check' && !options.plan
    ? mkdtempSync(join(tmpdir(), 'forgeax-approval-landing-'))
    : '{isolated-temp-dir}';
  const commands = approvalLandingCommands(options.stage, options.baseMain, tempDirectory);
  if (options.plan) {
    for (const command of commands) process.stdout.write(`${command.join(' ')}\n`);
    return;
  }
  try {
    executeApprovalLandingStage(options.stage, commands, {
      approvalStatus: currentApprovalStatus,
      assertClean: assertCleanStart,
      run(command) {
        process.stdout.write(`[approval-landing] RUN ${command.join(' ')}\n`);
        const result = spawnSync(command[0]!, command.slice(1), { cwd: ROOT, stdio: 'inherit' });
        return result.status ?? 1;
      },
    });
  } finally {
    if (options.stage === 'check') rmSync(tempDirectory, { recursive: true, force: true });
  }
  process.stdout.write(
    `[approval-landing] ${options.stage.toUpperCase()} COMPLETE; `
    + `${options.stage === 'check' ? 'all gates are green' : 'review and commit this stage before continuing'}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[approval-landing] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
