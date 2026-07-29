#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  classifyRootCause,
  type ReasonTag,
  type RootCauseSignals,
} from './baseline-diff-classifier.ts';
export { classifyRootCause } from './baseline-diff-classifier.ts';
export type { ReasonTag, RootCauseSignals } from './baseline-diff-classifier.ts';

export type AttributionSignalCrossCheck =
  | { status: 'performed'; reason: null }
  | { status: 'not-performed'; reason: 'baseline-metadata-domains-incomparable' };

type Control = {
  control_id: string;
  repo: string;
  effect_id: string | null;
  propagation: string;
  owner: string;
  disposition?: string;
  status?: string;
  file: string;
  evidence_line: number;
  notes: string;
};
type Edge = {
  control_id: string;
  effect_id: string;
  propagation: string;
  via: string[];
  evidence_line: number;
};
type Effect = {
  effect_id: string;
  repo: string[];
  domain: string;
  server_endpoints?: string[];
  vocab?: { setters?: string[]; commands?: string[]; actions?: string[] };
  [key: string]: unknown;
};
type Manual = {
  manual_id: string;
  control_id: string;
  file: string;
  evidence_line: number;
  [key: string]: unknown;
};
type BaselineMeta = {
  baseline_id?: string;
  previous_baseline_id?: string;
  scanner_version: string;
  baseline_note?: string;
  scanned_product_combo: Record<string, string>;
  scanner_config_sha?: string;
  scanner_configuration_sha?: string;
  scanner_domain_sha?: string;
  scanner_configuration_fingerprint?: unknown;
  identity_adjudication_sha?: string;
  alias_map_sha?: string;
  identity_adjudication_fingerprint?: unknown;
  ownership_adjudication_sha?: string;
  ownership_sha?: string;
  ownership_adjudication_fingerprint?: unknown;
};
type ChangeKind =
  | 'control-evidence-coordinate-drift'
  | 'edge-evidence-coordinate-drift'
  | 'manual-pool-evidence-coordinate-drift'
  | 'control-identity-added'
  | 'control-identity-removed'
  | 'semantic-primary-reclassification'
  | 'control-propagation-change'
  | 'control-owner-change'
  | 'control-disposition-change'
  | 'control-status-change'
  | 'symbol-reviewed-call-propagation'
  | 'local-state-call-propagation'
  | 'setter-call-propagation'
  | 'endpoint-server-call-propagation'
  | 'declarative-menu-command-propagation'
  | 'command-bus-propagation'
  | 'surface-action-propagation'
  | 'editor-callback-propagation'
  | 'dom-effect-propagation'
  | 'edge-removal'
  | 'edge-propagation-change'
  | 'edge-via-change'
  | 'edge-derived-repo-attribution'
  | 'reviewed-other-team-boundary'
  | 'effect-addition'
  | 'effect-removal'
  | 'manual-pool-addition'
  | 'manual-pool-removal'
  | 'manual-pool-identity-change';

export interface DiffRow {
  schema_version: 2;
  from_baseline_id: string;
  to_baseline_id: string;
  change_kind: ChangeKind;
  id: string;
  source_location: { file: string; line: number };
  old_value: unknown;
  new_value: unknown;
  reason_tag: ReasonTag;
  attribution_signal_cross_check: AttributionSignalCrossCheck;
  root_cause_ref: string;
  finding_id: string;
}

type RowDraft = Omit<
  DiffRow,
  'schema_version' | 'from_baseline_id' | 'to_baseline_id' | 'reason_tag'
  | 'attribution_signal_cross_check' | 'root_cause_ref'
>;

export interface BuildBaselineDiffOptions {
  repoRoot?: string;
  fromBaselineId: string;
  toBaselineId: string;
  reasonAdjudications?: Readonly<Record<string, ReasonTag>>;
}

export interface BuildBaselineDiffResult {
  rows: DiffRow[];
  notesExcluded: number;
  mechanisms: Record<string, number>;
  rootCauseSignals: RootCauseSignals | null;
  attributionSignalCrossCheck: AttributionSignalCrossCheck;
  markdown: string;
  fromScannerVersion: string;
  toScannerVersion: string;
}

