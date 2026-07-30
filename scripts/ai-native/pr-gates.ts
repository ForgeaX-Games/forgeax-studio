#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCurrentBaselineState } from './baseline-state.ts';
import { parseEffectAdjudication } from './effect-adjudication.schema.ts';
import {
  buildInventory,
  loadScannerLifecycleConfig,
} from './scanner.ts';

/** The sole blocking gate protects migrated capabilities from regression.
 * Everything else is reported through `--report queue`. */
export type PrGate = 'migrated-regression';

export interface ManualIdentity {
  manual_id: string;
}

export interface ManualAdjudicationIdentity {
  pool_manual_id: string;
}

export interface EdgeIdentity {
  control_id: string;
  effect_id: string;
}

export interface EffectDecision {
  effect_id: string;
  disposition: string;
}

export interface MigratedEffect {
  effect_id: string;
  /** Only `action` and `tool` are read; the rest of the live row rides along. */
  agent_equiv?: Readonly<Record<string, unknown>>;
}

const EFFECT_ID_RE = /^[a-z0-9_]+(?:[.:_-][a-z0-9_]+)+$/;
const EVIDENCE_MANIFEST_DIRECTORY = 'scripts/ai-native/evidence-manifests-v1';
const EFFECT_ADJUDICATIONS_PATH = 'scripts/ai-native/effect-adjudications-v1.jsonl';
const MANUAL_ADJUDICATIONS_PATH = 'scripts/ai-native/manual-pool-adjudications-v1.jsonl';

function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`${label} contains duplicate identities`);
  return result;
}

export function unadjudicatedManualEntries(
  live: readonly ManualIdentity[],
  adjudications: readonly ManualAdjudicationIdentity[],
): string[] {
  const adjudicated = unique(adjudications.map((row) => row.pool_manual_id), 'manual adjudications');
  return [...new Set(live.map((row) => row.manual_id).filter((id) => !adjudicated.has(id)))].sort();
}

export function unadjudicatedEffects(
  liveEdges: readonly EdgeIdentity[],
  decisions: readonly EffectDecision[],
): string[] {
  const adjudicated = unique(decisions.map((row) => row.effect_id), 'effect decisions');
  return [...new Set(liveEdges.map((edge) => edge.effect_id).filter((id) => !adjudicated.has(id)))].sort();
}

/** A capability counts as migrated once it owns an evidence manifest at the
 * merge base, so a change cannot erase the set that checks its own regression. */
export function migratedEffectIds(root: string, ref: string): string[] {
  const listed = git(root, ['ls-tree', '-r', '--name-only', ref, '--', `${EVIDENCE_MANIFEST_DIRECTORY}/`]);
  if (listed.code !== 0) throw new Error(`cannot read migrated capabilities at ${ref}`);
  const prefix = `${EVIDENCE_MANIFEST_DIRECTORY}/`;
  return listed.stdout.split(/\r?\n/)
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && path.endsWith('.json'))
    .map((path) => path.slice(prefix.length, -'.json'.length))
    .sort();
}

export function migratedRegressions(
  migrated: readonly string[],
  liveEffects: readonly MigratedEffect[],
): Array<{ effect_id: string; reason: string }> {
  const byId = new Map(liveEffects.map((row) => [row.effect_id, row]));
  return migrated.flatMap((effectId) => {
    const row = byId.get(effectId);
    if (!row) return [{ effect_id: effectId, reason: 'absent from the live scan' }];
    const equivalent = row.agent_equiv ?? {};
    return equivalent.action === undefined && equivalent.tool === undefined
      ? [{ effect_id: effectId, reason: 'lost its agent equivalent' }]
      : [];
  });
}

/** Every adjudication that vanished between the base and HEAD. Reported in
 * full: an opt-out list would let a deletion disappear from the report that
 * exists to show deletions. */
export function droppedAdjudications(
  baseIds: readonly string[],
  headIds: readonly string[],
): string[] {
  const head = new Set(headIds);
  return [...new Set(baseIds)]
    .filter((id) => !head.has(id))
    .sort();
}

function jsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch (error) {
      throw new Error(
        `${path}:${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function decisions(root: string): EffectDecision[] {
  return jsonLines<unknown>(join(root, EFFECT_ADJUDICATIONS_PATH))
    .map((value, index) => {
      try {
        return parseEffectAdjudication(value);
      } catch (error) {
        throw new Error(
          `effect adjudication ${index + 1} is invalid: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}



function format(values: readonly unknown[]): string {
  return values.slice(0, 10).map((value) => JSON.stringify(value)).join(', ');
}

function git(root: string, args: string[]): { code: number; stdout: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
}

/** Resolved from the environment first so CI can hand over the ref it already
 * knows. A base that cannot be resolved is an error, never a silent skip --
 * otherwise faking FORGEAX_GATE_BASE disables the gate. */
export class UnevaluableError extends Error {}

/** Refs the protected set is read from. The trunk is mandatory: it is the only
 * floor the environment cannot lower. An earlier version fell back to the
 * caller-supplied base when origin/main was missing -- a shallow checkout plus
 * an old FORGEAX_GATE_BASE then shrank the set and the gate passed while
 * protecting nothing. Missing trunk is now unevaluable, not permissive. */
export function resolveMigrationRefs(root: string, env = process.env): string[] {
  const trunk = git(root, ['rev-parse', '--verify', 'origin/main^{commit}']);
  if (trunk.code !== 0 || !trunk.stdout) {
    throw new UnevaluableError(
      'origin/main does not resolve, so the protected set has no floor '
      + '(fetch the trunk ref: git fetch origin main)',
    );
  }
  const refs = [trunk.stdout];
  const base = resolveGateBase(root, env);
  if (!refs.includes(base)) refs.push(base);
  return refs;
}

export function resolveGateBase(root: string, env = process.env): string {
  const declared = env.FORGEAX_GATE_BASE?.trim();
  if (declared) {
    const verified = git(root, ['rev-parse', '--verify', `${declared}^{commit}`]);
    if (verified.code !== 0) {
      throw new UnevaluableError(`declared FORGEAX_GATE_BASE does not resolve: ${declared}`);
    }
    const ancestor = git(root, ['merge-base', '--is-ancestor', verified.stdout, 'HEAD']);
    if (ancestor.code !== 0) {
      throw new UnevaluableError(
        `declared FORGEAX_GATE_BASE is not an ancestor of HEAD: ${declared}`,
      );
    }
    return verified.stdout;
  }
  const merged = git(root, ['merge-base', 'origin/main', 'HEAD']);
  if (merged.code !== 0 || !merged.stdout) {
    throw new UnevaluableError('no resolvable merge base against origin/main');
  }
  return merged.stdout;
}

function idsAtRef(root: string, ref: string, path: string, field: string): string[] {
  const shown = git(root, ['show', `${ref}:${path}`]);
  if (shown.code !== 0) return [];
  return shown.stdout.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    const value = JSON.parse(line) as Record<string, unknown>;
    const id = value[field];
    return typeof id === 'string' ? [id] : [];
  });
}

function idsInWorkingTree(root: string, path: string, field: string): string[] {
  return jsonLines<Record<string, unknown>>(join(root, path))
    .flatMap((row) => (typeof row[field] === 'string' ? [row[field] as string] : []));
}

async function liveInventory(root: string) {
  const scannerConfig = loadScannerLifecycleConfig(root);
  return buildInventory({
    root,
    baselineDate: scannerConfig.currentBaselineDate,
    // The live tree is the truth the gate and the queue judge against; the
    // frozen pin under-reported a platform-io advance when it was trusted here.
    scannerConfig: { ...scannerConfig, productPinSource: 'live' },
    noGit: false,
    humanReviewDrift: 'record',
  });
}

