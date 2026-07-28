#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { knownCallBindingSpecifications } from './scanner';
import { loadCurrentBaselineState } from './baseline-state.ts';

export interface KnownCallAuditControl {
  control_id: string;
  file: string;
  evidence_line: number;
}

export interface KnownCallAuditEdge {
  control_id: string;
  effect_id: string;
  via: string[];
  evidence_line: number;
}

export function buildKnownCallAuditRows(
  baselineId: string,
  controls: KnownCallAuditControl[],
  edges: KnownCallAuditEdge[],
  specs = knownCallBindingSpecifications(),
): Array<Record<string, unknown>> {
  const controlById = new Map(controls.map((control) => [control.control_id, control]));
  return edges
    .filter((edge) => edge.via.some((via) => via.includes('product-call:') || via.includes('owned-boundary:')))
    .map((edge) => {
      const symbols = [...new Set(edge.via.flatMap((via) => {
        const product = [...via.matchAll(/product-call:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
        const owned = [...via.matchAll(/owned-boundary:([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/g)].map((match) => match[1]!);
        return [...product, ...owned];
      }))].sort();
      if (symbols.length === 0) throw new Error(`known-call edge has no symbol: ${edge.control_id}/${edge.effect_id}`);
      const bindings = symbols.map((symbol) => {
        const binding = specs[symbol];
        if (!binding) throw new Error(`known-call edge has no binding specification: ${symbol}`);
        return { symbol, ...binding };
      });
      const control = controlById.get(edge.control_id);
      if (!control) throw new Error(`known-call edge has no control: ${edge.control_id}`);
      return {
        schema_version: 1,
        baseline_id: baselineId,
        control_id: edge.control_id,
        effect_id: edge.effect_id,
        source_location: { file: control.file, line: edge.evidence_line },
        via: edge.via,
        bindings,
        verdict: 'symbol-bound',
      };
    });
}

export function renderKnownCallAudit(rows: Array<Record<string, unknown>>): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function jsonl<T>(base: string, name: string): T[] {
  const text = readFileSync(join(base, name), 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as T) : [];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const baselineId = loadCurrentBaselineState(root).currentBaselineId;
  const base = join(root, 'docs/ai-native/baseline', baselineId);
  const rows = buildKnownCallAuditRows(
    baselineId,
    jsonl<KnownCallAuditControl>(base, 'controls.jsonl'),
    jsonl<KnownCallAuditEdge>(base, 'edges.jsonl'),
  );
  writeFileSync(join(base, 'known-call-symbol-audit.jsonl'), renderKnownCallAudit(rows));
  process.stdout.write(`[known-call-audit] ${rows.length} symbol-bound baseline edges\n`);
}
