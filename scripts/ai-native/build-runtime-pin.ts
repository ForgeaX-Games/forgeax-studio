#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadCurrentBaselineState } from './baseline-state.ts';
import {
  deriveOrchestratorAncestryProof,
  deriveRuntimePinV3Bindings,
  RUNTIME_PIN_PATH,
} from './runtime-artifact-integrity.ts';
import { parseRuntimeSnapshotProfile } from './runtime-snapshot-core.ts';

const ROOT = resolve(import.meta.dir, '../..');
export const RUNTIME_PIN_PRODUCT_COMBO_EVIDENCE_PATH =
  'docs/ai-native/evidence/m2-runtime-pin-product-combo.json';

function git(args: string[], cwd: string = ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function productCombo(): Record<string, string> {
  const combo: Record<string, string> = { studio: git(['rev-parse', 'HEAD']) };
  for (const line of git(['submodule', 'status', '--recursive']).split('\n')) {
    const match = /^[ +\-U]?([0-9a-f]{40})\s+([^\s]+)/.exec(line);
    if (!match) continue;
    const path = match[2]!;
    const key = path.startsWith('packages/')
      ? path.slice('packages/'.length).replaceAll('/', ':')
      : path.replaceAll('/', ':');
    combo[key] = match[1]!;
  }
  return Object.fromEntries(Object.entries(combo).sort(([left], [right]) => left.localeCompare(right)));
}

function allowedTaskWrite(path: string): boolean {
  return path === 'package.json'
    || path.startsWith('scripts/')
    || path.startsWith('docs/ai-native/')
    || path.startsWith('.github/workflows/');
}

export function writeRuntimePinArtifacts(
  pinPath: string,
  pinText: string,
  evidence?: { path: string; text: string },
): void {
  const writes = [
    ...(evidence ? [evidence] : []),
    { path: pinPath, text: pinText },
  ];
  const staged: Array<{ path: string; temporary: string }> = [];
  try {
    for (const [index, write] of writes.entries()) {
      mkdirSync(dirname(write.path), { recursive: true });
      const temporary = `${write.path}.p2c-${process.pid}-${index}.tmp`;
      writeFileSync(temporary, write.text, { flag: 'wx' });
      staged.push({ path: write.path, temporary });
    }
    // Evidence lands first; the governance anchor is the final atomic rename.
    for (const write of staged) renameSync(write.temporary, write.path);
  } catch (error) {
    for (const write of staged) rmSync(write.temporary, { force: true });
    throw error;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf('--base-main');
  const baseInput = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
  const writeEvidence = argv.includes('--write-evidence');
  const reuseScannedCombo = argv.includes('--reuse-scanned-product-combo');
  const expectedLength = 2 + Number(writeEvidence) + Number(reuseScannedCombo);
  if (!baseInput || argv.length !== expectedLength) {
    throw new Error(
      'usage: build-runtime-pin.ts --base-main COMMIT '
      + '[--write-evidence] [--reuse-scanned-product-combo]',
    );
  }
  const state = loadCurrentBaselineState(ROOT);
  const existingPin = JSON.parse(
    readFileSync(resolve(ROOT, RUNTIME_PIN_PATH), 'utf8'),
  ) as { scanned_product_combo?: Record<string, string>; dirty_proof?: { captured_before_task_writes?: boolean } };
  const combo = reuseScannedCombo
    ? existingPin.scanned_product_combo
    : productCombo();
  if (!combo || Object.keys(combo).length === 0) {
    throw new Error('existing runtime pin has no scanned product combo to preserve');
  }
  if (reuseScannedCombo) {
    const frozenMeta = JSON.parse(readFileSync(
      resolve(ROOT, 'docs/ai-native/baseline', state.currentBaselineId, 'meta.json'),
      'utf8',
    )) as { scanned_product_combo?: Record<string, string> };
    if (JSON.stringify(combo) !== JSON.stringify(frozenMeta.scanned_product_combo)) {
      throw new Error('preserved scanned product combo disagrees with the immutable current baseline');
    }
  }
  const rootDirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => !allowedTaskWrite(path));
  if (rootDirty.length > 0) throw new Error(`product paths are dirty: ${rootDirty.join(', ')}`);
  const baseMainSha = git(['rev-parse', `${baseInput}^{commit}`]);
  const headSha = git(['rev-parse', 'HEAD']);
  const profile = parseRuntimeSnapshotProfile(JSON.parse(readFileSync(
    resolve(ROOT, 'scripts/ai-native/profiles/main.json'),
    'utf8',
  )) as unknown);
  const ancestryProof = deriveOrchestratorAncestryProof(
    ROOT,
    profile.formal_gate.required_orchestrator_ancestor,
    combo,
  );
  const bindings = deriveRuntimePinV3Bindings(ROOT, combo);
  const pin = {
    schema_version: 3,
    pin_id: `m2-${state.baselineDate}-r-final-a`,
    base_main_sha: baseMainSha,
    base_main_sha_abbrev: baseMainSha.slice(0, 7),
    baseline_id: state.currentBaselineId,
    dirty: false,
    dirty_proof: {
      captured_before_task_writes: existingPin.dirty_proof?.captured_before_task_writes === true,
      combo_entry_count: Object.keys(combo).length,
      computed_tracked_or_gitlink_failures: 0,
      evidence_handoff: RUNTIME_PIN_PRODUCT_COMBO_EVIDENCE_PATH,
      method: reuseScannedCombo
        ? 'preserved the verified frozen product combo while regenerating governance and delivery bytes without rescanning product code'
        : 'pre-task clean assertion plus current product-path and recursive gitlink verification; task writes restricted to scripts/docs/ai-native/.github',
      repository_count: Object.keys(combo).length,
    },
    erratum: 'Pre-content-commit provenance anchor. head_sha identifies the source HEAD used by the uncommitted gate run and is not an approval binding; an approved_content_commit receipt, when present, is the sole content-commit binding.',
    head_sha: headSha,
    head_tree_sha: git(['rev-parse', `${headSha}^{tree}`]),
    scanned_product_combo: combo,
    orchestrator_ancestry_proof: ancestryProof,
    scanner_input_fingerprint: bindings.scanner_input_fingerprint,
    runtime_environment: { bun_version: Bun.version },
    scanner_configuration_fingerprint: bindings.scanner_configuration_fingerprint,
    governance_artifacts: bindings.governance_artifacts,
  };
  const evidence = writeEvidence
    ? {
        path: resolve(ROOT, RUNTIME_PIN_PRODUCT_COMBO_EVIDENCE_PATH),
        text: `${JSON.stringify({
          baseline_id: state.currentBaselineId,
          base_main_sha: baseMainSha,
          head_sha: headSha,
          scanned_product_combo: combo,
          orchestrator_ancestry_proof: ancestryProof,
        }, null, 2)}\n`,
      }
    : undefined;
  writeRuntimePinArtifacts(
    resolve(ROOT, RUNTIME_PIN_PATH),
    `${JSON.stringify(pin, null, 2)}\n`,
    evidence,
  );
  process.stdout.write(`[runtime-pin] WROTE ${RUNTIME_PIN_PATH} baseline=${state.currentBaselineId} combo=${Object.keys(combo).length}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`[runtime-pin] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
