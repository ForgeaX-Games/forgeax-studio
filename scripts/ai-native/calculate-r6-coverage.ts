#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildActionCatalog,
  catalogAll,
} from '../../packages/orchestrator/src/kernel/action-catalog';
import { listBuiltinHeadlessUiActionIds } from '../../packages/orchestrator/src/kernel/ui-headless-actions';
import { buildInventory } from './scanner';
import {
  calculateRepositoryR6Coverage,
  type R6CoverageResult,
} from './r6-coverage';
import { loadCurrentBaselineState } from './baseline-state.ts';

interface Options {
  json?: string;
  markdown?: string;
}

function args(argv: string[]): Options {
  const out: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json' || arg === '--markdown') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      out[arg === '--json' ? 'json' : 'markdown'] = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/ai-native/calculate-r6-coverage.ts [--json PATH] [--markdown PATH]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function testParts(testId: string): { file: string; title: string } {
  const split = testId.indexOf('#');
  if (split <= 0 || split === testId.length - 1) throw new Error(`invalid test id: ${testId}`);
  return { file: testId.slice(0, split), title: testId.slice(split + 1) };
}

export function renderR6CoverageMarkdown(result: R6CoverageResult): string {
  const excluded = Object.entries(result.exclusion_disclosure.excluded_effects_by_disposition)
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');
  const domains = result.domains.map((row) =>
    `| ${row.domain} | ${row.migrated} | ${row.denominator} | ${row.tool} | ${row.read} | ${row.coverage_percent.toFixed(2)}% |`,
  ).join('\n');
  const evaluations = result.evaluations.map((row) =>
    `| ${row.effect_id} | ${row.agent_equiv} | ${row.status} | ${row.manifest_id ?? '—'} | ${row.reasons.join('; ') || '—'} |`,
  ).join('\n');
  const draftNotice = result.result_status === 'draft'
    ? '> [!CAUTION]\n> **DRAFT / PRECOMPUTATION ONLY.** The baseline approval is pending; these numbers are not a final M2 conclusion.\n\n'
    : '';
  return `${draftNotice}> Coverage tier: **${result.coverage_tier}**. Result status: **${result.result_status}**. ` +
    `Baseline approval: **${result.baseline_approval}**; baseline bytes: \`${result.baseline_bytes_sha256}\`. ` +
    `Governance reasons: ${result.governance_reason_codes.join(', ') || 'none'}. ` +
    `Exclusions: ${excluded}; included=tool+read; baseline_id=${result.baseline_id}\n\n` +
    `# R6 migration coverage\n\n` +
    `Main coverage: **${result.numerator}/${result.denominator} (${result.coverage_percent.toFixed(2)}%)**. ` +
    `Only calculator-derived \`status=migrated\` rows enter this numerator.\n\n` +
    `Control-entry rescan: **${result.control_entry_rescan.controls} controls / ${result.control_entry_rescan.edges} edges**, ` +
    `provenance: \`${result.control_entry_rescan.provenance}\`.\n\n` +
    `## Coverage by domain\n\n` +
    `| Domain | Migrated | Denominator | Tool | Read | Coverage |\n|:--|--:|--:|--:|--:|--:|\n${domains}\n\n` +
    `## Independent equivalence observation\n\n` +
    `| Population | Verified | Declared | None |\n|:--|--:|--:|--:|\n` +
    `| All ${result.equivalence_all_effects.verified + result.equivalence_all_effects.declared + result.equivalence_all_effects.none} adjudicated effects | ${result.equivalence_all_effects.verified} | ${result.equivalence_all_effects.declared} | ${result.equivalence_all_effects.none} |\n` +
    `| ${result.denominator} denominator effects | ${result.equivalence.verified} | ${result.equivalence.declared} | ${result.equivalence.none} |\n\n` +
    `## Effect decisions\n\n` +
    `| Effect | Effective agent equivalence | Derived status | Manifest | Fail-closed reasons |\n|:--|:--|:--|:--|:--|\n${evaluations}\n`;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const root = resolve(import.meta.dir, '../..');
  const baselineState = loadCurrentBaselineState(root);
  buildActionCatalog();
  const currentInventory = await buildInventory({
    root,
    baselineDate: baselineState.baselineDate,
    noGit: true,
  });
  const result = await calculateRepositoryR6Coverage(root, {
    catalogEntries: catalogAll(),
    handlerIds: [...listBuiltinHeadlessUiActionIds()],
    currentInventory: {
      baselineId: currentInventory.baselineId,
      controls: currentInventory.controls,
      edges: currentInventory.edges,
      effects: currentInventory.effects,
      productCombo: (currentInventory.meta.scanned_product_combo ?? undefined) as Record<string, string> | undefined,
    },
    runTest: async (testId) => {
      const { file, title } = testParts(testId);
      const child = spawnSync(process.execPath, ['test', file, '--test-name-pattern', title], {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
      });
      const command = `${process.execPath} test ${file} --test-name-pattern ${JSON.stringify(title)}`;
      const output = [
        `test_id=${testId}`,
        `command=${command}`,
        `exit_status=${child.status ?? 'null'}`,
        `signal=${child.signal ?? 'none'}`,
        `spawn_error=${child.error?.message ?? 'none'}`,
        `${child.stdout ?? ''}${child.stderr ?? ''}`,
      ].join('\n');
      return {
        ok: child.status === 0 && /\b1 pass\b/.test(output) && !output.includes('matched 0 tests'),
        output,
      };
    },
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderR6CoverageMarkdown(result);
  if (options.json) write(resolve(options.json), json);
  if (options.markdown) write(resolve(options.markdown), markdown);
  if (!options.json && !options.markdown) console.log(json.trimEnd());
  console.log(
    `[r6-coverage] ${result.numerator}/${result.denominator} (${result.coverage_percent.toFixed(2)}%); ` +
    `tier=${result.coverage_tier}; migrated=${result.migrated_effect_ids.join(',') || 'none'}; ` +
    `tests=${result.test_runs.filter((run) => run.ok).length}/${result.test_runs.length}`,
  );
  if (result.evaluations.some((row) => row.manifest_id !== null && row.status !== 'migrated')) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[r6-coverage] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
