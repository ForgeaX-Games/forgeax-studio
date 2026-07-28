import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyBaselineDiff } from './verify-baseline-diff.ts';
import { loadBaselineApproval, parseBaselineApprovalRecord } from './baseline-approval.ts';
import { loadCurrentBaselineState } from './baseline-state.ts';
import { sha256 } from './runtime-snapshot-core.ts';
import * as generatorClassifier from './baseline-diff-classifier.ts';
import * as verifierClassifier from './verify-baseline-diff.ts';
import {
  buildBaselineDiff,
  deriveRootCauseSignals as buildBaselineDiffModuleRootCauseSignals,
  renderDiffJsonl,
} from './build-baseline-diff.ts';

const ROOT = resolve(import.meta.dir, '../..');
const BASELINE_STATE = loadCurrentBaselineState(ROOT);
const FROM_ID = BASELINE_STATE.previousBaselineId;
const TO_ID = BASELINE_STATE.currentBaselineId;
const DIFF_FILENAME = `diff-from-${FROM_ID.split('-').at(-1)}.jsonl`;
const PIN_SOURCE = 'docs/ai-native/pins/m2-2026-07-23.json';
const REASON_TAGS = ['product', 'scanner-config', 'identity', 'ownership'] as const;

type ReasonTag = typeof REASON_TAGS[number];
type RootCauseSignals = {
  productBytesChanged: boolean;
  scannerConfigurationChanged: boolean;
  identityAdjudicationChanged: boolean;
  ownershipAdjudicationChanged: boolean;
};

const NO_CAUSES: RootCauseSignals = {
  productBytesChanged: false,
  scannerConfigurationChanged: false,
  identityAdjudicationChanged: false,
  ownershipAdjudicationChanged: false,
};

const SIGNAL_FOR: Record<ReasonTag, keyof RootCauseSignals> = {
  product: 'productBytesChanged',
  'scanner-config': 'scannerConfigurationChanged',
  identity: 'identityAdjudicationChanged',
  ownership: 'ownershipAdjudicationChanged',
};

function only(reason: ReasonTag): RootCauseSignals {
  return { ...NO_CAUSES, [SIGNAL_FOR[reason]]: true };
}

function makeMetadataDomainsComparable(root: string, fromId: string, toId: string): void {
  const oldMetaPath = join(root, 'docs/ai-native/baseline', fromId, 'meta.json');
  const newMetaPath = join(root, 'docs/ai-native/baseline', toId, 'meta.json');
  const oldMeta = JSON.parse(readFileSync(oldMetaPath, 'utf8'));
  const newMeta = JSON.parse(readFileSync(newMetaPath, 'utf8'));
  oldMeta.scanner_configuration_fingerprint = structuredClone(newMeta.scanner_configuration_fingerprint);
  writeFileSync(oldMetaPath, `${JSON.stringify(oldMeta, null, 2)}\n`);
}

function copyScannerSource(root: string): void {
  const target = join(root, 'scripts/ai-native/scanner.ts');
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(ROOT, 'scripts/ai-native/scanner.ts'), target);
}

function copyReasonAdjudications(root: string, fromId = FROM_ID, toId = TO_ID): void {
  const sourcePath = join(
    'scripts/ai-native/baseline-diff-adjudications',
    `${FROM_ID}--${TO_ID}.jsonl`,
  );
  const targetPath = join(
    'scripts/ai-native/baseline-diff-adjudications',
    `${fromId}--${toId}.jsonl`,
  );
  mkdirSync(dirname(join(root, targetPath)), { recursive: true });
  cpSync(join(ROOT, sourcePath), join(root, targetPath));
}

function copyDiffEvidenceSources(root: string): void {
  const rows = readFileSync(
    join(ROOT, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME),
    'utf8',
  ).trim().split('\n').map((line) => JSON.parse(line));
  for (const path of new Set(rows.map((row) => row.root_cause_ref.replace(/:\d+$/, '')))) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, path), target);
  }
}