export async function runMigratedRegression(root: string): Promise<void> {
  let migrated: string[];
  let inventory: Awaited<ReturnType<typeof liveInventory>>;
  try {
    const refs = resolveMigrationRefs(root);
    migrated = [...new Set(refs.flatMap((ref) => migratedEffectIds(root, ref)))].sort();
    inventory = await liveInventory(root);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ');
    throw new UnevaluableError(
      `cannot evaluate: ${message} -- fix the evaluation environment `
      + '(resolvable base, regenerated integrity domain, clean product tree); '
      + 'an unevaluated blocking gate fails closed',
    );
  }
  const lost = migratedRegressions(migrated, inventory.effects);
  if (lost.length > 0) {
    throw new Error(
      `migrated capabilities regressed (${lost.length}): `
      + format(lost.map((row) => `${row.effect_id} ${row.reason}`)),
    );
  }
  process.stdout.write(`[pr-gate:migrated-regression] PASS migrated=${migrated.length}\n`);
}

export async function runQueueReport(root: string): Promise<void> {
  const errors: string[] = [];
  try {
    let state: ReturnType<typeof loadCurrentBaselineState> | undefined;
    let inventory: Awaited<ReturnType<typeof liveInventory>> | undefined;
    let manualAdjudications: ManualAdjudicationIdentity[] | undefined;
    let effectDecisions: EffectDecision[] | undefined;
    let migratedCount: number | undefined;
    let dropped: string[] = [];
    try {
      state = loadCurrentBaselineState(root);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      inventory = await liveInventory(root);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      manualAdjudications = jsonLines<ManualAdjudicationIdentity>(join(root, MANUAL_ADJUDICATIONS_PATH));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      effectDecisions = decisions(root);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const directory = join(root, EVIDENCE_MANIFEST_DIRECTORY);
      migratedCount = existsSync(directory)
        ? readdirSync(directory).filter((name) => name.endsWith('.json')).length
        : 0;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const base = resolveGateBase(root);
      dropped = [
          ...droppedAdjudications(
            idsAtRef(root, base, EFFECT_ADJUDICATIONS_PATH, 'effect_id'),
            idsInWorkingTree(root, EFFECT_ADJUDICATIONS_PATH, 'effect_id'),
          ),
          ...droppedAdjudications(
            idsAtRef(root, base, MANUAL_ADJUDICATIONS_PATH, 'pool_manual_id'),
            idsInWorkingTree(root, MANUAL_ADJUDICATIONS_PATH, 'pool_manual_id'),
          ),
        ].sort();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    process.stdout.write(`${JSON.stringify({
      pending_human_review: [...(inventory?.pendingHumanReview ?? [])].sort(),
      dropped_adjudications: dropped,
      ...(inventory && manualAdjudications
        ? { unadjudicated_manual: unadjudicatedManualEntries(inventory.manualPool, manualAdjudications) }
        : {}),
      ...(inventory && effectDecisions
        ? { unadjudicated_effects: unadjudicatedEffects(inventory.edges, effectDecisions) }
        : {}),
      ...(migratedCount === undefined ? {} : { migrated_count: migratedCount }),
      ...(state === undefined ? {} : { generated_from: state.currentBaselineId }),
      errors,
    })}\n`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    process.stdout.write(`${JSON.stringify({ pending_human_review: [], dropped_adjudications: [], errors })}\n`);
  }
}

const GATES: PrGate[] = ['migrated-regression'];

export function parseInvocation(argv: string[]): { kind: 'gate'; gate: PrGate } | { kind: 'report' } {
  if (argv.length === 2 && argv[0] === '--gate' && GATES.includes(argv[1] as PrGate)) {
    return { kind: 'gate', gate: argv[1] as PrGate };
  }
  if (argv.length === 2 && argv[0] === '--report' && argv[1] === 'queue') return { kind: 'report' };
  throw new Error(`usage: pr-gates.ts --gate (${GATES.join('|')}) | --report queue`);
}

async function run(argv: string[], root: string): Promise<void> {
  const invocation = parseInvocation(argv);
  if (invocation.kind === 'report') return runQueueReport(root);
  return runMigratedRegression(root);
}

if (import.meta.main) {
  run(process.argv.slice(2), resolve(import.meta.dir, '../..')).catch((error) => {
    console.error(`[pr-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UnevaluableError ? 2 : 1);
  });
}