function readJsonLines<T>(base: string, baselineId: string, name: string): T[] {
  const text = readFileSync(join(base, baselineId, name), 'utf8').trim();
  return text ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function edgeKey(edge: Pick<Edge, 'control_id' | 'effect_id'>): string {
  return `${edge.control_id}|${edge.effect_id}`;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function optionalDomainChanged(
  oldMeta: BaselineMeta,
  newMeta: BaselineMeta,
  keys: Array<keyof BaselineMeta>,
): boolean {
  const oldKey = keys.find((key) => Object.hasOwn(oldMeta, key));
  const newKey = keys.find((key) => Object.hasOwn(newMeta, key));
  if (oldKey === undefined || newKey === undefined) return false;
  return !same(oldMeta[oldKey], newMeta[newKey]);
}

function fingerprintDomains(meta: BaselineMeta): Array<{ domain: string; sha256: string }> | undefined {
  const fingerprint = meta.scanner_configuration_fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || !Array.isArray((fingerprint as { domains?: unknown }).domains)) {
    return undefined;
  }
  const domains = (fingerprint as { domains: unknown[] }).domains;
  if (!domains.every((item) => (
    item !== null
    && typeof item === 'object'
    && typeof (item as { domain?: unknown }).domain === 'string'
    && typeof (item as { sha256?: unknown }).sha256 === 'string'
  ))) return undefined;
  return domains.map((item) => ({
    domain: (item as { domain: string }).domain,
    sha256: (item as { sha256: string }).sha256,
  }));
}

function fingerprintDomainChanged(oldMeta: BaselineMeta, newMeta: BaselineMeta, domain: string): boolean {
  const oldValue = fingerprintDomains(oldMeta)?.find((item) => item.domain === domain)?.sha256;
  const newValue = fingerprintDomains(newMeta)?.find((item) => item.domain === domain)?.sha256;
  return oldValue !== undefined && newValue !== undefined && oldValue !== newValue;
}

function scannerRuleDomainsChanged(oldMeta: BaselineMeta, newMeta: BaselineMeta): boolean {
  const oldDomains = fingerprintDomains(oldMeta);
  const newDomains = fingerprintDomains(newMeta);
  if (!oldDomains || !newDomains) return false;
  const scannerDomains = (domains: Array<{ domain: string; sha256: string }>) => domains
    .filter((item) => item.domain !== 'identity-aliases' && item.domain !== 'ownership-adjudication')
    .sort((left, right) => left.domain.localeCompare(right.domain));
  return !same(scannerDomains(oldDomains), scannerDomains(newDomains));
}

export function deriveRootCauseSignals(oldMeta: BaselineMeta, newMeta: BaselineMeta): RootCauseSignals {
  const oldDomains = fingerprintDomains(oldMeta);
  const newDomains = fingerprintDomains(newMeta);
  if ((oldDomains === undefined) !== (newDomains === undefined)) {
    throw new Error('baseline metadata domains are incomparable; explicit per-row adjudication is required');
  }
  return {
    productBytesChanged: !same(oldMeta.scanned_product_combo, newMeta.scanned_product_combo),
    scannerConfigurationChanged: oldMeta.scanner_version !== newMeta.scanner_version || optionalDomainChanged(
      oldMeta,
      newMeta,
      ['scanner_config_sha', 'scanner_configuration_sha', 'scanner_domain_sha'],
    ) || scannerRuleDomainsChanged(oldMeta, newMeta),
    identityAdjudicationChanged: optionalDomainChanged(
      oldMeta,
      newMeta,
      ['identity_adjudication_sha', 'alias_map_sha', 'identity_adjudication_fingerprint'],
    ) || fingerprintDomainChanged(oldMeta, newMeta, 'identity-aliases'),
    ownershipAdjudicationChanged: optionalDomainChanged(
      oldMeta,
      newMeta,
      ['ownership_adjudication_sha', 'ownership_sha', 'ownership_adjudication_fingerprint'],
    ) || fingerprintDomainChanged(oldMeta, newMeta, 'ownership-adjudication'),
  };
}

function reasonAdjudicationPath(repoRoot: string, fromId: string, toId: string): string {
  return join(
    repoRoot,
    'scripts/ai-native/baseline-diff-adjudications',
    `${fromId}--${toId}.jsonl`,
  );
}

export function loadBaselineDiffReasonAdjudications(
  repoRoot: string,
  fromId: string,
  toId: string,
): Readonly<Record<string, ReasonTag>> | undefined {
  const path = reasonAdjudicationPath(repoRoot, fromId, toId);
  if (!existsSync(path)) return undefined;
  const result: Record<string, ReasonTag> = {};
  for (const [index, line] of readFileSync(path, 'utf8').trim().split('\n').entries()) {
    const row = JSON.parse(line) as { change_kind?: unknown; id?: unknown; reason_tag?: unknown };
    if (
      typeof row.change_kind !== 'string'
      || typeof row.id !== 'string'
      || !['product', 'scanner-config', 'identity', 'ownership'].includes(String(row.reason_tag))
    ) throw new Error(`invalid baseline diff reason adjudication at ${path}:${index + 1}`);
    const key = `${row.change_kind}\0${row.id}`;
    if (Object.hasOwn(result, key)) throw new Error(`duplicate baseline diff reason adjudication: ${key}`);
    result[key] = row.reason_tag as ReasonTag;
  }
  return result;
}

const KNOWN_EFFECT_ROOT_SYMBOLS: Readonly<Record<string, string>> = {
  'server.post_api_workbench_package_clean': 'cleanPackage',
  'server.delete_api_workbench_games_slug': 'deleteGame',
  'server.delete_api_workbench_package_history_id': 'deletePackageHistory',
  'server.post_api_workbench_games_slug_package': 'packageGame',
  'server.post_api_sessions_sid_rewind_overwrite_dirty': 'performOverwriteDirty',
  'server.post_api_sessions_sid_rewind': 'performRewind',
  'server.post_api_sessions_sid_rewind_cancel': 'performRewindCancel',
  'server.post_api_sessions_sid_rewind_undo_overwrite': 'performUndoOverwrite',
  'server.post_api_sessions_sid_rewind_preview': 'rewindPreview',
  'chat.post_message': 'sendMessage',
  'server.post_api_commands_name_execute': 'setAgentModels',
};

function scannerAnchorResolver(repoRoot: string): (anchor: string) => string {
  const scannerPath = 'scripts/ai-native/scanner.ts';
  const lines = readFileSync(join(repoRoot, scannerPath), 'utf8').split('\n');
  return (anchor) => {
    const matches = lines.flatMap((line, index) => line.trim() === anchor ? [index + 1] : []);
    if (matches.length !== 1) {
      throw new Error(`scanner root-cause anchor must match exactly once: ${JSON.stringify(anchor)} matched ${matches.length}`);
    }
    return `${scannerPath}:${matches[0]}`;
  };
}

function reasonRationale(reason: ReasonTag, oldMeta: BaselineMeta, newMeta: BaselineMeta): string {
  switch (reason) {
    case 'product': return 'Scanned product bytes changed.';
    case 'scanner-config': return `Scanner configuration changed (${oldMeta.scanner_version}→${newMeta.scanner_version}).`;
    case 'identity': return 'Alias or continuous-identity adjudication changed.';
    case 'ownership': return 'Explicit ownership adjudication changed.';
  }
}

export function renderDiffJsonl(rows: DiffRow[]): string {
  return rows.length === 0 ? '' : `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`;
}

export function buildBaselineDiff(options: BuildBaselineDiffOptions): BuildBaselineDiffResult {
  const root = resolve(options.repoRoot ?? resolve(import.meta.dir, '../..'));
  const base = join(root, 'docs/ai-native/baseline');
  const fromId = options.fromBaselineId;
  const toId = options.toBaselineId;
  const oldControls = readJsonLines<Control>(base, fromId, 'controls.jsonl');
  const newControls = readJsonLines<Control>(base, toId, 'controls.jsonl');
  const oldEdges = readJsonLines<Edge>(base, fromId, 'edges.jsonl');
  const newEdges = readJsonLines<Edge>(base, toId, 'edges.jsonl');
  const oldEffects = readJsonLines<Effect>(base, fromId, 'effects.jsonl');
  const newEffects = readJsonLines<Effect>(base, toId, 'effects.jsonl');
  const oldManual = readJsonLines<Manual>(base, fromId, 'manual-classification-pool.jsonl');
  const newManual = readJsonLines<Manual>(base, toId, 'manual-classification-pool.jsonl');
  const oldMeta = JSON.parse(readFileSync(join(base, fromId, 'meta.json'), 'utf8')) as BaselineMeta;
  const newMeta = JSON.parse(readFileSync(join(base, toId, 'meta.json'), 'utf8')) as BaselineMeta;
  const reasonAdjudications = options.reasonAdjudications
    ?? loadBaselineDiffReasonAdjudications(root, fromId, toId);
  let rootCauseSignals: RootCauseSignals | null;
  try {
    rootCauseSignals = deriveRootCauseSignals(oldMeta, newMeta);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('metadata domains are incomparable')) throw error;
    if (!reasonAdjudications) throw error;
    rootCauseSignals = null;
  }
  const attributionSignalCrossCheck: AttributionSignalCrossCheck = rootCauseSignals === null
    ? { status: 'not-performed', reason: 'baseline-metadata-domains-incomparable' }
    : { status: 'performed', reason: null };
  const frozenHistoricalRefs = new Map<string, string>();
  const frozenHistoricalLocations = new Map<string, { file: string; line: number }>();
  const publishedHistoricalPath = join(base, toId, `diff-from-${oldMeta.scanner_version}.jsonl`);
  const scannerMatchesRunningImplementation = readFileSync(
    join(root, 'scripts/ai-native/scanner.ts'),
    'utf8',
  ) === readFileSync(join(import.meta.dir, 'scanner.ts'), 'utf8');
  if (rootCauseSignals === null && existsSync(publishedHistoricalPath) && scannerMatchesRunningImplementation) {
    for (const row of readJsonLines<{ change_kind: string; id: string; root_cause_ref: string; source_location: { file: string; line: number } }>(
      base,
      toId,
      `diff-from-${oldMeta.scanner_version}.jsonl`,
    )) {
      const key = `${row.change_kind}\0${row.id}`;
      frozenHistoricalRefs.set(key, row.root_cause_ref);
      frozenHistoricalLocations.set(key, row.source_location);
    }
  }
  const scannerRef = scannerAnchorResolver(root);
  const scannerLocation = (anchor: string): { file: string; line: number } => {
    const ref = scannerRef(anchor);
    const match = /^(.*):(\d+)$/.exec(ref);
    if (!match) throw new Error(`scanner anchor is not a source location: ${ref}`);
    return { file: match[1]!, line: Number(match[2]) };
  };
  const auditPath = join(base, toId, 'known-call-symbol-audit.jsonl');
  const symbolAuditKeys = new Set(
    existsSync(auditPath)
      ? readJsonLines<{ control_id: string; effect_id: string }>(base, toId, 'known-call-symbol-audit.jsonl')
        .map((audit) => `${audit.control_id}|${audit.effect_id}`)
      : [],
  );
  const routeAuditPath = join(base, toId, 'other-team-route-audit.jsonl');
  const routeAuditByEffect = new Map(
    existsSync(routeAuditPath)
      ? readJsonLines<{ effect_id: string | null; source: string; source_line: number }>(base, toId, 'other-team-route-audit.jsonl')
        .filter((row): row is { effect_id: string; source: string; source_line: number } => row.effect_id !== null)
        .map((row) => [row.effect_id, row] as const)
      : [],
  );
  const promotionRegistryPath = join(root, 'scripts/ai-native/manual-pool-effect-promotions.json');
  const promotionByEffect = new Map<string, { source_control_ids: string[] }>(
    existsSync(promotionRegistryPath)
      ? (JSON.parse(readFileSync(promotionRegistryPath, 'utf8')) as {
          promotions: Array<{ effect_id: string; source_control_ids: string[] }>;
        }).promotions.map((row) => [row.effect_id, row] as const)
      : [],
  );
  const routeRegistryRef = (effectId: string): string => {
    const path = 'scripts/ai-native/other-team-route-registry.json';
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    const needle = `"effect_id": "${effectId}",`;
    const matches = lines.flatMap((line, index) => line.trim() === needle ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`other-team route effect anchor must match once: ${effectId}`);
    return `${path}:${matches[0]}`;
  };
  const promotionRegistryRef = (effectId: string): string => {
    const path = 'scripts/ai-native/manual-pool-effect-promotions.json';
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    const needle = `"effect_id": "${effectId}",`;
    const matches = lines.flatMap((line, index) => line.trim() === needle ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`manual-pool effect promotion anchor must match once: ${effectId}`);
    return `${path}:${matches[0]}`;
  };

  const oldControlById = new Map(oldControls.map((control) => [control.control_id, control]));
  const newControlById = new Map(newControls.map((control) => [control.control_id, control]));
  const oldEdgeById = new Map(oldEdges.map((edge) => [edgeKey(edge), edge]));
  const newEdgeById = new Map(newEdges.map((edge) => [edgeKey(edge), edge]));
  const oldEffectById = new Map(oldEffects.map((effect) => [effect.effect_id, effect]));
  const newEffectById = new Map(newEffects.map((effect) => [effect.effect_id, effect]));
  const oldManualById = new Map(oldManual.map((item) => [item.manual_id, item]));
  const newManualById = new Map(newManual.map((item) => [item.manual_id, item]));
  const frozenRowLocation = <T>(
    baselineId: string,
    file: string,
    rows: T[],
    row: T,
  ): { file: string; line: number } => ({
    file: `docs/ai-native/baseline/${baselineId}/${file}`,
    line: rows.indexOf(row) + 1,
  });

  const edgeCauseRef = (edge: Edge | undefined): string => {
    if (!edge) return scannerRef('const MAX_HANDLER_CALL_DEPTH = 8;');
    if (edge.effect_id === 'platform_io.project.delete') {
      return scannerRef('const COMPONENT_CALL_EFFECTS: Readonly<Record<string, KnownCallEffect>> = {};');
    }
    const knownSymbol = KNOWN_EFFECT_ROOT_SYMBOLS[edge.effect_id];
    if (knownSymbol !== undefined && edge.via.some((via) => /product-call:|callback:/.test(via))) {
      return scannerRef(`${knownSymbol}: {`);
    }
    if (edge.via.some((via) => via.includes('owned-boundary:'))) {
      return scannerRef('const COMPONENT_CALL_EFFECTS: Readonly<Record<string, KnownCallEffect>> = {};');
    }
    if (edge.via.some((via) => via.includes('menu-command:'))) {
      return scannerRef('function collectDeclarativeMenuControls(');
    }
    if (edge.via.some((via) => /^command:/.test(via))) {
      return scannerRef('function collectCommandControls(files: Map<string, ParsedFile>, commands: CommandDef[], commandMap: Map<string, string>): RawControl[] {');
    }
    if (edge.via.some((via) => via.includes('workbench:'))) {
      return scannerRef('function collectUseSurfaceControls(');
    }
    if (edge.via.some((via) => via.includes('editor-callback:') || via.includes('dom:'))) {
      return scannerRef('function analyzeHandler(');
    }
    return scannerRef('const MAX_HANDLER_CALL_DEPTH = 8;');
  };
  const scannerCauseRef = (change: RowDraft): string => {
    if (change.change_kind === 'reviewed-other-team-boundary') {
      if (routeAuditByEffect.has(change.id)) return routeRegistryRef(change.id);
      return scannerRef('const COMPONENT_CALL_EFFECTS: Readonly<Record<string, KnownCallEffect>> = {};');
    }
    if (change.change_kind === 'effect-addition') {
      if (promotionByEffect.has(change.id)) return promotionRegistryRef(change.id);
      if (((change.new_value as Effect).server_endpoints?.length ?? 0) > 0) {
        return scannerRef('function extractEndpoints(root: string): { endpoints: EndpointDef[]; manual: ManualPoolRow[] } {');
      }
      const vocab = (change.new_value as Effect).vocab;
      if ((vocab?.setters?.length ?? 0) + (vocab?.commands?.length ?? 0) + (vocab?.actions?.length ?? 0) > 0) {
        return scannerRef('function deriveVocab(');
      }
      return edgeCauseRef(newEdges.find((edge) => edge.effect_id === change.id));
    }
    if (change.change_kind === 'control-owner-change') {
      return edgeCauseRef(newEdges.find((edge) => edge.control_id === change.id && !oldEdgeById.has(edgeKey(edge))));
    }
    if (change.change_kind === 'edge-derived-repo-attribution') {
      if (routeAuditByEffect.has(change.id)) return routeRegistryRef(change.id);
      return edgeCauseRef(newEdges.find((edge) => (
        edge.effect_id === change.id
        && (!oldEdgeById.has(edgeKey(edge)) || !same(oldEdgeById.get(edgeKey(edge))?.via, edge.via))
      )));
    }
    if (
      change.change_kind === 'symbol-reviewed-call-propagation'
      || change.change_kind === 'local-state-call-propagation'
      || change.change_kind === 'setter-call-propagation'
      || change.change_kind === 'endpoint-server-call-propagation'
      || change.change_kind === 'surface-action-propagation'
      || change.change_kind === 'editor-callback-propagation'
      || change.change_kind === 'dom-effect-propagation'
    ) return edgeCauseRef(change.new_value as Edge);
    if (change.change_kind === 'edge-via-change') return edgeCauseRef(newEdgeById.get(change.id));
    const controlId = change.change_kind === 'manual-pool-removal'
      ? (change.old_value as Manual).control_id
      : change.id.includes('|') ? change.id.split('|')[0]! : change.id;
    const changedEdge = newEdges.find((edge) => (
      edge.control_id === controlId
      && (!oldEdgeById.has(edgeKey(edge)) || !same(oldEdgeById.get(edgeKey(edge))?.via, edge.via))
    ));
    return edgeCauseRef(changedEdge);
  };
  const rootCauseRef = (change: RowDraft, reason: ReasonTag): string => {
    const frozenHistoricalRef = frozenHistoricalRefs.get(`${change.change_kind}\0${change.id}`);
    if (frozenHistoricalRef) return frozenHistoricalRef;
    if (reason === 'scanner-config') return scannerCauseRef(change);
    if (reason === 'identity') return 'scripts/ai-native/alias-map.json:1';
    if (reason === 'ownership') return 'docs/ai-native/other-team-gap-ownership.md:1';
    return `${change.source_location.file}:${change.source_location.line}`;
  };
  const rows: DiffRow[] = [];
  const add = (change: RowDraft): void => {
    let reason: ReasonTag;
    if (rootCauseSignals === null) {
      const key = `${change.change_kind}\0${change.id}`;
      const adjudicatedReason = reasonAdjudications?.[key];
      if (adjudicatedReason === undefined) {
        throw new Error(
          `incomparable metadata for ${change.change_kind}/${change.id}: explicit per-row adjudication is required`,
        );
      }
      reason = adjudicatedReason;
    } else {
      try {
        reason = classifyRootCause(rootCauseSignals);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('ambiguous root causes')) throw error;
        const key = `${change.change_kind}\0${change.id}`;
        const adjudicatedReason = reasonAdjudications?.[key];
        if (adjudicatedReason === undefined) {
          throw new Error(`ambiguous root causes for ${change.change_kind}/${change.id}: explicit row adjudication is required`);
        }
        reason = classifyRootCause(rootCauseSignals, adjudicatedReason);
      }
    }
    const key = `${change.change_kind}\0${change.id}`;
    rows.push({
      schema_version: 2,
      from_baseline_id: fromId,
      to_baseline_id: toId,
      change_kind: change.change_kind,
      id: change.id,
      source_location: frozenHistoricalLocations.get(key) ?? change.source_location,
      old_value: change.old_value,
      new_value: change.new_value,
      reason_tag: reason,
      attribution_signal_cross_check: attributionSignalCrossCheck,
      finding_id: change.finding_id,
      root_cause_ref: rootCauseRef(change, reason),
    });
  };

  for (const control of newControls) {
    const old = oldControlById.get(control.control_id);
    const source_location = { file: control.file, line: control.evidence_line };
    if (!old) {
      add({ change_kind: 'control-identity-added', id: control.control_id, source_location, old_value: null, new_value: control, finding_id: 'FR5-F5-1-CONTROL-IDENTITY' });
      continue;
    }
    const fields: Array<{
      field: 'effect_id' | 'propagation' | 'owner' | 'disposition' | 'status';
      change_kind: ChangeKind;
      finding_id: string;
    }> = [
      { field: 'effect_id', change_kind: 'semantic-primary-reclassification', finding_id: 'FR5-F5-1-CONTROL-EFFECT' },
      { field: 'propagation', change_kind: 'control-propagation-change', finding_id: 'FR5-F5-1-CONTROL-PROPAGATION' },
      { field: 'owner', change_kind: 'control-owner-change', finding_id: 'FR5-F5-1-CONTROL-OWNER' },
      { field: 'disposition', change_kind: 'control-disposition-change', finding_id: 'FR5-F5-1-CONTROL-DISPOSITION' },
      { field: 'status', change_kind: 'control-status-change', finding_id: 'FR5-F5-1-CONTROL-STATUS' },
    ];
    for (const field of fields) {
      if (same(old[field.field], control[field.field])) continue;
      add({
        change_kind: field.change_kind,
        id: control.control_id,
        source_location,
        old_value: old[field.field],
        new_value: control[field.field],
        finding_id: field.finding_id,
      });
    }
    if (old.evidence_line !== control.evidence_line) {
      add({
        change_kind: 'control-evidence-coordinate-drift',
        id: control.control_id,
        source_location,
        old_value: old.evidence_line,
        new_value: control.evidence_line,
        finding_id: 'P3-CONTROL-COORDINATE-DRIFT',
      });
    }
  }
  for (const control of oldControls.filter((item) => !newControlById.has(item.control_id))) {
    add({
      change_kind: 'control-identity-removed', id: control.control_id,
      source_location: frozenRowLocation(fromId, 'controls.jsonl', oldControls, control),
      old_value: control, new_value: null, finding_id: 'FR5-F5-1-CONTROL-IDENTITY',
    });
  }

  const addedEdgeKind = (edge: Edge): ChangeKind => {
    if (symbolAuditKeys.has(edgeKey(edge))) return 'symbol-reviewed-call-propagation';
    if (edge.via.some((via) => via.includes('local-state:'))) return 'local-state-call-propagation';
    if (edge.via.some((via) => via.includes('setter:'))) return 'setter-call-propagation';
    if (edge.via.some((via) => via.includes('endpoint:'))) return 'endpoint-server-call-propagation';
    if (edge.via.some((via) => via.includes('menu-command:'))) return 'declarative-menu-command-propagation';
    if (edge.via.some((via) => /^command:/.test(via))) return 'command-bus-propagation';
    if (edge.via.some((via) => via.includes('workbench:'))) return 'surface-action-propagation';
    if (edge.via.some((via) => via.includes('editor-callback:'))) return 'editor-callback-propagation';
    if (edge.via.some((via) => via.includes('dom:'))) return 'dom-effect-propagation';
    throw new Error(`added edge has no truthful mechanism classification: ${edgeKey(edge)}`);
  };
  for (const edge of newEdges) {
    const old = oldEdgeById.get(edgeKey(edge));
    const control = newControlById.get(edge.control_id);
    if (!control) throw new Error(`edge has no control: ${edgeKey(edge)}`);
    const source_location = { file: control.file, line: edge.evidence_line };
    if (!old) {
      add({ change_kind: addedEdgeKind(edge), id: edgeKey(edge), source_location, old_value: null, new_value: edge, finding_id: 'FR5-F5-1-EDGE-ADDITION' });
      continue;
    }
    if (!same(old.propagation, edge.propagation)) {
      add({ change_kind: 'edge-propagation-change', id: edgeKey(edge), source_location, old_value: old.propagation, new_value: edge.propagation, finding_id: 'FR5-F5-1-EDGE-PROPAGATION' });
    }
    if (!same(old.via, edge.via)) {
      add({ change_kind: 'edge-via-change', id: edgeKey(edge), source_location, old_value: old.via, new_value: edge.via, finding_id: 'FR5-F5-1-EDGE-VIA' });
    }
    if (old.evidence_line !== edge.evidence_line) {
      add({
        change_kind: 'edge-evidence-coordinate-drift',
        id: edgeKey(edge),
        source_location,
        old_value: old.evidence_line,
        new_value: edge.evidence_line,
        finding_id: 'P3-EDGE-COORDINATE-DRIFT',
      });
    }
  }
  for (const edge of oldEdges.filter((item) => !newEdgeById.has(edgeKey(item)))) {
    const control = oldControlById.get(edge.control_id);
    if (!control) throw new Error(`removed edge has no old control: ${edgeKey(edge)}`);
    add({
      change_kind: 'edge-removal', id: edgeKey(edge),
      source_location: frozenRowLocation(fromId, 'edges.jsonl', oldEdges, edge),
      old_value: edge, new_value: null, finding_id: 'FR5-F5-1-EDGE-REMOVAL',
    });
  }

  const effectWitness = (
    effectId: string,
    edges: Edge[],
    controls: Map<string, Control>,
    routeAudit: ReadonlyMap<string, { source: string; source_line: number }> = new Map(),
  ) => {
    const edge = edges.find((candidate) => candidate.effect_id === effectId);
    const control = edge && controls.get(edge.control_id);
    if (!edge || !control) {
      const route = routeAudit.get(effectId);
      if (route) return { file: route.source, line: route.source_line };
      const promotion = promotionByEffect.get(effectId);
      const promotedControl = promotion && controls.get(promotion.source_control_ids[0]!);
      if (promotedControl) return { file: promotedControl.file, line: promotedControl.evidence_line };
      const endpointEffect = newEffectById.get(effectId) ?? oldEffectById.get(effectId);
      if ((endpointEffect?.server_endpoints?.length ?? 0) > 0) {
        return scannerLocation('function extractEndpoints(root: string): { endpoints: EndpointDef[]; manual: ManualPoolRow[] } {');
      }
      const vocab = endpointEffect?.vocab;
      if ((vocab?.setters?.length ?? 0) + (vocab?.commands?.length ?? 0) + (vocab?.actions?.length ?? 0) > 0) {
        return scannerLocation('function deriveVocab(');
      }
      throw new Error(`effect has no edge or registered-route witness: ${effectId}`);
    }
    return { file: control.file, line: edge.evidence_line };
  };
  for (const effect of newEffects) {
    const old = oldEffectById.get(effect.effect_id);
    if (!old) {
      add({ change_kind: routeAuditByEffect.has(effect.effect_id) || effect.effect_id.startsWith('platform_io.') ? 'reviewed-other-team-boundary' : 'effect-addition', id: effect.effect_id, source_location: effectWitness(effect.effect_id, newEdges, newControlById, routeAuditByEffect), old_value: null, new_value: effect, finding_id: 'FR5-F5-1-EFFECT-ADDITION' });
    } else if (!same(old.repo, effect.repo)) {
      add({ change_kind: 'edge-derived-repo-attribution', id: effect.effect_id, source_location: effectWitness(effect.effect_id, newEdges, newControlById, routeAuditByEffect), old_value: old.repo, new_value: effect.repo, finding_id: 'FR5-F5-1-EFFECT-OWNERSHIP' });
    }
  }
  for (const effect of oldEffects.filter((item) => !newEffectById.has(item.effect_id))) {
    add({ change_kind: 'effect-removal', id: effect.effect_id, source_location: frozenRowLocation(fromId, 'effects.jsonl', oldEffects, effect), old_value: effect, new_value: null, finding_id: 'FR5-F5-1-EFFECT-REMOVAL' });
  }

  for (const item of newManual) {
    const old = oldManualById.get(item.manual_id);
    if (!old) {
      add({ change_kind: 'manual-pool-addition', id: item.manual_id, source_location: { file: item.file, line: item.evidence_line }, old_value: null, new_value: item, finding_id: 'FR5-F5-1-MANUAL-POOL' });
    } else if (old.control_id !== item.control_id) {
      add({ change_kind: 'manual-pool-identity-change', id: item.manual_id, source_location: { file: item.file, line: item.evidence_line }, old_value: old.control_id, new_value: item.control_id, finding_id: 'FR5-F5-1-MANUAL-IDENTITY' });
    }
    if (old && old.evidence_line !== item.evidence_line) {
      add({
        change_kind: 'manual-pool-evidence-coordinate-drift',
        id: item.manual_id,
        source_location: { file: item.file, line: item.evidence_line },
        old_value: old.evidence_line,
        new_value: item.evidence_line,
        finding_id: 'P3-MANUAL-COORDINATE-DRIFT',
      });
    }
  }
  for (const item of oldManual.filter((candidate) => !newManualById.has(candidate.manual_id))) {
    add({ change_kind: 'manual-pool-removal', id: item.manual_id, source_location: frozenRowLocation(fromId, 'manual-classification-pool.jsonl', oldManual, item), old_value: item, new_value: null, finding_id: 'FR5-F5-1-MANUAL-POOL' });
  }

  const notesExcluded = newControls.filter((control) => {
    const old = oldControlById.get(control.control_id);
    return old && old.notes !== control.notes;
  }).length;
  const mechanisms = Object.fromEntries(
    [...rows.reduce((map, item) => map.set(item.change_kind, (map.get(item.change_kind) ?? 0) + 1), new Map<string, number>())]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const summaryRows = Object.entries(mechanisms).map(([kind, count]) => {
    const reasons = [...new Set(rows.filter((item) => item.change_kind === kind).map((item) => item.reason_tag))].join(', ');
    const sample = rows.find((item) => item.change_kind === kind)!;
    return `| \`${kind}\` | ${count} | \`${reasons}\` | \`${sample.finding_id}\` |`;
  }).join('\n');
  const adjudicationRows = rows.map((item, index) => (
    `| ${index + 1} | \`${item.change_kind}\` | \`${item.id}\` | \`${item.reason_tag}\` | \`${item.root_cause_ref}\` | ${reasonRationale(item.reason_tag, oldMeta, newMeta)} |`
  )).join('\n');
  const crossCheckNotice = attributionSignalCrossCheck.status === 'performed'
    ? `> [!NOTE]\n> **Independent attribution signal cross-check: PERFORMED.** Both baselines expose comparable scanner-configuration fingerprint domains, so every claimed \`reason_tag\` is checked against independently derived changed-domain signals. This proves only that the root-cause signal named by each row actually changed; it does **not** independently decide, row by row, whether product bytes or scanner configuration caused that row.`
    : `> [!WARNING]\n> **Independent attribution signal cross-check: NOT PERFORMED.** The baseline metadata domains are incomparable: the frozen 0.6.1 metadata predates \`scanner_configuration_fingerprint\`, while 0.6.2 provides it. The frozen metadata is not rewritten; all rows therefore retain explicit per-row adjudication, and the machine artifact records \`baseline-metadata-domains-incomparable\`.`;
  const coordinateCounts = {
    controls: mechanisms['control-evidence-coordinate-drift'] ?? 0,
    edges: mechanisms['edge-evidence-coordinate-drift'] ?? 0,
    manual: mechanisms['manual-pool-evidence-coordinate-drift'] ?? 0,
  };
  const productPinRows = Object.entries(newMeta.scanned_product_combo)
    .filter(([name, sha]) => oldMeta.scanned_product_combo[name] !== sha)
    .map(([name, sha]) => (
      `| \`${name}\` | \`${oldMeta.scanned_product_combo[name] ?? '<missing>'}\` | \`${sha}\` |`
    )).join('\n');
  const coordinateNotice = coordinateCounts.controls + coordinateCounts.edges + coordinateCounts.manual > 0
    ? `> [!IMPORTANT]\n> **Coordinate-only transition.** Added/removed controls, effects, edges, and manual rows are all zero; \`effects.jsonl\` is byte-identical. Evidence coordinates moved in ${coordinateCounts.controls} controls, ${coordinateCounts.edges} edges, and ${coordinateCounts.manual} manual rows. These rows are explicitly adjudicated as \`product\`: the product-side gitlink advance moved source lines; it did not change capability semantics.\n\nBaseline note: ${newMeta.baseline_note ?? 'n/a'}\n\n| Product pin | Previous | Current |\n|:--|:--|:--|\n${productPinRows}`
    : `> [!WARNING]\n> **FR10 evidence-pointer correction (2026-07-25).** This regenerated derivative supersedes the earlier derivative without changing either frozen baseline. Scanner root-cause references are resolved from deterministic source anchors.`;
  const markdown = `# Baseline diff: ${oldMeta.scanner_version} → ${newMeta.scanner_version}

${coordinateNotice}

> [!IMPORTANT]
> \`reason_tag\` means root cause, not the kind of object that changed. The executable criteria are: \`product\` = product-code byte change; \`scanner-config\` = scanner rule/version or projection change; \`identity\` = alias or continuous-identity adjudication change; \`ownership\` = explicit owner adjudication change. Concurrent changed domains require a per-row adjudication.

${crossCheckNotice}

## Recomputed balance

| Change mechanism | Rows | Root-cause tag | Finding ID |
|:--|--:|:--|:--|
${summaryRows}
| **Total machine rows** | **${rows.length}** | | |

## Per-row root-cause adjudication

| # | Change mechanism | ID | Root-cause tag | Root-cause reference | Rationale |
|--:|:--|:--|:--|:--|:--|
${adjudicationRows}

> [!NOTE]
> **${notesExcluded} control \`notes\` changes are deliberately excluded.** \`notes\` is descriptive scanner prose, not control identity, propagation, ownership, disposition, status, or effect semantics.
`;
  return {
    rows,
    notesExcluded,
    mechanisms,
    rootCauseSignals,
    attributionSignalCrossCheck,
    markdown,
    fromScannerVersion: oldMeta.scanner_version,
    toScannerVersion: newMeta.scanner_version,
  };
}

