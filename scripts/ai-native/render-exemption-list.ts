#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLedgerV1Row, type LedgerV1Row } from './ledger-v1.schema';
import { loadCurrentBaselineState } from './baseline-state.ts';

const GROUP_ORDER = [
  'view-opt',
  'exempt:human-input',
  'exempt:inbound-sink',
  'exempt:editor-injected',
  'exempt:other-team',
] as const;

function evidenceParts(evidence: string): { pointer: string; basis: string } {
  const split = evidence.indexOf(' — ');
  if (split < 0) throw new Error(`invalid ledger evidence: ${evidence}`);
  return { pointer: evidence.slice(0, split), basis: evidence.slice(split + 3) };
}

export function renderExemptionList(rows: LedgerV1Row[]): string {
  const baselineId = loadCurrentBaselineState(resolve(import.meta.dir, '../..')).currentBaselineId;
  const excluded = rows.filter((row) => row.disposition === 'view-opt' || row.disposition.startsWith('exempt:'));
  const summaryRows = GROUP_ORDER.map((reason) =>
    `| \`${reason}\` | ${excluded.filter((row) => row.disposition === reason).length} |`,
  ).join('\n');
  const sections = GROUP_ORDER.map((reason) => {
    const group = excluded
      .filter((row) => row.disposition === reason)
      .sort((left, right) => left.evidence.localeCompare(right.evidence) || left.control_id.localeCompare(right.control_id));
    const table = group.map((row) => {
      const evidence = evidenceParts(row.evidence);
      return `| \`${row.control_id}\` | \`${row.effect_id}\` | \`${row.surface}\` | \`${row.owner}\` | \`${evidence.pointer}\` | ${evidence.basis.replaceAll('|', '&#124;')} |`;
    }).join('\n');
    return `<details>\n<summary><code>${reason}</code> — ${group.length} controls</summary>\n\n` +
      `| Control | Effect | Surface | Owner | file:line | Reviewed basis |\n` +
      `|:--|:--|:--|:--|:--|:--|\n${table}\n\n</details>`;
  }).join('\n\n');
  return `# Exemption list v1\n\n` +
    `Baseline: \`${baselineId}\`. Source: \`scripts/ai-native/ledger-v1.jsonl\`.\n\n` +
    `> [!IMPORTANT]\n` +
    `> This document is derived from the strict ledger. It contains every ledger\n` +
    `> row whose disposition is \`view-opt\` or an \`exempt:*\` reason code. It is\n` +
    `> acceptance-sampling material, not a second editable classification source.\n\n` +
    `## Counts by reason code\n\n` +
    `| Reason code | Controls |\n|:--|--:|\n${summaryRows}\n` +
    `| **Total** | **${excluded.length}** |\n\n` +
    `## Complete entries\n\n${sections}\n`;
}

function main(): void {
  const root = resolve(import.meta.dir, '../..');
  const rows = readFileSync(resolve(import.meta.dir, 'ledger-v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => parseLedgerV1Row(JSON.parse(line)));
  const target = resolve(root, 'docs/ai-native/exemption-list-v1.md');
  writeFileSync(target, renderExemptionList(rows));
  console.log(`[ai-native] wrote ${target}`);
}

if (import.meta.main) main();
