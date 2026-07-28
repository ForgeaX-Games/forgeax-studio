#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCurrentBaselineState } from './baseline-state.ts';
import {
  CAPABILITY_RATCHET_GENESIS_PATH,
  validateCapabilityRatchet,
} from './capability-ratchet.ts';

const ROOT = resolve(import.meta.dir, '../..');
const OUT = resolve(ROOT, 'scripts/ai-native');

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
}

function controlIds(baselineId: string): string[] {
  return readFileSync(resolve(ROOT, 'docs/ai-native/baseline', baselineId, 'controls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { control_id: string }).control_id))
    .sort();
}

function renderCapabilityBaseline(): string {
  const state = loadCurrentBaselineState(ROOT);
  const historyDirectory = join(OUT, 'capability-baseline-history');
  const previousNames = readdirSync(historyDirectory)
    .filter((name) => name.startsWith(`${state.previousBaselineId}-`) && name.endsWith('.json'));
  if (previousNames.length !== 1) {
    throw new Error(`expected one previous ratchet for ${state.previousBaselineId}, found ${previousNames.length}`);
  }
  const previousPath = join(historyDirectory, previousNames[0]!);
  const previousBytes = readFileSync(previousPath);
  const previous = JSON.parse(previousBytes.toString('utf8')) as unknown;
  const canonicalPreviousBytes = `${JSON.stringify(previous, null, 2)}\n`;
  const r6 = json<{ migrated_control_ids: string[] }>('scripts/ai-native/r6-coverage.json');
  const sourceIds = controlIds(state.currentBaselineId);
  const migrated = new Set(r6.migrated_control_ids);
  const active = {
    schema_version: 1,
    baseline_id: state.currentBaselineId,
    source: `docs/ai-native/baseline/${state.currentBaselineId}/controls.jsonl`,
    invariant: 'unmigrated_control_ids is exactly the current frozen control set minus calculator-migrated controls; baseline transitions are chained by previous_sha256',
    previous_sha256: createHash('sha256').update(canonicalPreviousBytes).digest('hex'),
    control_count: sourceIds.filter((id) => !migrated.has(id)).length,
    unmigrated_control_ids: sourceIds.filter((id) => !migrated.has(id)),
  };
  const intermediateHistory = readdirSync(historyDirectory)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== CAPABILITY_RATCHET_GENESIS_PATH.split('/').at(-1))
    .filter((name) => name !== previousNames[0])
    .sort()
    .map((name) => json(join(historyDirectory, name)));
  const balance = json<{ seed_sha256: string }>('scripts/ai-native/r4r5-balance.json');
  validateCapabilityRatchet({
    active,
    previous,
    genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
    history: intermediateHistory,
    sourceControlIds: sourceIds,
    previousSourceControlIds: controlIds(state.previousBaselineId),
    calculatorMigratedControlIds: r6.migrated_control_ids,
    recordedSeedSha256: balance.seed_sha256,
  });
  return `${JSON.stringify(active, null, 2)}\n`;
}

function main(argv: string[]): void {
  const mode = argv[0] ?? '--write';
  if (argv.length > 1 || !['--write', '--check'].includes(mode)) {
    throw new Error('usage: derive-capability-baseline.ts [--write|--check]');
  }
  const expected = renderCapabilityBaseline();
  const path = join(OUT, 'capability-baseline.json');
  if (mode === '--write') writeFileSync(path, expected);
  else if (readFileSync(path, 'utf8') !== expected) throw new Error('capability baseline is stale');
  const active = JSON.parse(expected) as { baseline_id: string; control_count: number };
  process.stdout.write(
    `[capability-baseline] ${mode === '--write' ? 'WROTE' : 'PASS'} `
    + `baseline=${active.baseline_id} unmigrated=${active.control_count}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[capability-baseline] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
