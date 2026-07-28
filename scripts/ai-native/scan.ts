#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildInventory,
  DEFAULT_SCANNER_CONFIG,
  DEFAULT_ROOT,
  loadScannerLifecycleConfig,
  renderInventory,
  renderVocabMap,
  negativeSampleSeed,
  stratifiedNegativeSample,
} from './scanner';
import { assertIntegrityDomainGenerated } from './integrity-domain.ts';
import {
  computeInventoryScannerConfigurationFingerprint,
  projectScannerConfigurationFingerprint,
  type ScannerConfigurationFingerprint,
} from './runtime-artifact-integrity.ts';

export interface CliOptions {
  verify: boolean;
  dryRun: boolean;
  sampleNegatives: number;
  noGit: boolean;
  baselineDate?: string;
  configPath: string;
}

export function parseScannerArgs(argv: string[]): CliOptions {
  let verify = false;
  let dryRun = false;
  let sampleNegatives = 0;
  let noGit = false;
  let baselineDate: string | undefined;
  let configPath = DEFAULT_SCANNER_CONFIG;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') verify = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--no-git') noGit = true;
    else if (arg === '--baseline-date') {
      const value = argv[++i];
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--baseline-date requires YYYY-MM-DD');
      baselineDate = value;
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error('--config requires a repository-relative JSON path');
      configPath = value;
    }
    else if (arg === '--sample-negatives') {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error('--sample-negatives requires a non-negative integer');
      sampleNegatives = Number(value);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/ai-native/scan.ts [--dry-run|--verify] [--no-git] [--config PATH] [--baseline-date YYYY-MM-DD] [--sample-negatives N]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (verify && dryRun) throw new Error('--verify and --dry-run are mutually exclusive');
  if (!dryRun && baselineDate === undefined) {
    throw new Error('--baseline-date is required for --verify and freeze paths');
  }
  return { verify, dryRun, sampleNegatives, noGit, baselineDate, configPath };
}

export function verificationArtifacts(rendered: Record<string, string>): Record<string, string> {
  const comparable = { ...rendered };
  if (comparable['meta.json'] !== undefined) {
    const meta = JSON.parse(comparable['meta.json']) as Record<string, unknown>;
    delete meta.artifact_commit;
    if (meta.scanner_configuration_fingerprint) {
      meta.scanner_configuration_fingerprint = projectScannerConfigurationFingerprint(
        meta.scanner_configuration_fingerprint as ScannerConfigurationFingerprint,
      );
    }
    comparable['meta.json'] = `${JSON.stringify(meta, null, 2)}\n`;
  }
  return comparable;
}

function compareRendered(a: Record<string, string>, b: Record<string, string>, label: string): void {
  const comparableA = verificationArtifacts(a);
  const comparableB = verificationArtifacts(b);
  const names = [...new Set([...Object.keys(comparableA), ...Object.keys(comparableB)])].sort();
  const changed = names.filter((name) => comparableA[name] !== comparableB[name]);
  if (changed.length) throw new Error(`${label} differs: ${changed.join(', ')}`);
}

