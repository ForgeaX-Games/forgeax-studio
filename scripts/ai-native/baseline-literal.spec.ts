import { describe, expect, it } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { loadCurrentBaselineState } from './baseline-state.ts';

const ROOT = resolve(import.meta.dir, '../..');

function codeFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full);
      else if (['.ts', '.yml', '.yaml'].includes(extname(name))) result.push(full);
    }
  };
  visit(join(root, 'scripts/ai-native'));
  visit(join(root, '.github/workflows'));
  result.push(join(root, 'package.json'));
  return result;
}

function currentBaselineLiteralOffenders(root: string): string[] {
  const state = loadCurrentBaselineState(root);
  return codeFiles(root)
    .filter((path) => readFileSync(path, 'utf8').includes(state.currentBaselineId))
    .map((path) => relative(root, path).replaceAll('\\', '/'));
}

function requireNoCurrentBaselineLiterals(root: string): void {
  const offenders = currentBaselineLiteralOffenders(root);
  if (offenders.length > 0) {
    throw new Error(`current baseline literal must come only from scanner-config: ${offenders.join(', ')}`);
  }
}

describe('current baseline literal single source', () => {
  it('keeps the current baseline id out of executable/configuration files other than scanner-config', () => {
    const state = loadCurrentBaselineState(ROOT);
    expect(() => requireNoCurrentBaselineLiterals(ROOT)).not.toThrow();
    expect(readFileSync(join(ROOT, 'scripts/ai-native/scanner-config.json'), 'utf8')).toContain(state.currentBaselineId);
  });

  it('fails closed when an executable repeats the derived current baseline id', () => {
    const state = loadCurrentBaselineState(ROOT);
    const root = mkdtempSync(join(tmpdir(), 'forgeax-baseline-literal-'));
    try {
      mkdirSync(join(root, 'scripts/ai-native'), { recursive: true });
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, 'scripts/ai-native/scanner-config.json'), `${JSON.stringify({
        series: state.currentBaselineId.split('-')[0],
        baseline_id: state.currentBaselineId,
        scanner_version: state.scannerVersion,
        previous_baseline_id: state.previousBaselineId,
      })}\n`);
      writeFileSync(
        join(root, 'scripts/ai-native/unapproved-baseline.ts'),
        `export const duplicatedBaseline = ${JSON.stringify(state.currentBaselineId)};\n`,
      );
      writeFileSync(join(root, 'package.json'), '{}\n');
      expect(() => requireNoCurrentBaselineLiterals(root)).toThrow(/unapproved-baseline\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
