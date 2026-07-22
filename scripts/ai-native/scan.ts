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
  DEFAULT_ROOT,
  renderInventory,
  renderVocabMap,
  stratifiedNegativeSample,
} from './scanner';

interface CliOptions {
  verify: boolean;
  sampleNegatives: number;
}

function parseArgs(argv: string[]): CliOptions {
  let verify = false;
  let sampleNegatives = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') verify = true;
    else if (arg === '--sample-negatives') {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error('--sample-negatives requires a non-negative integer');
      sampleNegatives = Number(value);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/ai-native/scan.ts [--verify] [--sample-negatives N]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { verify, sampleNegatives };
}

export function verificationArtifacts(rendered: Record<string, string>): Record<string, string> {
  const comparable = { ...rendered };
  if (comparable['meta.json'] !== undefined) {
    const meta = JSON.parse(comparable['meta.json']) as Record<string, unknown>;
    delete meta.artifact_commit;
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(DEFAULT_ROOT);
  const first = await buildInventory({ root });
  const rendered = renderInventory(first);
  const baselineDir = join(root, 'docs/ai-native/baseline', first.baselineId);
  const vocabPath = join(root, 'scripts/ai-native/vocab-map.json');
  const vocabRendered = renderVocabMap(first.vocabMap);

  if (opts.verify) {
    const second = await buildInventory({ root });
    compareRendered(rendered, renderInventory(second), 'two in-memory scans');
    if (!existsSync(baselineDir)) throw new Error(`frozen baseline missing: ${baselineDir}`);
    compareRendered(rendered, readBaseline(baselineDir, Object.keys(rendered)), 'frozen baseline');
    if (readFileSync(vocabPath, 'utf8') !== vocabRendered) throw new Error('vocab-map.json is stale');
    console.log(`[ai-native] verify ok: two scans and frozen ${first.baselineId} are byte-identical`);
  } else {
    if (existsSync(baselineDir)) {
      const missing = Object.keys(rendered).filter((name) => !existsSync(join(baselineDir, name)));
      if (missing.length) throw new Error(`frozen baseline is incomplete (${missing.join(', ')}); do not overwrite it in place`);
      compareRendered(rendered, readBaseline(baselineDir, Object.keys(rendered)), 'frozen baseline (bump scanner version or use a new UTC date)');
      if (readFileSync(vocabPath, 'utf8') !== vocabRendered) throw new Error('vocab-map.json differs from the frozen baseline; bump scanner version before changing it');
      console.log(`[ai-native] baseline ${first.baselineId} already frozen and byte-identical`);
    } else {
      mkdirSync(baselineDir, { recursive: true });
      for (const [name, content] of Object.entries(rendered)) writeFileSync(join(baselineDir, name), content);
      writeFileSync(vocabPath, vocabRendered);
      console.log(`[ai-native] wrote ${first.baselineId} -> ${baselineDir}`);
    }
  }

  const s = first.stats;
  console.log(`[ai-native] controls=${s.controls} effects=${s.effects} agent-equiv-effects=${s.agentEquivalentEffects}`);
  console.log(`[ai-native] manual-pool=${s.manualPool} control-ratio=${(s.manualControlRatio * 100).toFixed(1)}% — ${judgment(s.manualControlRatio)}`);
  console.log(`[ai-native] onClick=${s.rawOnClick}/${s.rawOnClickFiles} files (anchor ~195/~40); endpoints=${s.endpoints}; useSurface-calls=${s.actualUseSurfaceCalls}`);
  console.log('[ai-native] note: no team extension manifest lives under packages/orchestrator; tool equivalence is marked runtime-fill via GET /api/tools');

  if (opts.sampleNegatives > 0) {
    const sample = stratifiedNegativeSample(first.negativeCandidates, opts.sampleNegatives, first.baselineId);
    console.log(`[ai-native] stratified negative sample ${sample.length}/${opts.sampleNegatives}:`);
    for (const row of sample) console.log(JSON.stringify(row));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[ai-native] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