function readBaseline(dir: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

function judgment(ratio: number): string {
  if (ratio <= 0.25) return 'acceptable for M0 (≤25%; bounded manual follow-up queue)';
  if (ratio <= 0.4) return 'borderline (freeze is usable, but callback classification should be the next task)';
  return 'not acceptable (>40%; add propagation rules before drawing coverage conclusions)';
}

function assertRenderedConfigurationFingerprint(root: string, meta: Record<string, unknown>): void {
  const rendered = meta.scanner_configuration_fingerprint;
  const current = computeInventoryScannerConfigurationFingerprint(root);
  if (JSON.stringify(rendered) !== JSON.stringify(current)) {
    throw new Error('freeze refused: scanner configuration changed after inventory rendering');
  }
}

export async function executeScanner(
  opts: CliOptions,
  repoRoot: string = DEFAULT_ROOT,
  log: (message: string) => void = console.log,
): Promise<void> {
  const root = resolve(repoRoot);
  if (!opts.dryRun) assertIntegrityDomainGenerated(root);
  const scannerConfig = loadScannerLifecycleConfig(root, opts.configPath);
  if (opts.dryRun) scannerConfig.productPinSource = 'live';
  const buildOptions = {
    root,
    scannerConfig,
    noGit: opts.noGit,
    ...(opts.baselineDate ? { baselineDate: opts.baselineDate } : {}),
  };
  const first = await buildInventory(buildOptions);
  const rendered = renderInventory(first);
  const baselineDir = join(root, 'docs/ai-native/baseline', first.baselineId);
  const vocabPath = join(root, 'scripts/ai-native/vocab-map.json');
  const vocabRendered = renderVocabMap(first.vocabMap);
  if (!opts.dryRun) {
    assertRenderedConfigurationFingerprint(root, first.meta as Record<string, unknown>);
  }

  if (opts.dryRun) {
    const second = await buildInventory(buildOptions);
    compareRendered(rendered, renderInventory(second), 'two dry-run scans');
    log(`[ai-native] dry-run ok: ${first.baselineId} is byte-stable; no baseline or vocab files written`);
  } else if (opts.verify) {
    const second = await buildInventory(buildOptions);
    compareRendered(rendered, renderInventory(second), 'two in-memory scans');
    if (!existsSync(baselineDir)) throw new Error(`frozen baseline missing: ${baselineDir}`);
    compareRendered(rendered, readBaseline(baselineDir, Object.keys(rendered)), 'frozen baseline');
    if (readFileSync(vocabPath, 'utf8') !== vocabRendered) throw new Error('vocab-map.json is stale');
    log(`[ai-native] verify ok: two scans and frozen ${first.baselineId} are byte-identical`);
  } else {
    if (existsSync(baselineDir)) {
      const missing = Object.keys(rendered).filter((name) => !existsSync(join(baselineDir, name)));
      if (missing.length) throw new Error(`frozen baseline is incomplete (${missing.join(', ')}); do not overwrite it in place`);
      compareRendered(rendered, readBaseline(baselineDir, Object.keys(rendered)), 'frozen baseline (bump scanner version or use a new UTC date)');
      if (readFileSync(vocabPath, 'utf8') !== vocabRendered) throw new Error('vocab-map.json differs from the frozen baseline; bump scanner version before changing it');
      log(`[ai-native] baseline ${first.baselineId} already frozen and byte-identical`);
    } else {
      assertRenderedConfigurationFingerprint(root, first.meta as Record<string, unknown>);
      writeFileSync(vocabPath, vocabRendered);
      mkdirSync(baselineDir, { recursive: true });
      for (const [name, content] of Object.entries(rendered)) writeFileSync(join(baselineDir, name), content);
      log(`[ai-native] wrote ${first.baselineId} -> ${baselineDir}`);
    }
  }

  const s = first.stats;
  log(`[ai-native] controls=${s.controls} effects=${s.effects} agent-equiv-effects=${s.agentEquivalentEffects}`);
  log(`[ai-native] manual-pool=${s.manualPool} control-ratio=${(s.manualControlRatio * 100).toFixed(1)}% — ${judgment(s.manualControlRatio)}`);
  log(`[ai-native] onClick=${s.rawOnClick}/${s.rawOnClickFiles} files (anchor ~195/~40); endpoints=${s.endpoints}; useSurface-calls=${s.actualUseSurfaceCalls}`);
  log('[ai-native] note: no team extension manifest lives under packages/orchestrator; tool equivalence is marked runtime-fill via GET /api/tools');

  if (opts.sampleNegatives > 0) {
    const sample = stratifiedNegativeSample(first.negativeCandidates, opts.sampleNegatives, first.baselineId);
    log(`[ai-native] negative sample seeds: tsx=${negativeSampleSeed(first.baselineId, 'tsx')} ts=${negativeSampleSeed(first.baselineId, 'ts')}`);
    log(`[ai-native] stratified negative sample ${sample.length}/${opts.sampleNegatives}:`);
    for (const row of sample) log(JSON.stringify(row));
  }
}

if (import.meta.main) {
  executeScanner(parseScannerArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[ai-native] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
