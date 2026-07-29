#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCurrentBaselineState } from './baseline-state.ts';

type ReasonTag = 'product' | 'scanner-config' | 'identity' | 'ownership';

type AttributionSignalCrossCheck =
  | { status: 'performed'; reason: null }
  | { status: 'not-performed'; reason: 'baseline-metadata-domains-incomparable' };

export interface VerifierRootCauseSignals {
  productBytesChanged: boolean;
  scannerConfigurationChanged: boolean;
  identityAdjudicationChanged: boolean;
  ownershipAdjudicationChanged: boolean;
}

export interface VerifyBaselineDiffOptions {
  repoRoot?: string;
  fromBaselineId: string;
  toBaselineId: string;
  reasonAdjudications?: Readonly<Record<string, ReasonTag>>;
}

export function verifyReasonTag(
  signals: VerifierRootCauseSignals,
  claimed: ReasonTag,
): ReasonTag {
  let changedDomains = 0;
  if (signals.productBytesChanged) changedDomains += 1;
  if (signals.scannerConfigurationChanged) changedDomains += 1;
  if (signals.identityAdjudicationChanged) changedDomains += 1;
  if (signals.ownershipAdjudicationChanged) changedDomains += 1;
  if (changedDomains === 0) throw new Error('no root cause input changed between baselines');

  const supported = claimed === 'product'
    ? signals.productBytesChanged
    : claimed === 'scanner-config'
      ? signals.scannerConfigurationChanged
      : claimed === 'identity'
        ? signals.identityAdjudicationChanged
        : signals.ownershipAdjudicationChanged;
  if (!supported) {
    throw new Error(`reason tag mismatch: ${claimed} has no changed verifier input`);
  }
  return claimed;
}

function soleVerifierReason(signals: VerifierRootCauseSignals): ReasonTag {
  const count = Number(signals.productBytesChanged)
    + Number(signals.scannerConfigurationChanged)
    + Number(signals.identityAdjudicationChanged)
    + Number(signals.ownershipAdjudicationChanged);
  if (count === 0) throw new Error('no root cause input changed between baselines');
  if (count > 1) throw new Error('ambiguous root causes require independent per-row adjudication');
  if (signals.ownershipAdjudicationChanged) return 'ownership';
  if (signals.identityAdjudicationChanged) return 'identity';
  if (signals.scannerConfigurationChanged) return 'scanner-config';
  return 'product';
}

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

interface Control {
  control_id: string;
  file: string;
  evidence_line: number;
  effect_id: string | null;
  propagation: string;
  owner: string;
  disposition?: string;
  status?: string;
  notes: string;
}

interface Edge {
  control_id: string;
  effect_id: string;
  propagation: string;
  via: string[];
  evidence_line: number;
}

interface Effect {
  effect_id: string;
  repo: string[];
  server_endpoints?: string[];
  vocab?: { setters?: string[]; commands?: string[]; actions?: string[] };
  [key: string]: unknown;
}

interface Manual {
  manual_id: string;
  control_id: string;
  file: string;
  evidence_line: number;
  [key: string]: unknown;
}