function classifiers() {
  return { generator: generatorClassifier, verifier: verifierClassifier };
}

describe('generic baseline root-cause classifier', () => {
  test('generator and independent verifier agree on all four executable causes', async () => {
    const { generator, verifier } = classifiers();
    for (const reason of REASON_TAGS) {
      expect(generator.classifyRootCause(only(reason))).toBe(reason);
      expect(verifier.verifyReasonTag(only(reason), reason)).toBe(reason);
    }
  });

  test('generator and verifier reject every wrong label for each executable cause', async () => {
    const { generator, verifier } = classifiers();
    for (const actualReason of REASON_TAGS) {
      for (const wrongReason of REASON_TAGS.filter((candidate) => candidate !== actualReason)) {
        expect(() => generator.classifyRootCause(only(actualReason), wrongReason)).toThrow(/reason tag mismatch/);
        expect(() => verifier.verifyReasonTag(only(actualReason), wrongReason)).toThrow(/reason tag mismatch/);
      }
    }
  });

  test('generator and independently written verifier property-match every non-empty synthetic cause set', async () => {
    const { generator, verifier } = classifiers();
    for (let mask = 1; mask < 2 ** REASON_TAGS.length; mask += 1) {
      const signals = { ...NO_CAUSES };
      const active: ReasonTag[] = [];
      for (let index = 0; index < REASON_TAGS.length; index += 1) {
        if ((mask & (1 << index)) === 0) continue;
        const reason = REASON_TAGS[index]!;
        signals[SIGNAL_FOR[reason]] = true;
        active.push(reason);
      }
      for (const reason of REASON_TAGS) {
        if (active.includes(reason)) {
          expect(generator.classifyRootCause(signals, reason)).toBe(verifier.verifyReasonTag(signals, reason));
        } else {
          expect(() => generator.classifyRootCause(signals, reason)).toThrow(/reason tag mismatch/);
          expect(() => verifier.verifyReasonTag(signals, reason)).toThrow(/reason tag mismatch/);
        }
      }
    }
  });

  test('generator and verifier independently derive each cause from baseline metadata domains', async () => {
    const generator = { deriveRootCauseSignals: buildBaselineDiffModuleRootCauseSignals };
    const verifier = verifierClassifier;
    const meta = () => ({
      scanner_version: '1.0.0',
      scanned_product_combo: { interface: 'product-a' },
      scanner_configuration_fingerprint: {
        domains: [
          { domain: 'scanner-configuration', sha256: 'scanner-a' },
          { domain: 'identity-aliases', sha256: 'identity-a' },
          { domain: 'ownership-adjudication', sha256: 'ownership-a' },
        ],
      },
    });
    const cases: Array<[ReasonTag, (next: ReturnType<typeof meta>) => void]> = [
      ['product', (next) => { next.scanned_product_combo.interface = 'product-b'; }],
      ['scanner-config', (next) => { next.scanner_configuration_fingerprint.domains[0].sha256 = 'scanner-b'; }],
      ['identity', (next) => { next.scanner_configuration_fingerprint.domains[1].sha256 = 'identity-b'; }],
      ['ownership', (next) => { next.scanner_configuration_fingerprint.domains[2].sha256 = 'ownership-b'; }],
    ];
    for (const [reason, mutate] of cases) {
      const oldMeta = meta();
      const newMeta = meta();
      mutate(newMeta);
      expect(generator.deriveRootCauseSignals(oldMeta, newMeta)).toEqual(only(reason));
      expect(verifier.deriveVerifierRootCauseSignals(oldMeta, newMeta)).toEqual(only(reason));
    }

    const oldMeta = meta();
    const concurrentMeta = meta();
    concurrentMeta.scanner_configuration_fingerprint.domains[0].sha256 = 'scanner-b';
    concurrentMeta.scanner_configuration_fingerprint.domains[1].sha256 = 'identity-b';
    const expectedConcurrent = {
      ...NO_CAUSES,
      scannerConfigurationChanged: true,
      identityAdjudicationChanged: true,
    };
    expect(generator.deriveRootCauseSignals(oldMeta, concurrentMeta)).toEqual(expectedConcurrent);
    expect(verifier.deriveVerifierRootCauseSignals(oldMeta, concurrentMeta)).toEqual(expectedConcurrent);
  });

  test('scanner upgrade plus identity re-adjudication cannot collapse to all scanner-config', async () => {
    const { generator, verifier } = classifiers();
    const concurrent = {
      ...NO_CAUSES,
      scannerConfigurationChanged: true,
      identityAdjudicationChanged: true,
    };
    expect(generator.classifyRootCause(concurrent, 'scanner-config')).toBe('scanner-config');
    expect(generator.classifyRootCause(concurrent, 'identity')).toBe('identity');
    expect(verifier.verifyReasonTag(concurrent, 'scanner-config')).toBe('scanner-config');
    expect(verifier.verifyReasonTag(concurrent, 'identity')).toBe('identity');
    expect(() => verifier.verifyReasonTag(concurrent, 'product')).toThrow(/reason tag mismatch/);
  });

  test('rejects intervals with no changed cause and ambiguous rows without adjudication', async () => {
    const { generator, verifier } = classifiers();
    expect(() => generator.classifyRootCause(NO_CAUSES)).toThrow(/no root cause/);
    expect(() => verifier.verifyReasonTag(NO_CAUSES, 'product')).toThrow(/no root cause/);

    const ambiguous = {
      ...NO_CAUSES,
      productBytesChanged: true,
      scannerConfigurationChanged: true,
    };
    expect(() => generator.classifyRootCause(ambiguous)).toThrow(/ambiguous root causes/);
  });

  test('fails loud when metadata domains are incomparable instead of silently returning false', () => {
    const oldMeta = { scanner_version: '1.0.0', scanned_product_combo: { studio: 'same' } };
    const newMeta = {
      ...oldMeta,
      scanner_configuration_fingerprint: { domains: [] },
    };
    expect(() => buildBaselineDiffModuleRootCauseSignals(oldMeta, newMeta)).toThrow(
      /metadata domains are incomparable.*per-row adjudication/i,
    );
    expect(() => verifierClassifier.deriveVerifierRootCauseSignals(oldMeta, newMeta)).toThrow(
      /metadata domains are incomparable.*per-row adjudication/i,
    );
  });

  test('rejects incomparable metadata when the required per-row adjudication is incomplete', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-incomparable-adjudicated-'));
    try {
      for (const baselineId of [FROM_ID, TO_ID]) {
        cpSync(
          join(ROOT, 'docs/ai-native/baseline', baselineId),
          join(tempRoot, 'docs/ai-native/baseline', baselineId),
          { recursive: true },
        );
      }
      copyScannerSource(tempRoot);
      expect(() => buildBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
        reasonAdjudications: {},
      })).toThrow(/(incomparable metadata|ambiguous root causes).*explicit (per-row |row )?adjudication/i);
      expect(() => verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
        reasonAdjudications: {},
      })).toThrow(/(incomparable metadata|ambiguous root causes).*row adjudication/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('classification is invariant under source and root-cause line shifts', async () => {
    const { generator, verifier } = classifiers();
    const signals = only('identity');
    const atOldLines = { ...signals, source_location: { file: 'src/a.ts', line: 47 }, root_cause_ref: 'scanner.ts:109' };
    const atNewLines = { ...signals, source_location: { file: 'src/a.ts', line: 4700 }, root_cause_ref: 'scanner.ts:9001' };
    expect(generator.classifyRootCause(atOldLines)).toBe(generator.classifyRootCause(atNewLines));
    expect(verifier.verifyReasonTag(atOldLines, 'identity')).toBe(verifier.verifyReasonTag(atNewLines, 'identity'));
  });

  test('verifier does not import the generator classifier implementation', () => {
    const verifierSource = readFileSync(join(import.meta.dir, 'verify-baseline-diff.ts'), 'utf8');
    expect(verifierSource).not.toMatch(/from ['"]\.\/baseline-diff-classifier/);
    expect(verifierSource).not.toMatch(/classifyRootCause/);
  });
});

describe('parameterized baseline diff generator', () => {
  test('import has no write side effect', async () => {
    const jsonlPath = join(ROOT, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME);
    const before = statSync(jsonlPath, { bigint: true }).mtimeNs;
    const imported = Bun.spawnSync([
      'bun',
      '-e',
      `await import('./scripts/ai-native/build-baseline-diff.ts?side-effect-check=${Date.now()}')`,
    ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(imported.exitCode).toBe(0);
    const after = statSync(jsonlPath, { bigint: true }).mtimeNs;
    expect(after).toEqual(before);
  });

  test('retained predecessor to current rebuild is byte-identical to the published JSONL', async () => {
    const rebuilt = buildBaselineDiff({ repoRoot: ROOT, fromBaselineId: FROM_ID, toBaselineId: TO_ID });
    const published = readFileSync(join(ROOT, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME), 'utf8');
    expect(renderDiffJsonl(rebuilt.rows)).toBe(published);
    expect(new Set(rebuilt.rows.map((row) => row.reason_tag))).toEqual(new Set(['product']));
    expect(rebuilt.attributionSignalCrossCheck).toEqual({
      status: 'performed',
      reason: null,
    });
    expect(rebuilt.rows.every((row) => (
      row.schema_version === 2
      && row.attribution_signal_cross_check.status === 'performed'
    ))).toBe(true);
  });

  test('resolves product evidence and rejects a stale derivative after frozen coordinate drift', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-anchor-shift-'));
    try {
      for (const baselineId of [FROM_ID, TO_ID]) {
        cpSync(
          join(ROOT, 'docs/ai-native/baseline', baselineId),
          join(tempRoot, 'docs/ai-native/baseline', baselineId),
          { recursive: true },
        );
      }
      copyScannerSource(tempRoot);
      copyReasonAdjudications(tempRoot);
      copyDiffEvidenceSources(tempRoot);
      const controlsPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, 'controls.jsonl');
      const controls = readFileSync(controlsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      controls[0].evidence_line -= 1;
      writeFileSync(controlsPath, `${controls.map((row) => JSON.stringify(row)).join('\n')}\n`);

      expect(() => verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      })).toThrow(/full-payload mismatch/);

      const rebuilt = buildBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      });
      const diffPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME);
      writeFileSync(diffPath, renderDiffJsonl(rebuilt.rows));
      expect(verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      })).toMatchObject({ rows: 269 });
      expect(rebuilt.rows.every((row) => {
        const match = /^(.*):(\d+)$/.exec(row.root_cause_ref);
        if (!match) return true;
        return readFileSync(join(tempRoot, match[1]!), 'utf8')
          .split('\n')[Number(match[2]) - 1]?.trim().length !== 0;
      })).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('accepts arbitrary baseline ids and does not enforce 109 rows or 47 note changes', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-generic-'));
    const fromId = 'fixture-from';
    const toId = 'fixture-to';
    try {
      cpSync(
        join(ROOT, 'docs/ai-native/baseline', FROM_ID),
        join(tempRoot, 'docs/ai-native/baseline', fromId),
        { recursive: true },
      );
      cpSync(
        join(ROOT, 'docs/ai-native/baseline', TO_ID),
        join(tempRoot, 'docs/ai-native/baseline', toId),
        { recursive: true },
      );
      copyScannerSource(tempRoot);
      makeMetadataDomainsComparable(tempRoot, fromId, toId);
      copyReasonAdjudications(tempRoot, fromId, toId);
      copyDiffEvidenceSources(tempRoot);

      const result = buildBaselineDiff({ repoRoot: tempRoot, fromBaselineId: fromId, toBaselineId: toId });
      expect(result.rows.length).toBeGreaterThan(109);
      expect(result.notesExcluded).toBe(0);
      expect(result.rows.every((row) => (
        row.from_baseline_id === fromId && row.to_baseline_id === toId
      ))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('accepts a changed product combo without requiring a scanner-version change', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-product-'));
    try {
      cpSync(
        join(ROOT, 'docs/ai-native/baseline', FROM_ID),
        join(tempRoot, 'docs/ai-native/baseline', FROM_ID),
        { recursive: true },
      );
      cpSync(
        join(ROOT, 'docs/ai-native/baseline', TO_ID),
        join(tempRoot, 'docs/ai-native/baseline', TO_ID),
        { recursive: true },
      );
      copyScannerSource(tempRoot);
      copyReasonAdjudications(tempRoot);
      copyDiffEvidenceSources(tempRoot);
      const oldMetaPath = join(tempRoot, 'docs/ai-native/baseline', FROM_ID, 'meta.json');
      const newMetaPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, 'meta.json');
      const oldMeta = JSON.parse(readFileSync(oldMetaPath, 'utf8'));
      const newMeta = JSON.parse(readFileSync(newMetaPath, 'utf8'));
      newMeta.scanner_version = oldMeta.scanner_version;
      newMeta.scanner_configuration_fingerprint = structuredClone(oldMeta.scanner_configuration_fingerprint);
      newMeta.scanned_product_combo = { ...oldMeta.scanned_product_combo, interface: 'changed-product-bytes' };
      writeFileSync(newMetaPath, `${JSON.stringify(newMeta, null, 2)}\n`);

      const result = buildBaselineDiff({ repoRoot: tempRoot, fromBaselineId: FROM_ID, toBaselineId: TO_ID });
      expect(result.rows).not.toHaveLength(0);
      expect(new Set(result.rows.map((row) => row.reason_tag))).toEqual(new Set(['product']));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generator rejects scanner plus identity concurrency without explicit row adjudications', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-concurrent-'));
    try {
      for (const baselineId of [FROM_ID, TO_ID]) {
        cpSync(
          join(ROOT, 'docs/ai-native/baseline', baselineId),
          join(tempRoot, 'docs/ai-native/baseline', baselineId),
          { recursive: true },
        );
      }
      copyScannerSource(tempRoot);
      makeMetadataDomainsComparable(tempRoot, FROM_ID, TO_ID);
      const oldMetaPath = join(tempRoot, 'docs/ai-native/baseline', FROM_ID, 'meta.json');
      const newMetaPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, 'meta.json');
      const oldMeta = JSON.parse(readFileSync(oldMetaPath, 'utf8'));
      const newMeta = JSON.parse(readFileSync(newMetaPath, 'utf8'));
      oldMeta.identity_adjudication_fingerprint = { aliases_sha256: 'identity-a' };
      newMeta.identity_adjudication_fingerprint = { aliases_sha256: 'identity-b' };
      writeFileSync(oldMetaPath, `${JSON.stringify(oldMeta, null, 2)}\n`);
      writeFileSync(newMetaPath, `${JSON.stringify(newMeta, null, 2)}\n`);

      expect(() => buildBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      })).toThrow(/ambiguous root causes.*explicit row adjudication is required/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('baseline diff independent full-payload verifier', () => {
  test('reconstructs all published rows and resolves every root-cause reference', () => {
    expect(verifyBaselineDiff({
      repoRoot: ROOT,
      fromBaselineId: FROM_ID,
      toBaselineId: TO_ID,
    })).toMatchObject({
      rows: 269,
      notesExcluded: 0,
      attributionSignalCrossCheck: {
        status: 'performed',
        reason: null,
      },
    });
  });

  test('executes the independent attribution signal cross-check when metadata is comparable', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-comparable-'));
    try {
      for (const baselineId of [FROM_ID, TO_ID]) {
        cpSync(
          join(ROOT, 'docs/ai-native/baseline', baselineId),
          join(tempRoot, 'docs/ai-native/baseline', baselineId),
          { recursive: true },
        );
      }
      copyScannerSource(tempRoot);
      makeMetadataDomainsComparable(tempRoot, FROM_ID, TO_ID);
      copyReasonAdjudications(tempRoot);
      copyDiffEvidenceSources(tempRoot);
      const rebuilt = buildBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      });
      expect(rebuilt.attributionSignalCrossCheck).toEqual({ status: 'performed', reason: null });
      const diffPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME);
      writeFileSync(diffPath, renderDiffJsonl(rebuilt.rows));
      expect(verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      }).attributionSignalCrossCheck).toEqual({ status: 'performed', reason: null });

      const rows = readFileSync(diffPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      rows[0].reason_tag = 'scanner-config';
      writeFileSync(diffPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      expect(() => verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      })).toThrow(/full-payload mismatch/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a forged old_value even when mechanism ids and labels still match', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-diff-'));
    try {
      for (const baselineId of [FROM_ID, TO_ID]) {
        cpSync(
          join(ROOT, 'docs/ai-native/baseline', baselineId),
          join(tempRoot, 'docs/ai-native/baseline', baselineId),
          { recursive: true },
        );
      }
      makeMetadataDomainsComparable(tempRoot, FROM_ID, TO_ID);
      copyScannerSource(tempRoot);
      copyReasonAdjudications(tempRoot);
      copyDiffEvidenceSources(tempRoot);
      const diffPath = join(tempRoot, 'docs/ai-native/baseline', TO_ID, DIFF_FILENAME);
      const rebuilt = buildBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      });
      writeFileSync(diffPath, renderDiffJsonl(rebuilt.rows));
      const rows = readFileSync(diffPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      rows[0].old_value = 'forged-payload';
      writeFileSync(diffPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      expect(() => verifyBaselineDiff({
        repoRoot: tempRoot,
        fromBaselineId: FROM_ID,
        toBaselineId: TO_ID,
      })).toThrow(/full-payload mismatch/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('machine-readable baseline approval', () => {
  test('retains the approved predecessor receipt', () => {
    const approved = loadBaselineApproval(ROOT, FROM_ID, PIN_SOURCE);
    expect(approved.status).toBe(
      approved.governance_verification.status === 'verified'
        ? 'approved'
        : 'unverified-diagnostic',
    );
  });

  test('retains an archived decision-evidence hash reference when the file is absent', () => {
    const approved = loadBaselineApproval(ROOT, FROM_ID, PIN_SOURCE);
    expect(approved.decision_evidence).toBe(
      'docs/ai-native/evidence/2026-07-25-user-decisions-phase2.md',
    );
    expect(approved.decision_evidence_sha256).toBe(
      '86d3dafedaa2d6f19334efcaf648523b843e300c4b127cf982c287ab825fc653',
    );
    expect(existsSync(join(ROOT, approved.decision_evidence!))).toBe(false);
  });

  test('rejects a baseline whose frozen bytes no longer match the approval record', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-approval-'));
    try {
      cpSync(
        join(ROOT, 'docs/ai-native/baseline', TO_ID),
        join(tempRoot, 'docs/ai-native/baseline', TO_ID),
        { recursive: true },
      );
      const approvalTarget = join(tempRoot, 'docs/ai-native/baseline/approvals.json');
      mkdirSync(dirname(approvalTarget), { recursive: true });
      cpSync(join(ROOT, 'docs/ai-native/baseline/approvals.json'), approvalTarget);
      const pinTarget = join(tempRoot, PIN_SOURCE);
      mkdirSync(dirname(pinTarget), { recursive: true });
      cpSync(join(ROOT, PIN_SOURCE), pinTarget);
      const summary = join(tempRoot, 'docs/ai-native/baseline', TO_ID, 'summary.md');
      writeFileSync(summary, `${readFileSync(summary, 'utf8')}forged\n`);
      expect(() => loadBaselineApproval(tempRoot, TO_ID, PIN_SOURCE)).toThrow(/byte SHA mismatch/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('approved baseline rejects whitespace-only decision evidence after trimming', () => {
    expect(() => parseBaselineApprovalRecord({
      baseline_id: FROM_ID,
      baseline_bytes_sha256: 'a'.repeat(64),
      status: 'approved',
      decision_evidence: '   ',
      decision_evidence_sha256: 'b'.repeat(64),
      approved_content_commit: 'c'.repeat(40),
      approval_manifest_raw_sha256: 'd'.repeat(64),
      approval_scope_sha256: 'e'.repeat(64),
      approval_package_raw_sha256: 'f'.repeat(64),
    })).toThrow(/decision_evidence|at least 1 character/i);
  });

  test('approved baseline rejects rewritten decision evidence bytes', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-baseline-evidence-'));
    try {
      cpSync(join(ROOT, 'docs/ai-native/baseline', FROM_ID), join(tempRoot, 'docs/ai-native/baseline', FROM_ID), { recursive: true });
      const approvalsTarget = join(tempRoot, 'docs/ai-native/baseline/approvals.json');
      mkdirSync(dirname(approvalsTarget), { recursive: true });
      cpSync(join(ROOT, 'docs/ai-native/baseline/approvals.json'), approvalsTarget);
      const evidencePath = 'docs/ai-native/evidence/2026-07-25-user-decisions-phase2.md';
      const evidenceTarget = join(tempRoot, evidencePath);
      mkdirSync(dirname(evidenceTarget), { recursive: true });
      const pinTarget = join(tempRoot, PIN_SOURCE);
      mkdirSync(dirname(pinTarget), { recursive: true });
      cpSync(join(ROOT, PIN_SOURCE), pinTarget);
      writeFileSync(evidenceTarget, 'rewritten after approval\n');
      expect(() => loadBaselineApproval(tempRoot, FROM_ID, PIN_SOURCE)).toThrow(
        /baseline approval decision evidence SHA-256 mismatch/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('forged approval plus a re-signed pin is downgraded to diagnostic without approved output', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-approval-owner-'));
    try {
      cpSync(join(ROOT, 'docs/ai-native/baseline', FROM_ID), join(tempRoot, 'docs/ai-native/baseline', FROM_ID), { recursive: true });
      const approvalsTarget = join(tempRoot, 'docs/ai-native/baseline/approvals.json');
      mkdirSync(dirname(approvalsTarget), { recursive: true });
      cpSync(join(ROOT, 'docs/ai-native/baseline/approvals.json'), approvalsTarget);
      const pinTarget = join(tempRoot, PIN_SOURCE);
      mkdirSync(dirname(pinTarget), { recursive: true });
      cpSync(join(ROOT, PIN_SOURCE), pinTarget);
      const forgedEvidencePath = 'docs/ai-native/evidence/forged-approval.md';
      const forgedEvidenceTarget = join(tempRoot, forgedEvidencePath);
      mkdirSync(dirname(forgedEvidenceTarget), { recursive: true });
      writeFileSync(forgedEvidenceTarget, 'self-consistent forged approval\n');
      const approvals = JSON.parse(readFileSync(approvalsTarget, 'utf8'));
      const approved = approvals.records.find((record: Record<string, unknown>) => record.baseline_id === FROM_ID);
      approved.decision_evidence = forgedEvidencePath;
      approved.decision_evidence_sha256 = sha256(readFileSync(forgedEvidenceTarget));
      writeFileSync(approvalsTarget, `${JSON.stringify(approvals, null, 2)}\n`);
      const pin = JSON.parse(readFileSync(pinTarget, 'utf8'));
      pin.governance_artifacts.baseline_approvals.sha256 = sha256(readFileSync(approvalsTarget));
      writeFileSync(pinTarget, `${JSON.stringify(pin, null, 2)}\n`);
      expect(loadBaselineApproval(tempRoot, FROM_ID, PIN_SOURCE)).toMatchObject({
        status: 'unverified-diagnostic',
        governance_verification: { status: 'unverified-diagnostic' },
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