function discoverDefaultPair(repoRoot: string): { fromBaselineId: string; toBaselineId: string } {
  const scannerConfig = JSON.parse(
    readFileSync(join(repoRoot, 'scripts/ai-native/scanner-config.json'), 'utf8'),
  ) as { scanner_version: string; previous_baseline_id: string };
  const base = join(repoRoot, 'docs/ai-native/baseline');
  const candidates = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'meta.json')))
    .map((entry) => ({
      id: entry.name,
      meta: JSON.parse(readFileSync(join(base, entry.name, 'meta.json'), 'utf8')) as BaselineMeta,
    }))
    .filter(({ meta }) => (
      meta.scanner_version === scannerConfig.scanner_version
      && meta.previous_baseline_id === scannerConfig.previous_baseline_id
    ));
  if (candidates.length !== 1) {
    throw new Error(`cannot infer current baseline pair: found ${candidates.length} candidates`);
  }
  return { fromBaselineId: scannerConfig.previous_baseline_id, toBaselineId: candidates[0]!.id };
}

function cliOptions(): BuildBaselineDiffOptions {
  const repoRoot = resolve(import.meta.dir, '../..');
  let fromBaselineId: string | undefined;
  let toBaselineId: string | undefined;
  for (let index = 2; index < process.argv.length; index += 1) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if ((flag === '--from' || flag === '--to') && !value) throw new Error(`${flag} requires a value`);
    if (flag === '--from') { fromBaselineId = value; index += 1; }
    else if (flag === '--to') { toBaselineId = value; index += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if ((fromBaselineId === undefined) !== (toBaselineId === undefined)) {
    throw new Error('--from and --to must be supplied together');
  }
  return fromBaselineId && toBaselineId
    ? { repoRoot, fromBaselineId, toBaselineId }
    : { repoRoot, ...discoverDefaultPair(repoRoot) };
}

if (import.meta.main) {
  try {
    const options = cliOptions();
    const result = buildBaselineDiff(options);
    const out = join(resolve(options.repoRoot!), 'docs/ai-native/baseline', options.toBaselineId);
    writeFileSync(join(out, `diff-from-${result.fromScannerVersion}.jsonl`), renderDiffJsonl(result.rows));
    writeFileSync(join(out, `diff-from-${result.fromScannerVersion}.md`), result.markdown);
    process.stdout.write(
      `[baseline-diff] from=${options.fromBaselineId}; to=${options.toBaselineId}; rows=${result.rows.length}; `
      + `notes-excluded=${result.notesExcluded}; `
      + `attribution-signal-cross-check=${JSON.stringify(result.attributionSignalCrossCheck)}; `
      + `mechanisms=${JSON.stringify(result.mechanisms)}\n`,
    );
  } catch (error) {
    console.error(`[baseline-diff] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
