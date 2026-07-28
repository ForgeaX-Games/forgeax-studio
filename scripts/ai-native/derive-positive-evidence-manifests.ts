#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCurrentBaselineState } from './baseline-state.ts';
import { parseEvidenceManifest } from './evidence-manifest.schema.ts';

const ROOT = resolve(import.meta.dir, '../..');

interface Control {
  control_id: string;
  file: string;
  evidence_line: number;
}

interface Edge {
  control_id: string;
  effect_id: string;
  evidence_line: number;
}

interface FormalReport {
  reproduction_key_sha256: string;
  child_processes: Array<{ index: number; stderr_sha256: string }>;
}

function text(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function json<T>(path: string): T {
  return JSON.parse(text(path)) as T;
}

function jsonl<T>(path: string): T[] {
  const value = text(path).trim();
  return value ? value.split('\n').map((line) => JSON.parse(line) as T) : [];
}

function uniqueLine(path: string, needle: string): number {
  const matches = text(path).split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((row) => row.line.includes(needle));
  if (matches.length !== 1) {
    throw new Error(`expected one source anchor for ${JSON.stringify(needle)} in ${path}, found ${matches.length}`);
  }
  return matches[0]!.number;
}

function derive(effectId: 'role.create' | 'role.list', wireName: string): Record<string, unknown> {
  const state = loadCurrentBaselineState(ROOT);
  const base = `docs/ai-native/baseline/${state.currentBaselineId}`;
  const controls = jsonl<Control>(`${base}/controls.jsonl`);
  const controlById = new Map(controls.map((control) => [control.control_id, control]));
  const edges = jsonl<Edge>(`${base}/edges.jsonl`).filter((edge) => edge.effect_id === effectId);
  if (edges.length !== 1) throw new Error(`${effectId} must have exactly one current edge, found ${edges.length}`);
  const edge = edges[0]!;
  const control = controlById.get(edge.control_id);
  if (!control) throw new Error(`${effectId} edge has no current control`);
  const formal = json<FormalReport>('scripts/ai-native/runtime-snapshot-reports/main.formal.json');
  const testTitle = 'ui_invoke creates and lists a role without a UI manifest or lease';
  const testPath = 'packages/orchestrator/test/host-authoring.test.ts';
  const handlerPath = 'packages/orchestrator/src/kernel/ui-headless-actions.ts';
  const actionLine = uniqueLine(control.file, `id: '${effectId}'`);
  const handlerLine = uniqueLine(handlerPath, `actionId: '${effectId}'`);
  const testLine = uniqueLine(testPath, `test('${testTitle}'`);
  const manifest = {
    schema_version: 1,
    manifest_id: `m2-r6-role-${effectId.split('.')[1]}`,
    baseline_id: state.currentBaselineId,
    status: 'migrated',
    mapping: {
      effect_id: effectId,
      control_ids: [control.control_id],
      handler_ids: [effectId],
      tests: [{
        test_id: `${testPath}#${testTitle}`,
        proves_effect_ids: ['role.create', 'role.list'],
      }],
    },
    equivalent: { kind: 'action', id: effectId },
    context: {
      agent_id: 'forge',
      trust_tier: 'own',
      session_id: null,
      game_slug: null,
    },
    wire_name: wireName,
    direct_call_residual: {
      status: 'none',
      evidence_refs: [
        `${base}/edges.jsonl:${edge.evidence_line} — The complete b1 effect edge set routes the only ${effectId} control through action:${effectId}.`,
        `${control.file}:${actionLine} — The current control entry is the ${effectId} ActionRegistry declaration.`,
      ],
    },
    verification_level: 'isolated-fixture-run',
    profile_id: 'main',
    reproduction_key_sha256: formal.reproduction_key_sha256,
    formal_capture: {
      child_stderr_sha256: formal.child_processes.map((child) => ({
        index: child.index,
        sha256: child.stderr_sha256,
      })),
    },
    tool_source: 'catalog-firstclass',
    qualifies_for_verified_equivalence: true,
    evidence_refs: [
      `${handlerPath}:${handlerLine} — The builtin headless registry reaches the ${effectId} HostAuthoring handler.`,
      `${testPath}:${testLine} — The isolated cold-start test creates and lists a role without a UI lease.`,
    ],
  };
  parseEvidenceManifest(manifest);
  return manifest;
}

function outputs(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [effectId, wireName] of [
    ['role.create', 'ui_act_role_create'],
    ['role.list', 'ui_act_role_list'],
  ] as const) {
    const manifest = derive(effectId, wireName);
    const path = resolve(ROOT, 'scripts/ai-native/evidence-manifests-v1', `${effectId}.json`);
    result.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return result;
}

function main(argv: string[]): void {
  const mode = argv[0] ?? '--write';
  if (argv.length > 1 || !['--write', '--check'].includes(mode)) {
    throw new Error('usage: derive-positive-evidence-manifests.ts [--write|--check]');
  }
  for (const [path, expected] of outputs()) {
    if (mode === '--write') writeFileSync(path, expected);
    else if (readFileSync(path, 'utf8') !== expected) {
      throw new Error(`positive evidence manifest is stale: ${path.slice(ROOT.length + 1)}`);
    }
  }
  process.stdout.write(`[positive-evidence] ${mode === '--write' ? 'WROTE' : 'PASS'} role.create,role.list from current frozen/runtime artifacts\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[positive-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
