import { createHash } from 'node:crypto';
import { z } from 'zod';

const controlId = z.string().regex(/^ctl_[0-9a-f]{24}$/);
export const CAPABILITY_RATCHET_GENESIS_PATH =
  'scripts/ai-native/capability-baseline-history/b1-2026-07-23-0.6.1-r1.json';
export const CAPABILITY_RATCHET_GENESIS_SHA256 =
  'ce6895e0d5678c26bc3d01511b7f1fb6edee09a775caad2dcac35df3115dfbea';
const ratchetBaselineSchema = z.object({
  schema_version: z.literal(1),
  baseline_id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  invariant: z.string().trim().min(1),
  previous_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  control_count: z.number().int().nonnegative(),
  unmigrated_control_ids: z.array(controlId),
}).strict();

export type CapabilityRatchetBaseline = z.infer<typeof ratchetBaselineSchema>;

export interface CapabilityRatchetInput {
  active: unknown;
  previous: unknown;
  genesis: unknown;
  history?: unknown[];
  sourceControlIds: string[];
  previousSourceControlIds: string[];
  calculatorMigratedControlIds: string[];
  recordedSeedSha256: string;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateCapabilityRatchetHistoryAnchor(
  genesisValue: unknown,
  previousValue: unknown,
  historyValues: unknown[] = [],
): { genesis: CapabilityRatchetBaseline; previous: CapabilityRatchetBaseline } {
  const genesis = ratchetBaselineSchema.parse(genesisValue);
  const previous = ratchetBaselineSchema.parse(previousValue);
  const genesisSha = sha256(`${JSON.stringify(genesis, null, 2)}\n`);
  if (genesisSha !== CAPABILITY_RATCHET_GENESIS_SHA256) {
    throw new Error(
      `independent capability ratchet genesis SHA mismatch: `
      + `expected=${CAPABILITY_RATCHET_GENESIS_SHA256} actual=${genesisSha}`,
    );
  }
  let parent = genesis;
  const seen = new Set([genesis.baseline_id]);
  for (const [index, value] of [...historyValues, previousValue].entries()) {
    const child = ratchetBaselineSchema.parse(value);
    if (seen.has(child.baseline_id)) {
      throw new Error(`duplicate capability ratchet history baseline: ${child.baseline_id}`);
    }
    const parentSha = sha256(`${JSON.stringify(parent, null, 2)}\n`);
    if (child.previous_sha256 !== parentSha) {
      throw new Error(
        `capability ratchet history link mismatch at index ${index}: `
        + `baseline=${child.baseline_id} expected=${parentSha} actual=${child.previous_sha256}`,
      );
    }
    seen.add(child.baseline_id);
    parent = child;
  }
  if (parent.baseline_id !== previous.baseline_id) {
    throw new Error('capability ratchet history does not terminate at the previous baseline');
  }
  return { genesis, previous };
}

export function validateCapabilityRatchet(input: CapabilityRatchetInput): CapabilityRatchetBaseline {
  const active = ratchetBaselineSchema.parse(input.active);
  const { previous } = validateCapabilityRatchetHistoryAnchor(
    input.genesis,
    input.previous,
    input.history,
  );
  const sourceIds = sorted(input.sourceControlIds);
  const previousSourceIds = sorted(input.previousSourceControlIds);
  const sourceSet = new Set(sourceIds);
  const previousSourceSet = new Set(previousSourceIds);
  const currentIds = sorted(active.unmigrated_control_ids);
  const currentSet = new Set(currentIds);
  const previousIds = sorted(previous.unmigrated_control_ids);
  const previousSet = new Set(previousIds);
  const migratedIds = sorted(input.calculatorMigratedControlIds);

  if (sourceSet.size !== sourceIds.length) throw new Error('source baseline contains duplicate controls');
  if (previousSourceSet.size !== previousSourceIds.length) throw new Error('previous source baseline contains duplicate controls');
  if (currentSet.size !== currentIds.length) throw new Error('capability baseline contains duplicate controls');
  if (previousSet.size !== previousIds.length) throw new Error('previous capability baseline contains duplicate controls');
  if (new Set(migratedIds).size !== migratedIds.length) throw new Error('calculator returned duplicate migrated controls');
  if (active.control_count !== currentIds.length) throw new Error('capability baseline control_count is stale');
  if (previous.control_count !== previousIds.length) throw new Error('previous capability baseline control_count is stale');
  if (active.baseline_id === previous.baseline_id) throw new Error('capability ratchet must advance the baseline id');
  if (!active.source.includes(active.baseline_id)) throw new Error('active capability source disagrees with baseline id');
  if (!previous.source.includes(previous.baseline_id)) throw new Error('previous capability source disagrees with baseline id');

  for (const id of currentIds) {
    if (!sourceSet.has(id)) throw new Error(`orphan capability baseline control: ${id}`);
  }
  for (const id of migratedIds) {
    if (!sourceSet.has(id)) throw new Error(`calculator migrated control is outside the seed: ${id}`);
    if (!previousSourceSet.has(id)) throw new Error(`calculator migrated control is outside the previous seed: ${id}`);
  }

  const previousBytes = `${JSON.stringify(previous, null, 2)}\n`;
  const previousSha = sha256(previousBytes);
  if (previousSha !== input.recordedSeedSha256) {
    throw new Error(`recorded previous ratchet SHA mismatch: expected=${previousSha}`);
  }
  if (active.previous_sha256 !== previousSha) throw new Error('active shrink does not point to the previous ratchet SHA');

  const previousExpected = previousSourceIds.filter((id) => !new Set(migratedIds).has(id));
  if (JSON.stringify(previousIds) !== JSON.stringify(previousExpected)) {
    throw new Error('previous capability baseline is not the exact seed-minus-calculator migration shrink');
  }
  const expected = sourceIds.filter((id) => !new Set(migratedIds).has(id));
  if (JSON.stringify(currentIds) !== JSON.stringify(expected)) {
    throw new Error('capability baseline is not the exact seed-minus-calculator migration shrink');
  }
  return active;
}

export interface HeadlessDeclaration {
  id: string;
  surface?: 'ui' | 'server' | 'both';
}

export function validateDeclaredHeadlessHandlers(
  declarations: readonly HeadlessDeclaration[],
  handlerIds: readonly string[],
  grandfatherIds: readonly string[],
): void {
  const issues: string[] = [];
  const declarationCounts = new Map<string, number>();
  const declarationById = new Map<string, HeadlessDeclaration>();
  const handlerCounts = new Map<string, number>();
  const grandfatherCounts = new Map<string, number>();
  for (const declaration of declarations) {
    declarationCounts.set(declaration.id, (declarationCounts.get(declaration.id) ?? 0) + 1);
    if (!declarationById.has(declaration.id)) declarationById.set(declaration.id, declaration);
  }
  for (const id of handlerIds) handlerCounts.set(id, (handlerCounts.get(id) ?? 0) + 1);
  for (const id of grandfatherIds) grandfatherCounts.set(id, (grandfatherCounts.get(id) ?? 0) + 1);

  for (const [id, count] of handlerCounts) {
    if (count !== 1) issues.push(`duplicate handler ${JSON.stringify(id)}`);
    const declaration = declarationById.get(id);
    if (!declaration || (declaration.surface !== 'both' && declaration.surface !== 'server')) {
      issues.push(`orphan handler ${JSON.stringify(id)}`);
    }
  }
  for (const [id, count] of grandfatherCounts) {
    if (count !== 1) issues.push(`duplicate grandfather ${JSON.stringify(id)}`);
    const declaration = declarationById.get(id);
    if (!declaration || (declaration.surface !== 'both' && declaration.surface !== 'server')) {
      issues.push(`orphan grandfather ${JSON.stringify(id)}`);
    }
    if (handlerCounts.has(id)) issues.push(`grandfather has a real handler ${JSON.stringify(id)}`);
  }
  for (const declaration of declarations) {
    if ((declarationCounts.get(declaration.id) ?? 0) !== 1) {
      issues.push(`duplicate declaration ${JSON.stringify(declaration.id)}`);
    }
    if (
      (declaration.surface === 'both' || declaration.surface === 'server')
      && !handlerCounts.has(declaration.id)
      && !grandfatherCounts.has(declaration.id)
    ) {
      issues.push(`missing handler ${JSON.stringify(declaration.id)}`);
    }
  }
  if (issues.length > 0) throw new Error(`declaration-handler gate:\n- ${[...new Set(issues)].join('\n- ')}`);
}
