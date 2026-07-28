import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CurrentBaselineState {
  currentBaselineId: string;
  previousBaselineId: string;
  baselineDate: string;
  scannerVersion: string;
}

export function loadCurrentBaselineState(repoRoot: string): CurrentBaselineState {
  const root = resolve(repoRoot);
  const config = JSON.parse(readFileSync(join(root, 'scripts/ai-native/scanner-config.json'), 'utf8')) as {
    series?: unknown;
    baseline_id?: unknown;
    scanner_version?: unknown;
    previous_baseline_id?: unknown;
  };
  if (typeof config.baseline_id !== 'string' || typeof config.previous_baseline_id !== 'string') {
    throw new Error('scanner-config baseline_id and previous_baseline_id must be strings');
  }
  if (typeof config.series !== 'string' || typeof config.scanner_version !== 'string') {
    throw new Error('scanner-config series and scanner_version must be strings');
  }
  const match = /^(b[1-9][0-9]*)-(\d{4}-\d{2}-\d{2})-(\d+\.\d+\.\d+)$/.exec(config.baseline_id);
  if (!match || match[1] !== config.series || match[3] !== config.scanner_version) {
    throw new Error('scanner-config baseline_id disagrees with series or scanner_version');
  }
  return {
    currentBaselineId: config.baseline_id,
    previousBaselineId: config.previous_baseline_id,
    baselineDate: match[2]!,
    scannerVersion: config.scanner_version,
  };
}