interface DiffRow {
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

interface BaselineMeta {
  scanner_version: string;
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
}

function readJsonLines<T>(base: string, baselineId: string, name: string): T[] {
  return readFileSync(join(base, baselineId, name), 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function edgeKey(edge: Pick<Edge, 'control_id' | 'effect_id'>): string {
  return `${edge.control_id}|${edge.effect_id}`;
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function deriveVerifierRootCauseSignals(
  oldMeta: BaselineMeta,
  newMeta: BaselineMeta,
): VerifierRootCauseSignals {
  const fingerprintMap = (meta: BaselineMeta): Map<string, string> | undefined => {
    const value = meta.scanner_configuration_fingerprint;
    if (value === null || typeof value !== 'object') return undefined;
    const domains = (value as { domains?: unknown }).domains;
    if (!Array.isArray(domains)) return undefined;
    const result = new Map<string, string>();
    for (const row of domains) {
      if (row === null || typeof row !== 'object') return undefined;
      const domain = (row as { domain?: unknown }).domain;
      const sha = (row as { sha256?: unknown }).sha256;
      if (typeof domain !== 'string' || typeof sha !== 'string') return undefined;
      result.set(domain, sha);
    }
    return result;
  };
  const oldFingerprint = fingerprintMap(oldMeta);
  const newFingerprint = fingerprintMap(newMeta);
  if ((oldFingerprint === undefined) !== (newFingerprint === undefined)) {
    throw new Error('baseline metadata domains are incomparable; independent per-row adjudication is required');
  }
  const scannerRuleSignature = (fingerprint: Map<string, string> | undefined): string | undefined => {
    if (!fingerprint) return undefined;
    return JSON.stringify(
      [...fingerprint]
        .filter(([domain]) => domain !== 'identity-aliases' && domain !== 'ownership-adjudication')
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  const changedWhenComparable = (left: unknown, right: unknown): boolean => (
    left !== undefined && right !== undefined && !same(left, right)
  );
  const oldScannerDomain = oldMeta.scanner_domain_sha
    ?? oldMeta.scanner_configuration_sha
    ?? oldMeta.scanner_config_sha;
  const newScannerDomain = newMeta.scanner_domain_sha
    ?? newMeta.scanner_configuration_sha
    ?? newMeta.scanner_config_sha;
  const oldIdentity = oldMeta.identity_adjudication_sha
    ?? oldMeta.alias_map_sha
    ?? oldMeta.identity_adjudication_fingerprint
    ?? oldFingerprint?.get('identity-aliases');
  const newIdentity = newMeta.identity_adjudication_sha
    ?? newMeta.alias_map_sha
    ?? newMeta.identity_adjudication_fingerprint
    ?? newFingerprint?.get('identity-aliases');
  const oldOwnership = oldMeta.ownership_adjudication_sha
    ?? oldMeta.ownership_sha
    ?? oldMeta.ownership_adjudication_fingerprint
    ?? oldFingerprint?.get('ownership-adjudication');
  const newOwnership = newMeta.ownership_adjudication_sha
    ?? newMeta.ownership_sha
    ?? newMeta.ownership_adjudication_fingerprint
    ?? newFingerprint?.get('ownership-adjudication');
  return {
    productBytesChanged: !same(oldMeta.scanned_product_combo, newMeta.scanned_product_combo),
    scannerConfigurationChanged: oldMeta.scanner_version !== newMeta.scanner_version
      || changedWhenComparable(oldScannerDomain, newScannerDomain)
      || changedWhenComparable(scannerRuleSignature(oldFingerprint), scannerRuleSignature(newFingerprint)),
    identityAdjudicationChanged: changedWhenComparable(oldIdentity, newIdentity),
    ownershipAdjudicationChanged: changedWhenComparable(oldOwnership, newOwnership),
  };
}

function loadVerifierReasonAdjudications(
  repoRoot: string,
  fromId: string,
  toId: string,
): Readonly<Record<string, ReasonTag>> | undefined {
  const path = join(
    repoRoot,
    'scripts/ai-native/baseline-diff-adjudications',
    `${fromId}--${toId}.jsonl`,
  );
  if (!existsSync(path)) return undefined;
  const result: Record<string, ReasonTag> = {};
  for (const [index, line] of readFileSync(path, 'utf8').trim().split('\n').entries()) {
    const row = JSON.parse(line) as { change_kind?: unknown; id?: unknown; reason_tag?: unknown };
    if (
      typeof row.change_kind !== 'string'
      || typeof row.id !== 'string'
      || !['product', 'scanner-config', 'identity', 'ownership'].includes(String(row.reason_tag))
    ) throw new Error(`invalid verifier reason adjudication at ${path}:${index + 1}`);
    const key = `${row.change_kind}\0${row.id}`;
    if (Object.hasOwn(result, key)) throw new Error(`duplicate verifier reason adjudication: ${key}`);
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
      throw new Error(`independent verifier scanner anchor must match exactly once: ${JSON.stringify(anchor)} matched ${matches.length}`);
    }
    return `${scannerPath}:${matches[0]}`;
  };
}

export function verifyBaselineDiff(
  options: VerifyBaselineDiffOptions,
): {
  rows: number;
  notesExcluded: number;
  mechanisms: Record<string, number>;
  attributionSignalCrossCheck: AttributionSignalCrossCheck;
} {
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
    ?? loadVerifierReasonAdjudications(root, fromId, toId);
  let rootCauseSignals: VerifierRootCauseSignals | null;
  try {
    rootCauseSignals = deriveVerifierRootCauseSignals(oldMeta, newMeta);
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
    if (!match) throw new Error(`independent scanner anchor is not a source location: ${ref}`);
    return { file: match[1]!, line: Number(match[2]) };
  };
  const rootRefForEdge = (edge: Edge | undefined): string => {
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
  let intervalReasonTag: ReasonTag | undefined;
  if (rootCauseSignals !== null) {
    try {
      intervalReasonTag = soleVerifierReason(rootCauseSignals);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('ambiguous root causes')) throw error;
    }
  }

  const oldControlById = new Map(oldControls.map((item) => [item.control_id, item]));
  const newControlById = new Map(newControls.map((item) => [item.control_id, item]));
  const oldEdgeById = new Map(oldEdges.map((item) => [edgeKey(item), item]));
  const newEdgeById = new Map(newEdges.map((item) => [edgeKey(item), item]));
  const oldEffectById = new Map(oldEffects.map((item) => [item.effect_id, item]));
  const newEffectById = new Map(newEffects.map((item) => [item.effect_id, item]));
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
  const audited = new Set(
    readJsonLines<Edge>(base, toId, 'known-call-symbol-audit.jsonl').map(edgeKey),
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
    if (matches.length !== 1) throw new Error(`independent route effect anchor must match once: ${effectId}`);
    return `${path}:${matches[0]}`;
  };
  const promotionRegistryRef = (effectId: string): string => {
    const path = 'scripts/ai-native/manual-pool-effect-promotions.json';
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    const needle = `"effect_id": "${effectId}",`;
    const matches = lines.flatMap((line, index) => line.trim() === needle ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`independent manual-pool promotion anchor must match once: ${effectId}`);
    return `${path}:${matches[0]}`;
  };

  const changedEdgeForControl = (controlId: string): Edge | undefined => newEdges.find((edge) => (
    edge.control_id === controlId
    && (!oldEdgeById.has(edgeKey(edge)) || !same(oldEdgeById.get(edgeKey(edge))?.via, edge.via))
  ));
  const rootCauseRef = (
    changeKind: ChangeKind,
    id: string,
    oldValue: unknown,
    newValue: unknown,
    sourceLocation: { file: string; line: number },
    reasonTag: ReasonTag,
  ): string => {
    const frozenHistoricalRef = frozenHistoricalRefs.get(`${changeKind}\0${id}`);
    if (frozenHistoricalRef) return frozenHistoricalRef;
    if (reasonTag === 'identity') return 'scripts/ai-native/alias-map.json:1';
    if (reasonTag === 'ownership') return 'docs/ai-native/other-team-gap-ownership.md:1';
    if (reasonTag === 'product') return `${sourceLocation.file}:${sourceLocation.line}`;
    if (changeKind === 'reviewed-other-team-boundary') {
      if (routeAuditByEffect.has(id)) return routeRegistryRef(id);
      return scannerRef('const COMPONENT_CALL_EFFECTS: Readonly<Record<string, KnownCallEffect>> = {};');
    }
    if (changeKind === 'effect-addition') {
      if (promotionByEffect.has(id)) return promotionRegistryRef(id);
      if (((newValue as Effect).server_endpoints?.length ?? 0) > 0) {
        return scannerRef('function extractEndpoints(root: string): { endpoints: EndpointDef[]; manual: ManualPoolRow[] } {');
      }
      const vocab = (newValue as Effect).vocab;
      if ((vocab?.setters?.length ?? 0) + (vocab?.commands?.length ?? 0) + (vocab?.actions?.length ?? 0) > 0) {
        return scannerRef('function deriveVocab(');
      }
      return rootRefForEdge(newEdges.find((edge) => edge.effect_id === id));
    }
    if (changeKind === 'control-owner-change') {
      return rootRefForEdge(newEdges.find((edge) => edge.control_id === id && !oldEdgeById.has(edgeKey(edge))));
    }
    if (changeKind === 'edge-derived-repo-attribution') {
      if (routeAuditByEffect.has(id)) return routeRegistryRef(id);
      return rootRefForEdge(newEdges.find((edge) => (
        edge.effect_id === id
        && (!oldEdgeById.has(edgeKey(edge)) || !same(oldEdgeById.get(edgeKey(edge))?.via, edge.via))
      )));
    }
    if (
      changeKind === 'symbol-reviewed-call-propagation'
      || changeKind === 'local-state-call-propagation'
      || changeKind === 'setter-call-propagation'
      || changeKind === 'endpoint-server-call-propagation'
      || changeKind === 'surface-action-propagation'
      || changeKind === 'editor-callback-propagation'
      || changeKind === 'dom-effect-propagation'
    ) return rootRefForEdge(newValue as Edge);
    if (changeKind === 'edge-via-change') return rootRefForEdge(newEdgeById.get(id));
    const controlId = changeKind === 'manual-pool-removal'
      ? (oldValue as Manual).control_id
      : id.includes('|') ? id.split('|')[0]! : id;
    return rootRefForEdge(changedEdgeForControl(controlId));
  };
  const expected: DiffRow[] = [];
  const add = (input: Omit<
    DiffRow,
    'schema_version' | 'from_baseline_id' | 'to_baseline_id' | 'reason_tag'
    | 'attribution_signal_cross_check' | 'root_cause_ref'
  >) => {
    const key = `${input.change_kind}\0${input.id}`;
    const reasonTag = intervalReasonTag ?? reasonAdjudications?.[key];
    if (reasonTag === undefined) {
      const cause = rootCauseSignals === null ? 'incomparable metadata' : 'ambiguous root causes';
      throw new Error(`${cause} for ${input.change_kind}/${input.id}: independent row adjudication is required`);
    }
    const sourceLocation = frozenHistoricalLocations.get(key) ?? input.source_location;
    expected.push({
      schema_version: 2,
      from_baseline_id: fromId,
      to_baseline_id: toId,
      ...input,
      source_location: sourceLocation,
      reason_tag: rootCauseSignals === null ? reasonTag : verifyReasonTag(rootCauseSignals, reasonTag),
      attribution_signal_cross_check: attributionSignalCrossCheck,
      root_cause_ref: rootCauseRef(
        input.change_kind,
        input.id,
        input.old_value,
        input.new_value,
        sourceLocation,
        reasonTag,
      ),
    });
  };

  for (const control of newControls) {
    const old = oldControlById.get(control.control_id);
    const source_location = { file: control.file, line: control.evidence_line };
    if (!old) {
      add({ change_kind: 'control-identity-added', id: control.control_id, source_location, old_value: null, new_value: control, finding_id: 'FR5-F5-1-CONTROL-IDENTITY' });
      continue;
    }
    const fields = [
      ['effect_id', 'semantic-primary-reclassification', 'FR5-F5-1-CONTROL-EFFECT'],
      ['propagation', 'control-propagation-change', 'FR5-F5-1-CONTROL-PROPAGATION'],
      ['owner', 'control-owner-change', 'FR5-F5-1-CONTROL-OWNER'],
      ['disposition', 'control-disposition-change', 'FR5-F5-1-CONTROL-DISPOSITION'],
      ['status', 'control-status-change', 'FR5-F5-1-CONTROL-STATUS'],
    ] as const;
    for (const [field, changeKind, findingId] of fields) {
      if (!same(old[field], control[field])) {
        add({
          change_kind: changeKind,
          id: control.control_id,
          source_location,
          old_value: old[field],
          new_value: control[field],
          finding_id: findingId,
        });
      }
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
      change_kind: 'control-identity-removed',
      id: control.control_id,
      source_location: frozenRowLocation(fromId, 'controls.jsonl', oldControls, control),
      old_value: control,
      new_value: null,
      finding_id: 'FR5-F5-1-CONTROL-IDENTITY',
    });
  }

  const classifyAddedEdge = (edge: Edge): ChangeKind => {
    if (audited.has(edgeKey(edge))) return 'symbol-reviewed-call-propagation';
    if (edge.via.some((via) => via.includes('local-state:'))) return 'local-state-call-propagation';
    if (edge.via.some((via) => via.includes('setter:'))) return 'setter-call-propagation';
    if (edge.via.some((via) => via.includes('endpoint:'))) return 'endpoint-server-call-propagation';
    if (edge.via.some((via) => via.includes('menu-command:'))) return 'declarative-menu-command-propagation';
    if (edge.via.some((via) => /^command:/.test(via))) return 'command-bus-propagation';
    if (edge.via.some((via) => via.includes('workbench:'))) return 'surface-action-propagation';
    if (edge.via.some((via) => via.includes('editor-callback:'))) return 'editor-callback-propagation';
    if (edge.via.some((via) => via.includes('dom:'))) return 'dom-effect-propagation';
    throw new Error(`independent verifier cannot classify added edge ${edgeKey(edge)}`);
  };
  for (const edge of newEdges) {
    const old = oldEdgeById.get(edgeKey(edge));
    const control = newControlById.get(edge.control_id);
    if (!control) throw new Error(`independent verifier found edge without control: ${edgeKey(edge)}`);
    const source_location = { file: control.file, line: edge.evidence_line };
    if (!old) {
      add({ change_kind: classifyAddedEdge(edge), id: edgeKey(edge), source_location, old_value: null, new_value: edge, finding_id: 'FR5-F5-1-EDGE-ADDITION' });
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
    if (!control) throw new Error(`independent verifier found removed edge without old control: ${edgeKey(edge)}`);
    add({
      change_kind: 'edge-removal',
      id: edgeKey(edge),
      source_location: frozenRowLocation(fromId, 'edges.jsonl', oldEdges, edge),
      old_value: edge,
      new_value: null,
      finding_id: 'FR5-F5-1-EDGE-REMOVAL',
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
      throw new Error(`independent verifier found effect without edge or registered-route witness: ${effectId}`);
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

  const actual = readJsonLines<Record<string, unknown>>(
    base,
    toId,
    `diff-from-${oldMeta.scanner_version}.jsonl`,
  );
  const exactKeys = [
    'schema_version', 'from_baseline_id', 'to_baseline_id', 'change_kind', 'id',
    'source_location', 'old_value', 'new_value', 'reason_tag', 'attribution_signal_cross_check',
    'root_cause_ref', 'finding_id',
  ].sort();
  if (actual.length !== expected.length) {
    throw new Error(`diff row count mismatch: actual=${actual.length} expected=${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = actual[index]!;
    if (!same(Object.keys(row).sort(), exactKeys)) {
      throw new Error(`diff row ${index + 1} has an invalid field set: ${JSON.stringify(Object.keys(row).sort())}`);
    }
    if (rootCauseSignals !== null) {
      const claimed = row.reason_tag;
      if (!['product', 'scanner-config', 'identity', 'ownership'].includes(String(claimed))) {
        throw new Error(`diff row ${index + 1} has an invalid reason_tag: ${JSON.stringify(claimed)}`);
      }
      verifyReasonTag(rootCauseSignals, claimed as ReasonTag);
    }
    if (!isDeepStrictEqual(row, expected[index])) {
      throw new Error(
        `diff full-payload mismatch at row ${index + 1}: actual=${JSON.stringify(row)} expected=${JSON.stringify(expected[index])}`,
      );
    }
    const reference = String(row.root_cause_ref);
    const match = /^(.+):(\d+)$/.exec(reference);
    if (!match || isAbsolute(match[1]!)) throw new Error(`invalid root_cause_ref at row ${index + 1}: ${reference}`);
    const target = resolve(root, match[1]!);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith('../')) throw new Error(`root_cause_ref escapes repository at row ${index + 1}`);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`root_cause_ref is not a regular source file at row ${index + 1}`);
    if (Number(match[2]) > readFileSync(target, 'utf8').split('\n').length) {
      throw new Error(`root_cause_ref line is out of range at row ${index + 1}: ${reference}`);
    }
  }

  const notesExcluded = newControls.filter((item) => {
    const old = oldControlById.get(item.control_id);
    return old !== undefined && old.notes !== item.notes;
  }).length;
  const mechanisms = Object.fromEntries(
    [...actual.reduce((map, item) => {
      const kind = String(item.change_kind);
      map.set(kind, (map.get(kind) ?? 0) + 1);
      return map;
    }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)),
  );
  return { rows: actual.length, notesExcluded, mechanisms, attributionSignalCrossCheck };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, '../..');
    let fromBaselineId = '';
    let toBaselineId = '';
    for (let index = 2; index < process.argv.length; index += 1) {
      const flag = process.argv[index];
      const value = process.argv[index + 1];
      if ((flag === '--from' || flag === '--to') && !value) throw new Error(`${flag} requires a value`);
      if (flag === '--from') { fromBaselineId = value!; index += 1; }
      else if (flag === '--to') { toBaselineId = value!; index += 1; }
      else throw new Error(`unknown argument: ${flag}`);
    }
    if (!fromBaselineId && !toBaselineId) {
      const state = loadCurrentBaselineState(root);
      fromBaselineId = state.previousBaselineId;
      toBaselineId = state.currentBaselineId;
    } else if (!fromBaselineId || !toBaselineId) throw new Error('--from and --to must be supplied together');
    const result = verifyBaselineDiff({ fromBaselineId, toBaselineId });
    process.stdout.write(
      `[baseline-diff-verify] PASS rows=${result.rows}; notes-excluded=${result.notesExcluded}; `
      + `attribution-signal-cross-check=${JSON.stringify(result.attributionSignalCrossCheck)}; `
      + `mechanisms=${JSON.stringify(result.mechanisms)}\n`,
    );
  } catch (error) {
    console.error(`[baseline-diff-verify] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
