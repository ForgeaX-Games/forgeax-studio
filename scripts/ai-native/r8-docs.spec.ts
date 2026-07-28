import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLedgerV1Row } from './ledger-v1.schema';
import { renderExemptionList } from './render-exemption-list';
import { loadCurrentBaselineState } from './baseline-state.ts';

const ROOT = resolve(import.meta.dir, '../..');
const ledger = readFileSync(resolve(import.meta.dir, 'ledger-v1.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => parseLedgerV1Row(JSON.parse(line)));

describe('R8.5 derived acceptance lists', () => {
  it('keeps the external exemption projection fully derivable from the ledger', () => {
    const rendered = renderExemptionList(ledger);
    const excluded = ledger.filter((row) => row.disposition === 'view-opt' || row.disposition.startsWith('exempt:'));
    expect(excluded.length).toBeGreaterThan(0);
    for (const row of excluded) {
      expect(rendered.match(new RegExp(row.control_id, 'g'))).toHaveLength(1);
      expect(rendered).toContain(row.evidence.split(' — ')[0]);
    }
  });

  it('pins every other-team owner, b1 scale, harness report path, and denominator exclusion', () => {
    const ownership = readFileSync(resolve(ROOT, 'docs/ai-native/other-team-gap-ownership.md'), 'utf8');
    const baselineId = loadCurrentBaselineState(ROOT).currentBaselineId;
    const inventory = readFileSync(
      resolve(ROOT, 'docs/ai-native/baseline', baselineId, 'other-team-surface.md'),
      'utf8',
    );
    for (const [repo, owner] of [
      ['editor', 'ForgeaX-Games/forgeax-editor'],
      ['marketplace', 'ForgeaX-Games/forgeax-marketplace'],
      ['platform-io', 'ForgeaX-Games/forgeax-platform-io'],
      ['settings', 'ForgeaX-Games/forgeax-settings'],
      ['workbench', 'ForgeaX-Games/forgeax-workbench'],
      ['dashboard', 'ForgeaX-Games/forgeax-dashboard'],
    ] as const) {
      const match = new RegExp(`^\\| ${repo} \\| ${owner.replaceAll('/', '\\/')} \\| (\\d+) \\| (\\d+) \\|$`, 'm').exec(inventory);
      expect(match, `${repo} frozen scale row`).not.toBeNull();
      const controls = Number(match![1]);
      const files = Number(match![2]);
      expect(ownership).toContain(`| \`packages/${repo}\` | \`${owner}\` | ${controls} | ${files} |`);
      expect(ownership).toContain(`packages/${repo}/.forgeax-harness/feedbacks/{YYYY-MM-DD}-{ascii-slug}.md`);
    }
    expect(ownership).toContain('do not enter the migration denominator');
    expect(ownership).not.toMatch(/do not enter the \d+-effect migration denominator/);
  });
});
