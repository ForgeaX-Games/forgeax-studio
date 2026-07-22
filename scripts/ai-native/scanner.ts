import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { controlId, resolveAlias, validateAliasMap } from './control-id';
import type {
  AliasMap,
  ControlOwner,
  ControlPropagation,
  ControlRow,
  ControlSurface,
  EdgeRow,
  EffectRow,
  ManualPoolRow,
  UiRepo,
} from './types';

export const SCANNER_VERSION = '0.5.0';
export const DEFAULT_ROOT = resolve(import.meta.dir, '../..');
const SCANNER_PREVIOUS_BASELINE_ID = 'b0-2026-07-17-0.4.0';
const PINNED_PRODUCT_BASELINE_ID = 'b0-2026-07-17-0.1.0';
const SCANNER_CHANGE_NOTE = 'Added a separately audited lowercase method family for exact property calls named on, once, or subscribe; callback literals/identifiers reuse the existing subscription effect propagation and unresolved-control manual pool, while infrastructure calls require signed call-scoped exclusions.';

const NARROW_SUBSCRIPTION_METHODS = new Set(['on', 'once', 'subscribe']);

type MethodSubscriptionDecision =
  | 'real-user-entry'
  | 'infrastructure-plumbing'
  | 'effect-unclear';

interface RetainedMethodSubscriptionReview {
  file: string;
  line: number;
  receiver: string;
  method: 'on' | 'once' | 'subscribe';
  topic: string | null;
  decision: Exclude<MethodSubscriptionDecision, 'infrastructure-plumbing'>;
  rationale: string;
}

/**
 * Human-reviewed retained rows for the v0.5.0 lowercase method family. Every
 * other candidate must match one exact signed exclusion. Line is evidence and
 * an audit gate here; it remains excluded from control_id itself.
 */
const RETAINED_METHOD_SUBSCRIPTION_REVIEWS: readonly RetainedMethodSubscriptionReview[] = [
  {
    file: 'packages/interface/src/lib/platform/window-manager.ts',
    line: 107,
    receiver: 'win',
    method: 'once',
    topic: 'tauri://destroyed',
    decision: 'effect-unclear',
    rationale: 'A user closing the OS window reaches notifyClosed, but the dynamic closeListeners fan-out prevents a static canonical effect.',
  },
  {
    file: 'packages/studio/src/panels/editorRenderers.tsx',
    line: 200,
    receiver: 'panelBridge',
    method: 'on',
    topic: 'assetsChanged',
    decision: 'real-user-entry',
    rationale: 'The owned assetsChanged path stops play when needed, resets the edit realm, and increments the viewport epoch.',
  },
  {
    file: 'packages/studio/src/panels/editorRenderers.tsx',
    line: 234,
    receiver: 'panelBridge',
    method: 'on',
    topic: 'editorHealth',
    decision: 'effect-unclear',
    rationale: 'The handler resumes play and restores display after reload, but gateway dispatch/ref mutations are outside current static propagation.',
  },
  {
    file: 'packages/studio/src/panels/editorRenderers.tsx',
    line: 327,
    receiver: 'panelBridge',
    method: 'on',
    topic: 'editorHealth',
    decision: 'real-user-entry',
    rationale: 'The editorHealth stream drives the human-visible boot overlay stage and visibility through React state setters.',
  },
];

export interface UiScanRoot {
  repo: UiRepo;
  path: string;
}

export const DEFAULT_UI_SCAN_ROOTS: readonly UiScanRoot[] = [
  { repo: 'interface', path: 'packages/interface/src' },
  { repo: 'chat', path: 'packages/chat/src' },
  { repo: 'studio', path: 'packages/studio/src' },
];

const OTHER_TEAM_REPOS = [
  { repo: 'editor', owner: 'ForgeaX-Games/forgeax-editor' },
  { repo: 'marketplace', owner: 'ForgeaX-Games/forgeax-marketplace' },
  { repo: 'settings', owner: 'ForgeaX-Games/forgeax-settings' },
  { repo: 'workbench', owner: 'ForgeaX-Games/forgeax-workbench' },
  { repo: 'dashboard', owner: 'ForgeaX-Games/forgeax-dashboard' },
] as const;

// TypeScript is already a devDependency of packages/interface. Resolving from
// that package makes the scanner work in the root without adding a dependency.
const requireFromInterface = createRequire(join(DEFAULT_ROOT, 'packages/interface/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ts: any = requireFromInterface('typescript');

const STABLE_JSX_ATTRIBUTES = new Set([
  'id',
  'name',
  'role',
  'type',
  'title',
  'href',
  'to',
  'className',
  'value',
]);

interface ParsedFile {
  abs: string;
  rel: string;
  repo: string;
  repoRelative: string;
  text: string;
  // TypeScript SourceFile; kept as any so the root package needs no TS types.
  sf: any;
  locals: Map<string, any[]>;
  localStateSetters: Set<string>;
  constantDeclarations: Map<string, any>;
  imports: Map<string, { imported: string; source: string }>;
}

export interface ExclusionRule {
  file?: string;
  event?: string;
  element?: string;
  calls?: string[];
  method?: string;
  receiver?: string;
  reason: string;
  verified_applicability?: string;
}

interface Exclusions {
  version: number;
  jsx_event_rules: ExclusionRule[];
  listener_rules: ExclusionRule[];
  subscription_rules: ExclusionRule[];
}

interface VocabConfig {
  version: number;
  overrides: {
    setters: Record<string, string>;
    commands: Record<string, string>;
    actions: Record<string, string>;
  };
  auto?: {
    setters: Record<string, string>;
    commands: Record<string, string>;
    actions: Record<string, string>;
  };
  server_endpoint_overrides?: Record<string, string[]>;
}

interface SetterDef {
  name: string;
  repo: string;
  file: string;
  line: number;
  node: any;
}

interface ActionDef {
  id: string;
  title: string;
  capability: string;
  surface: 'ui' | 'server' | 'both';
  firstClass: boolean;
  repo: string;
  file: string;
  line: number;
  run: any | null;
  setterCalls: string[];
  endpoints: string[];
}

interface CommandDef {
  id: string;
  title: string;
  repo: string;
  file: string;
  line: number;
  execute: any | null;
  setterCalls: string[];
}

interface EndpointDef {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  repo: string;
  file: string;
  line: number;
  factory: string | null;
}

interface HandlerAnalysis {
  effects: Map<string, string[]>;
  forwardedProps: Set<string>;
  owner: ControlOwner;
}

interface RawControl {
  repo: string;
  repoRelative: string;
  surface: ControlSurface;
  event: string;
  component: string;
  file: string;
  line: number;
  elementType: string;
  stableAttributes: Record<string, string>;
  staticText: string;
  ordinal: number;
  handler: any | null;
  parsed: ParsedFile;
  collector: string;
  propagation: Exclude<ControlPropagation, 'manual-pool'>;
  owner: ControlOwner;
  notes: string[];
  forwardedProps: Set<string>;
  effects: Map<string, string[]>;
}

interface ProviderDiBranch {
  repo: string;
  file: string;
  line: number;
  component: string;
  callee: string;
  importSource: string;
  targetDomain: string;
  property: string;
  handler: any;
  summary: string;
}

interface EffectAccumulator {
  repos: Set<string>;
  setters: Set<string>;
  commands: Set<string>;
  actions: Set<string>;
  endpoints: Set<string>;
  actionDefs: ActionDef[];
  toolIds: Set<string>;
  headless: boolean;
}

export interface InventoryStats {
  controls: number;
  effects: number;
  agentEquivalentEffects: number;
  manualPool: number;
  manualControls: number;
  manualControlRatio: number;
  rawOnClick: number;
  rawOnClickFiles: number;
  endpoints: number;
  sourceCounts: Record<string, number>;
  manualSourceCounts: Record<string, number>;
  domainCounts: Record<string, number>;
  repoControlCounts: Record<string, number>;
  repoOnClickCounts: Record<string, number>;
  excluded: number;
  actualUseSurfaceCalls: number;
  constantListenerCallSites: number;
  constantListenerEvents: number;
  unresolvedListenerExpressions: number;
  diProviderBranches: number;
  diProviderAnnotations: number;
  diProviderManual: number;
  narrowSubscriptionCandidates: number;
  narrowSubscriptionRetained: number;
  narrowSubscriptionExcluded: number;
  narrowSubscriptionExclusionRules: number;
}

interface ConstantListenerAudit {
  repo: string;
  file: string;
  line: number;
  expression: string;
  events: string[];
  disposition: 'excluded' | 'collected' | 'mixed' | 'no-direct-effect';
  reasons: string[];
}

export interface SubscriptionCandidateAudit {
  family: 'on-xxx' | 'lowercase-method';
  file: string;
  evidence_line: number;
  receiver: string;
  method: string;
  topic: string | null;
  disposition: 'collected' | 'excluded';
  exclusion_reason: string | null;
  verified_applicability: string | null;
}

export interface MethodSubscriptionAudit extends SubscriptionCandidateAudit {
  family: 'lowercase-method';
  decision: MethodSubscriptionDecision;
  rationale: string;
  control_id: string | null;
  effect_id: string | null;
  propagation: ControlPropagation | null;
}

interface OtherTeamSurfaceRow {
  repo: string;
  owner: string;
  controls: number;
  interactiveFiles: number;
  topFiles: Array<{ file: string; controls: number; events: string[] }>;
}

export interface InventoryResult {
  baselineId: string;
  scannerVersion: string;
  controls: ControlRow[];
  effects: EffectRow[];
  edges: EdgeRow[];
  manualPool: ManualPoolRow[];
  meta: Record<string, unknown>;
  summary: string;
  stats: InventoryStats;
  vocabMap: VocabConfig;
  otherTeamSurface: OtherTeamSurfaceRow[];
  constantListeners: ConstantListenerAudit[];
  methodSubscriptionAudit: MethodSubscriptionAudit[];
  negativeCandidates: Array<{ stratum: string; file: string }>;
}

interface BaselineControlDiff {
  previousBaselineId: string;
  previousCount: number;
  previousEffects: number;
  previousManualPool: number;
  previousManualControls: number;
  added: ControlRow[];
  removed: ControlRow[];
  migrated: Array<{ old: ControlRow; current: ControlRow }>;
}

export interface BuildOptions {
  root?: string;
  baselineDate?: string;
  uiRoots?: readonly UiScanRoot[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function lineOf(sf: any, node: any): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function nodeName(node: any): string {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier?.(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return staticString(node.expression) ?? node.expression.getText();
  if (ts.isPropertyAccessExpression(node)) return `${nodeName(node.expression)}.${node.name.text}`;
  if (ts.isJsxNamespacedName?.(node)) return `${node.namespace.text}:${node.name.text}`;
  return node.getText?.() ?? '';
}

function unwrap(node: any): any {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isSatisfiesExpression?.(current))
  ) {
    current = current.expression;
  }
  return current;
}

function staticString(node: any, substitutions: Record<string, string> = {}): string | null {
  const n = unwrap(node);
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) {
    return String(n.text);
  }
  if (n.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (n.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isIdentifier(n) && substitutions[n.text] !== undefined) return substitutions[n.text];
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    for (const span of n.templateSpans) {
      const replacement = staticString(span.expression, substitutions);
      if (replacement === null) return null;
      out += replacement + span.literal.text;
    }
    return out;
  }
  if (ts.isCallExpression(n) && nodeName(n.expression) === 't') {
    return staticString(n.arguments[0], substitutions);
  }
  return null;
}

type StaticValue = string | StaticValue[] | Record<string, StaticValue>;

function importedSourceFile(
  files: Map<string, ParsedFile>,
  from: ParsedFile,
  source: string,
): ParsedFile | null {
  let base: string;
  if (source.startsWith('.')) base = slash(join(dirname(from.rel), source));
  else if (source.startsWith('@forgeax/interface/')) base = `packages/interface/src/${source.slice('@forgeax/interface/'.length)}`;
  else if (source.startsWith('@forgeax/chat/')) base = `packages/chat/src/${source.slice('@forgeax/chat/'.length)}`;
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.map((candidate) => files.get(candidate)).find(Boolean) ?? null;
}

function staticValue(
  parsed: ParsedFile,
  node: any,
  files: Map<string, ParsedFile>,
  substitutions: Record<string, string> = {},
  seen: Set<string> = new Set(),
): StaticValue | null {
  const n = unwrap(node);
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return String(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (n.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isIdentifier(n)) {
    if (substitutions[n.text] !== undefined) return substitutions[n.text];
    const local = parsed.constantDeclarations.get(n.text);
    if (local) {
      const key = `${parsed.rel}#${n.text}`;
      if (seen.has(key)) return null;
      return staticValue(parsed, local, files, substitutions, new Set([...seen, key]));
    }
    const binding = parsed.imports.get(n.text);
    if (!binding) return null;
    const target = importedSourceFile(files, parsed, binding.source);
    const declaration = target?.constantDeclarations.get(binding.imported);
    if (!target || !declaration) return null;
    const key = `${target.rel}#${binding.imported}`;
    if (seen.has(key)) return null;
    return staticValue(target, declaration, files, substitutions, new Set([...seen, key]));
  }
  if (ts.isPropertyAccessExpression(n)) {
    const target = staticValue(parsed, n.expression, files, substitutions, seen);
    if (!target || typeof target === 'string' || Array.isArray(target)) return null;
    return target[n.name.text] ?? null;
  }
  if (ts.isElementAccessExpression(n)) {
    const target = staticValue(parsed, n.expression, files, substitutions, seen);
    const key = staticValue(parsed, n.argumentExpression, files, substitutions, seen);
    if (!target || typeof target === 'string' || Array.isArray(target) || typeof key !== 'string') return null;
    return target[key] ?? null;
  }
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    for (const span of n.templateSpans) {
      const replacement = staticValue(parsed, span.expression, files, substitutions, seen);
      if (typeof replacement !== 'string') return null;
      out += replacement + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticValue(parsed, n.left, files, substitutions, seen);
    const right = staticValue(parsed, n.right, files, substitutions, seen);
    return typeof left === 'string' && typeof right === 'string' ? left + right : null;
  }
  if (ts.isArrayLiteralExpression(n)) {
    const values: StaticValue[] = [];
    for (const element of n.elements) {
      const value = staticValue(parsed, element, files, substitutions, seen);
      if (value === null) return null;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const value: Record<string, StaticValue> = {};
    for (const property of n.properties) {
      if (!ts.isPropertyAssignment(property)) return null;
      const key = nodeName(property.name);
      const item = staticValue(parsed, property.initializer, files, substitutions, seen);
      if (!key || item === null) return null;
      value[key] = item;
    }
    return value;
  }
  if (ts.isCallExpression(n) && nodeName(n.expression) === 't') {
    return staticValue(parsed, n.arguments[0], files, substitutions, seen);
  }
  return null;
}

function staticEventNames(parsed: ParsedFile, node: any, files: Map<string, ParsedFile>): string[] {
  const direct = staticValue(parsed, node, files);
  if (typeof direct === 'string') return [direct];
  if (Array.isArray(direct) && direct.every((value) => typeof value === 'string')) {
    return [...new Set(direct as string[])].sort();
  }
  const identifier = unwrap(node);
  if (!ts.isIdentifier(identifier)) return [];
  let current = identifier.parent;
  while (current) {
    if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer)) {
      const declaration = current.initializer.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) {
        const iterable = staticValue(parsed, current.expression, files);
        if (Array.isArray(iterable) && iterable.every((value) => typeof value === 'string')) {
          return [...new Set(iterable as string[])].sort();
        }
      }
    }
    current = current.parent;
  }
  return [];
}

function routeString(node: any): string | null {
  const n = unwrap(node);
  const exact = staticString(n);
  if (exact !== null) return exact;
  if (!ts.isTemplateExpression(n)) return null;
  let out = n.head.text;
  for (const span of n.templateSpans) {
    const raw = nodeName(unwrap(span.expression)).split('.').at(-1) || 'dynamic';
    out += `:${snake(raw) || 'dynamic'}` + span.literal.text;
  }
  return out;
}

function propertyOf(obj: any, name: string): any | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const prop of obj.properties) {
    if ((ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop) || ts.isShorthandPropertyAssignment(prop)) && nodeName(prop.name) === name) {
      return prop;
    }
  }
  return null;
}

function propertyValue(prop: any): any | null {
  if (!prop) return null;
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
  if (ts.isMethodDeclaration(prop)) return prop;
  return null;
}

function literalProperty(obj: any, name: string): string | null {
  return staticString(propertyValue(propertyOf(obj, name)));
}

function booleanProperty(obj: any, name: string): boolean {
  return propertyValue(propertyOf(obj, name))?.kind === ts.SyntaxKind.TrueKeyword;
}

function functionName(node: any): string | null {
  if (!node) return null;
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name) return nodeName(node.name);
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  let p = node.parent;
  while (p) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p) && p.initializer === node) return nodeName(p.name);
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isMethodDeclaration(p) && p.name) return nodeName(p.name);
    p = p.parent;
  }
  return null;
}

function enclosingFunctionName(node: any): string {
  let p = node.parent;
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p)
    ) {
      const name = functionName(p);
      if (name) return name;
    }
    p = p.parent;
  }
  return '<module>';
}

function visit(node: any, cb: (node: any) => void): void {
  cb(node);
  ts.forEachChild(node, (child: any) => visit(child, cb));
}

function addLocal(locals: Map<string, any[]>, name: string, node: any): void {
  const list = locals.get(name) ?? [];
  list.push(node);
  locals.set(name, list);
}

function lexicalContainer(node: any): any {
  let current = node.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function resolveLocal(parsed: ParsedFile, name: string, at: any): any | null {
  const candidates = parsed.locals.get(name) ?? [];
  const visible = candidates.filter((candidate) => {
    const scope = lexicalContainer(candidate);
    return scope.pos <= at.pos && at.end <= scope.end;
  });
  return [...visible].sort((a, b) => {
    const aScope = lexicalContainer(a);
    const bScope = lexicalContainer(b);
    const width = (aScope.end - aScope.pos) - (bScope.end - bScope.pos);
    if (width !== 0) return width;
    const aDistance = Math.abs(at.pos - a.pos);
    const bDistance = Math.abs(at.pos - b.pos);
    return aDistance - bDistance;
  })[0] ?? null;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current).sort()) {
      if (['node_modules', 'dist', '.git', 'build', 'coverage'].includes(name)) continue;
      const full = join(current, name);
      const normalized = slash(full);
      if (normalized.includes('/packages/editor/packages/interface/')) continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function configuredUiFiles(root: string, roots: readonly UiScanRoot[]): ParsedFile[] {
  const seenRoots = new Set<string>();
  const seenSources = new Set<string>();
  const out: ParsedFile[] = [];
  for (const entry of roots) {
    if (!['interface', 'chat', 'studio'].includes(entry.repo)) throw new Error(`unsupported owned UI repo: ${entry.repo}`);
    const normalizedPath = slash(entry.path).replace(/^\.\//, '').replace(/\/$/, '');
    const rootKey = `${entry.repo}:${normalizedPath}`;
    if (seenRoots.has(rootKey)) throw new Error(`duplicate UI scan root: ${rootKey}`);
    seenRoots.add(rootKey);
    const absRoot = join(root, normalizedPath);
    if (!existsSync(absRoot)) throw new Error(`UI scan root missing: ${normalizedPath}`);
    const repoRoot = normalizedPath.replace(/\/src(?:\/.*)?$/, '');
    for (const abs of listSourceFiles(absRoot)) {
      const parsed = parseFile(root, abs, { repo: entry.repo, repoRoot });
      const sourceKey = `${parsed.repo}:${parsed.repoRelative}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      out.push(parsed);
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.repoRelative.localeCompare(b.repoRelative));
}

/** Repository-owned TS/TSX only: nested git worktrees/submodules are not charged to the parent team. */
function listRepoOwnedSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (['node_modules', 'dist', '.git', 'build', 'coverage', '__tests__'].includes(name)) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (existsSync(join(full, '.git'))) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  if (existsSync(repoRoot)) walk(repoRoot);
  return out.sort();
}

function repoInfo(root: string, abs: string): { repo: string; repoRelative: string } {
  const rel = slash(relative(root, abs));
  const m = rel.match(/^packages\/([^/]+)\/(.*)$/);
  if (m && existsSync(join(root, 'packages', m[1], '.git'))) {
    return { repo: m[1], repoRelative: m[2] };
  }
  return { repo: 'forgeax-studio', repoRelative: rel };
}

function indexParsedFile(parsed: ParsedFile): void {
  visit(parsed.sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) addLocal(parsed.locals, node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) addLocal(parsed.locals, node.name.text, init);
      if (ts.isCallExpression(init) && ['useCallback', 'useMemo'].includes(nodeName(init.expression))) {
        const fn = unwrap(init.arguments[0]);
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) addLocal(parsed.locals, node.name.text, fn);
      }
      const declarationList = node.parent;
      if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0) {
        parsed.constantDeclarations.set(node.name.text, node.initializer);
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings) {
      const source = node.moduleSpecifier.text;
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          parsed.imports.set(specifier.name.text, {
            imported: specifier.propertyName?.text ?? specifier.name.text,
            source,
          });
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(unwrap(node.initializer)) &&
      nodeName(unwrap(node.initializer).expression) === 'useState'
    ) {
      const setter = node.name.elements[1];
      if (setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) parsed.localStateSetters.add(setter.name.text);
    }
  });
}

function parseFile(
  root: string,
  abs: string,
  explicitRepo?: { repo: UiRepo; repoRoot: string },
): ParsedFile {
  const text = readFileSync(abs, 'utf8');
  const rel = slash(relative(root, abs));
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sf.parseDiagnostics.length > 0) {
    const detail = sf.parseDiagnostics
      .slice(0, 5)
      .map((diagnostic: any) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('; ');
    throw new Error(`TypeScript parse failed for ${rel}: ${detail}`);
  }
  const ri = explicitRepo
    ? { repo: explicitRepo.repo, repoRelative: slash(relative(join(root, explicitRepo.repoRoot), abs)) }
    : repoInfo(root, abs);
  const parsed: ParsedFile = {
    abs,
    rel,
    ...ri,
    text,
    sf,
    locals: new Map(),
    localStateSetters: new Set(),
    constantDeclarations: new Map(),
    imports: new Map(),
  };
  indexParsedFile(parsed);
  return parsed;
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function componentDomain(component: string): string {
  const value = snake(component.replace(/^use/, ''));
  return value && value !== 'module' ? value : 'ui';
}

function addEffect(target: Map<string, string[]>, effect: string, via: string): void {
  if (!effect || !/^[a-z0-9_]+\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(effect)) return;
  const list = target.get(effect) ?? [];
  if (!list.includes(via)) list.push(via);
  target.set(effect, list);
}

function callLastName(call: any): string {
  const expr = unwrap(call.expression);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) return staticString(expr.argumentExpression) ?? '';
  return '';
}

function receiverName(call: any): string {
  const expr = unwrap(call.expression);
  return ts.isPropertyAccessExpression(expr) ? nodeName(expr.expression) : '';
}

function fetchEndpoint(call: any): string | null {
  if (callLastName(call) !== 'fetch') return null;
  const path = routeString(call.arguments[0]);
  if (!path) return null;
  let method = 'GET';
  const opts = unwrap(call.arguments[1]);
  if (opts && ts.isObjectLiteralExpression(opts)) method = (literalProperty(opts, 'method') ?? 'GET').toUpperCase();
  return `${method} ${path}`;
}

function collectCallNames(node: any, allowed: Set<string>): string[] {
  const out = new Set<string>();
  if (!node) return [];
  visit(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = callLastName(n);
    if (allowed.has(name)) out.add(name);
  });
  return [...out].sort();
}

function collectEndpointsIn(node: any): string[] {
  const out = new Set<string>();
  if (!node) return [];
  visit(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    const endpoint = fetchEndpoint(n);
    if (endpoint && /^(POST|PUT|DELETE|PATCH) /.test(endpoint)) out.add(endpoint);
  });
  return [...out].sort();
}

function extractStoreFunctions(files: Map<string, ParsedFile>): SetterDef[] {
  const store = files.get('packages/interface/src/store.ts');
  const shell = files.get('packages/interface/src/store-parts/shell.ts');
  if (!store || !shell) throw new Error('store SSOT files not found');
  const appFunctions = new Set<string>();
  visit(store.sf, (node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'AppState') return;
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name && member.type && ts.isFunctionTypeNode(member.type)) {
        appFunctions.add(nodeName(member.name));
      }
    }
  });
  const out = new Map<string, SetterDef>();
  for (const parsed of [store, shell]) {
    visit(parsed.sf, (node) => {
      if (!ts.isPropertyAssignment(node) && !ts.isMethodDeclaration(node)) return;
      const name = nodeName(node.name);
      if (!appFunctions.has(name)) return;
      const value = ts.isPropertyAssignment(node) ? unwrap(node.initializer) : node;
      if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value) && !ts.isMethodDeclaration(value)) return;
      // The nearest object must be the state object. Nested callback objects use
      // names that are not AppState function properties and were filtered above.
      out.set(name, { name, repo: parsed.repo, file: parsed.rel, line: lineOf(parsed.sf, node), node: value });
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractActions(files: Map<string, ParsedFile>, setters: Set<string>): ActionDef[] {
  const out: ActionDef[] = [];
  for (const parsed of files.values()) {
    if (!['interface', 'chat', 'studio'].includes(parsed.repo)) continue;
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node) || callLastName(node) !== 'registerAction') return;
      const obj = unwrap(node.arguments[0]);
      if (!obj || !ts.isObjectLiteralExpression(obj)) return;
      const id = literalProperty(obj, 'id');
      if (!id) return;
      const run = unwrap(propertyValue(propertyOf(obj, 'run')));
      const surfaceRaw = literalProperty(obj, 'surface');
      const surface = surfaceRaw === 'server' || surfaceRaw === 'both' ? surfaceRaw : 'ui';
      out.push({
        id,
        title: literalProperty(obj, 'title') ?? id,
        capability: literalProperty(obj, 'capability') ?? 'other',
        surface,
        firstClass: booleanProperty(obj, 'firstClass'),
        repo: parsed.repo,
        file: parsed.rel,
        line: lineOf(parsed.sf, node),
        run,
        setterCalls: collectCallNames(run, setters),
        endpoints: collectEndpointsIn(run),
      });
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
}

function extractCommands(files: Map<string, ParsedFile>, setters: Set<string>): CommandDef[] {
  const out: CommandDef[] = [];
  for (const parsed of files.values()) {
    if (!['interface', 'chat', 'studio'].includes(parsed.repo)) continue;
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node) || callLastName(node) !== 'registerCommand') return;
      const obj = unwrap(node.arguments[0]);
      if (!obj || !ts.isObjectLiteralExpression(obj)) return;
      const id = literalProperty(obj, 'id');
      if (!id) return;
      const execute = unwrap(propertyValue(propertyOf(obj, 'execute')));
      out.push({
        id,
        title: literalProperty(obj, 'title') ?? id,
        repo: parsed.repo,
        file: parsed.rel,
        line: lineOf(parsed.sf, node),
        execute,
        setterCalls: collectCallNames(execute, setters),
      });
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
}

function nearestFactory(node: any): string | null {
  let p = node.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && functionName(p)) return functionName(p);
    p = p.parent;
  }
  return null;
}

function joinRoute(prefix: string, path: string): string {
  if (path.startsWith('/api/')) return path.replace(/\/{2,}/g, '/');
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith('/') ? path : `/${path}`;
  const joined = `${left}${right}`.replace(/\/{2,}/g, '/');
  return joined || '/';
}

function extractEndpoints(root: string): { endpoints: EndpointDef[]; manual: ManualPoolRow[] } {
  const absFiles = [
    ...listSourceFiles(join(root, 'packages/orchestrator/src')),
    ...listSourceFiles(join(root, 'packages/server/src')),
  ];
  const parsed = absFiles.map((file) => parseFile(root, file));
  const prefixes = new Map<string, string>();
  const mountEdges: Array<{ parent: string | null; child: string; prefix: string }> = [];
  const honoReceivers = new Map<string, Set<string>>();
  for (const file of parsed) {
    const names = new Set<string>();
    visit(file.sf, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(node.name) && ts.isNewExpression(init) && callLastName({ expression: init.expression }) === 'Hono') {
        names.add(node.name.text);
        return;
      }
      // Product server receives the already-booted Hono app from
      // `const { app } = await createForgeaxApp(...)` and then appends its own
      // routes. It is a route receiver even though this file has no `new Hono`.
      if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isCallExpression(init) &&
        callLastName(init) === 'createForgeaxApp'
      ) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) names.add(element.name.text);
        }
      }
    });
    honoReceivers.set(file.rel, names);
  }
  for (const file of parsed) {
    visit(file.sf, (node) => {
      if (!ts.isCallExpression(node) || callLastName(node) !== 'route') return;
      if (!honoReceivers.get(file.rel)?.has(receiverName(node))) return;
      const prefix = routeString(node.arguments[0]);
      const router = unwrap(node.arguments[1]);
      if (!prefix || !router || !ts.isCallExpression(router)) return;
      const factory = callLastName(router);
      if (factory) mountEdges.push({ parent: nearestFactory(node), child: factory, prefix });
    });
    // packages/server declares its routers as data before a generic
    // `app.route(r.path, r.router)` loop. Recover the same factory→prefix edge
    // from `{ path:'/api/x', router:createXRouter() }` object literals.
    visit(file.sf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const prefix = literalProperty(node, 'path');
      const router = unwrap(propertyValue(propertyOf(node, 'router')));
      if (!prefix || !router || !ts.isCallExpression(router)) return;
      const factory = callLastName(router);
      if (factory) mountEdges.push({ parent: null, child: factory, prefix });
    });
  }
  // Resolve nested Hono mounts as a graph. Most routers are one hop below
  // createForgeaxApp; commands is two hops (`/api/commands` + `/`).
  const mountedFactories = new Set(mountEdges.map((edge) => edge.child));
  for (const edge of mountEdges) {
    if (edge.parent === null || !mountedFactories.has(edge.parent)) {
      prefixes.set(edge.child, joinRoute('', edge.prefix));
    }
  }
  for (let pass = 0; pass < mountEdges.length; pass += 1) {
    let changed = false;
    for (const edge of mountEdges) {
      if (!edge.parent || !prefixes.has(edge.parent)) continue;
      const full = joinRoute(prefixes.get(edge.parent)!, edge.prefix);
      if (prefixes.get(edge.child) === full) continue;
      prefixes.set(edge.child, full);
      changed = true;
    }
    if (!changed) break;
  }
  const endpoints: EndpointDef[] = [];
  const manual: ManualPoolRow[] = [];
  for (const file of parsed) {
    visit(file.sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const method = callLastName(node).toUpperCase();
      if (!['POST', 'PUT', 'DELETE'].includes(method)) return;
      // Hono route registration is always invoked on a local `new Hono()`
      // binding in the scanned sources. This guard is what separates
      // `router.delete('/x')` from the many Map/Set `.delete(key)` calls.
      if (!honoReceivers.get(file.rel)?.has(receiverName(node))) return;
      const rawPath = routeString(node.arguments[0]);
      const factory = nearestFactory(node);
      if (!rawPath) {
        manual.push(manualRow('route', file.rel, lineOf(file.sf, node), factory ?? '<module>', method, null, node.arguments[0]?.getText() ?? '', 'route path is not statically resolvable', {}));
        return;
      }
      const prefix = factory ? prefixes.get(factory) ?? '' : '';
      endpoints.push({
        method: method as EndpointDef['method'],
        path: joinRoute(prefix, rawPath),
        repo: file.repo,
        file: file.rel,
        line: lineOf(file.sf, node),
        factory,
      });
    });
  }
  const byKey = new Map<string, EndpointDef>();
  for (const endpoint of endpoints.sort((a, b) => `${a.method} ${a.path} ${a.file}`.localeCompare(`${b.method} ${b.path} ${b.file}`))) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (!byKey.has(key)) byKey.set(key, endpoint);
  }
  return { endpoints: [...byKey.values()], manual };
}

/** Audit/test view of the source-level Hono side-effect route table. */
export function scanServerEndpoints(root: string = DEFAULT_ROOT): Array<{
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  file: string;
  line: number;
}> {
  return extractEndpoints(resolve(root)).endpoints.map(({ method, path, file, line }) => ({ method, path, file, line }));
}

function normalizeEndpointKey(endpoint: string): string {
  const space = endpoint.indexOf(' ');
  if (space < 0) return endpoint;
  const method = endpoint.slice(0, space).toUpperCase();
  const path = endpoint.slice(space + 1).replace(/:[^/]+/g, ':*');
  return `${method} ${path}`;
}

function endpointEffectId(endpoint: string): string {
  const [method, ...path] = endpoint.split(' ');
  return `server.${snake(`${method}_${path.join('_')}`) || method.toLowerCase()}`;
}

function deriveVocab(
  config: VocabConfig,
  setters: SetterDef[],
  actions: ActionDef[],
  commands: CommandDef[],
): { config: VocabConfig; setterMap: Map<string, string>; actionMap: Map<string, string>; commandMap: Map<string, string>; manual: ManualPoolRow[] } {
  const actionMap = new Map<string, string>();
  const setterMap = new Map<string, string>();
  const commandMap = new Map<string, string>();
  const manual: ManualPoolRow[] = [];
  for (const action of actions) actionMap.set(action.id, config.overrides.actions[action.id] ?? action.id);

  const actionCandidates = new Map<string, string[]>();
  for (const action of actions) {
    for (const setter of action.setterCalls) {
      const list = actionCandidates.get(setter) ?? [];
      if (!list.includes(action.id)) list.push(action.id);
      actionCandidates.set(setter, list);
    }
  }
  for (const setter of setters) {
    const override = config.overrides.setters[setter.name];
    const candidates = (actionCandidates.get(setter.name) ?? []).sort();
    if (override) setterMap.set(setter.name, override);
    else if (candidates.length === 1) setterMap.set(setter.name, actionMap.get(candidates[0])!);
    else {
      setterMap.set(setter.name, `store.${snake(setter.name)}`);
      if (candidates.length > 1) {
        manual.push(manualRow(
          'vocab', setter.file, setter.line, 'AppState', 'setter', null, setter.name,
          'setter is used by multiple semantic actions; kept under a technical fallback until classified',
          { candidates },
        ));
      }
    }
  }
  for (const command of commands) {
    const override = config.overrides.commands[command.id];
    if (override) {
      commandMap.set(command.id, override);
      continue;
    }
    if (actionMap.has(command.id)) {
      commandMap.set(command.id, actionMap.get(command.id)!);
      continue;
    }
    const effects = [...new Set(command.setterCalls.map((name) => setterMap.get(name)).filter(Boolean))] as string[];
    if (effects.length === 1) commandMap.set(command.id, effects[0]);
    else {
      const normalized = command.id.split('.').map(snake).join('.');
      commandMap.set(command.id, normalized);
      if (effects.length > 1) {
        manual.push(manualRow(
          'vocab', command.file, command.line, 'builtinCommandsExtension', 'command', null, command.id,
          'command invokes multiple mapped setters; command id retained as canonical fallback',
          { candidates: effects },
        ));
      }
    }
  }
  const next: VocabConfig = {
    version: 1,
    overrides: {
      setters: sortRecord(config.overrides.setters),
      commands: sortRecord(config.overrides.commands),
      actions: sortRecord(config.overrides.actions),
    },
    auto: {
      setters: sortRecord(Object.fromEntries([...setterMap])),
      commands: sortRecord(Object.fromEntries([...commandMap])),
      actions: sortRecord(Object.fromEntries([...actionMap])),
    },
    server_endpoint_overrides: Object.fromEntries(
      Object.entries(config.server_endpoint_overrides ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([effect, endpoints]) => [effect, [...new Set(endpoints)].sort()]),
    ),
  };
  return { config: next, setterMap, actionMap, commandMap, manual };
}

function effectForFetch(endpoint: string, endpointMap: Map<string, string>): string {
  return endpointMap.get(normalizeEndpointKey(endpoint)) ?? endpointEffectId(endpoint);
}

function analyzeHandler(
  handler: any,
  parsed: ParsedFile,
  component: string,
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
  depth = 0,
  seen = new Set<any>(),
): HandlerAnalysis {
  const effects = new Map<string, string[]>();
  const forwardedProps = new Set<string>();
  let owner: ControlOwner = 'us';
  const root = unwrap(handler);
  if (!root || seen.has(root)) return { effects, forwardedProps, owner };
  seen.add(root);

  const merge = (other: HandlerAnalysis, prefix?: string) => {
    for (const [effect, vias] of other.effects) {
      for (const via of vias) addEffect(effects, effect, prefix ? `${prefix}>${via}` : via);
    }
    for (const prop of other.forwardedProps) forwardedProps.add(prop);
    if (other.owner === 'editor') owner = 'editor';
  };

  if (ts.isIdentifier(root)) {
    const local = resolveLocal(parsed, root.text, root);
    if (local && depth < 2) merge(analyzeHandler(local, parsed, component, setterMap, actionMap, commandMap, endpointMap, depth + 1, seen), `fn:${root.text}`);
    else if (/^on[A-Z]/.test(root.text)) forwardedProps.add(root.text);
    return { effects, forwardedProps, owner };
  }
  if (ts.isPropertyAccessExpression(root)) {
    if (/^on[A-Z]/.test(root.name.text)) forwardedProps.add(root.name.text);
    return { effects, forwardedProps, owner };
  }

  visit(root, (node) => {
    if (ts.isPropertyAccessExpression(node) && /^on[A-Z]/.test(node.name.text)) {
      const receiver = nodeName(node.expression);
      if (receiver === 'props' || receiver.endsWith('Props')) forwardedProps.add(node.name.text);
    }
    if (!ts.isCallExpression(node)) return;
    const name = callLastName(node);
    const receiver = receiverName(node);
    if (name === 'dispatchAction') {
      const id = staticString(node.arguments[0]);
      if (id) addEffect(effects, actionMap.get(id) ?? id, `action:${id}`);
      return;
    }
    if (name === 'execute') {
      const id = staticString(node.arguments[0]);
      if (id) addEffect(effects, commandMap.get(id) ?? id.split('.').map(snake).join('.'), `command:${id}`);
      return;
    }
    if (setterMap.has(name)) {
      addEffect(effects, setterMap.get(name)!, `setter:${name}`);
      return;
    }
    if (name === 'fetch') {
      const endpoint = fetchEndpoint(node);
      if (endpoint && /^(POST|PUT|DELETE|PATCH) /.test(endpoint)) {
        addEffect(effects, effectForFetch(endpoint, endpointMap), `endpoint:${endpoint}`);
      }
      return;
    }
    if (name === 'navigate' || name === 'pushState' || name === 'replaceState') {
      addEffect(effects, 'navigation.navigate', `navigation:${name}`);
      return;
    }
    if (name === 'requestFullscreen' || name === 'exitFullscreen') {
      addEffect(effects, 'browser.toggle_fullscreen', `browser:${name}`);
      return;
    }
    if (name === 'writeText') {
      addEffect(effects, 'clipboard.write', 'browser:clipboard.writeText');
      return;
    }
    if (name === 'readText') {
      addEffect(effects, 'clipboard.read', 'browser:clipboard.readText');
      return;
    }
    if (name === 'focus') {
      addEffect(effects, 'focus.set', 'dom:focus');
      return;
    }
    if (name === 'requestComposerInsert') {
      addEffect(effects, 'chat.insert_reference', 'composer:insert');
      return;
    }
    if (name === 'emitForgeaXMessage') {
      addEffect(effects, 'chat.post_message', 'session-client:emitForgeaXMessage');
      return;
    }
    if (name === 'emitDeepLink') {
      const topic = staticString(node.arguments[0]);
      if (topic) {
        const [domain, ...verb] = topic.split(':');
        addEffect(effects, `${snake(domain)}.${snake(verb.join('_'))}`, `deep-link:${topic}`);
      }
      return;
    }
    if (name === 'setActiveWorkbench') {
      addEffect(effects, 'workbench.activate', 'workbench:set_active');
      return;
    }
    if (name === 'dispatch' && /(^|\.)(routerDeps|deps)$/.test(receiver)) {
      const op = unwrap(node.arguments[0]);
      const kind = op && ts.isObjectLiteralExpression(op) ? literalProperty(op, 'kind') : null;
      addEffect(effects, `editor.${snake(kind ?? 'dispatch')}`, `editor-dispatch:${kind ?? 'dynamic'}`);
      owner = 'editor';
      return;
    }
    if (/^on[A-Z]/.test(name) && !parsed.locals.has(name)) {
      // Inline forwarding, e.g. `<button onClick={() => props.onPick(id)}>`.
      // The parent usage is joined later by component+prop name.
      forwardedProps.add(name);
      return;
    }
    if (/(^|\.)(routerDeps|deps)$/.test(receiver) && !/^(get|is)/.test(name)) {
      addEffect(effects, `editor.${snake(name)}`, `editor-callback:${name}`);
      owner = 'editor';
      return;
    }
    if (parsed.localStateSetters.has(name)) {
      addEffect(effects, `${componentDomain(component)}.${snake(name)}`, `local-state:${name}`);
      return;
    }
    const local = resolveLocal(parsed, name, node);
    if (local && depth < 2 && !seen.has(local)) {
      merge(analyzeHandler(local, parsed, component, setterMap, actionMap, commandMap, endpointMap, depth + 1, seen), `fn:${name}`);
    }
  });
  return { effects, forwardedProps, owner };
}

function jsxElementName(node: any): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return nodeName(opening.tagName);
}

function directJsxText(node: any): string {
  const parent = ts.isJsxElement(node.parent) ? node.parent : ts.isJsxSelfClosingElement(node.parent) ? node.parent : null;
  if (!parent || !ts.isJsxElement(parent)) return '';
  const parts: string[] = [];
  for (const child of parent.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    if (ts.isJsxExpression(child) && child.expression) {
      const value = staticString(child.expression);
      if (value !== null) parts.push(value);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function staticJsxAttributes(opening: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = nodeName(attr.name);
    if (!STABLE_JSX_ATTRIBUTES.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) continue;
    if (!attr.initializer) {
      out[name] = 'true';
      continue;
    }
    if (ts.isStringLiteral(attr.initializer)) out[name] = attr.initializer.text;
    else if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      const value = staticString(attr.initializer.expression);
      if (value !== null) out[name] = value;
    }
  }
  return sortRecord(out);
}

function rawJsxHandler(attr: any): any | null {
  if (!attr.initializer) return null;
  if (ts.isJsxExpression(attr.initializer)) return attr.initializer.expression ? unwrap(attr.initializer.expression) : null;
  return null;
}

function ruleMatches(rule: ExclusionRule, file: string, event: string, element: string, call?: string): boolean {
  return (!rule.file || rule.file === file)
    && (!rule.event || rule.event === event)
    && (!rule.element || rule.element === element)
    && (!rule.calls || (call !== undefined && rule.calls.includes(call)));
}

function validateExclusions(exclusions: Exclusions): string[] {
  const issues: string[] = [];
  exclusions.listener_rules.forEach((rule, index) => {
    const label = `listener_rules[${index}]${rule.event ? ` (${rule.event})` : ''}`;
    if (!rule.reason.trim()) issues.push(`${label} is missing reason`);
    if (!rule.verified_applicability?.trim()) issues.push(`${label} is missing verified_applicability`);
    if (rule.calls) {
      if (rule.event !== 'message') issues.push(`${label} uses calls outside the message branch collector`);
      if (!rule.file) issues.push(`${label} uses calls without a file scope`);
      if (rule.calls.length === 0) issues.push(`${label} has an empty calls list`);
      if (new Set(rule.calls).size !== rule.calls.length) issues.push(`${label} has duplicate calls`);
    }
    const windowMessageRule = rule.event === 'message' && (!rule.element || ['window', 'globalThis'].includes(rule.element));
    if (windowMessageRule && (!rule.file || !rule.calls?.length)) {
      issues.push(`${label} must be file- and call-scoped; whole-message exclusions hide independent branches`);
    }
  });
  exclusions.subscription_rules.forEach((rule, index) => {
    const label = `subscription_rules[${index}]${rule.method ? ` (${rule.method})` : ''}`;
    if (!rule.method && !rule.receiver) issues.push(`${label} must scope a method or receiver`);
    if (!rule.reason.trim()) issues.push(`${label} is missing reason`);
    if (!rule.verified_applicability?.trim()) issues.push(`${label} is missing verified_applicability`);
    if (rule.method && NARROW_SUBSCRIPTION_METHODS.has(rule.method)) {
      if (!rule.file) issues.push(`${label} lowercase method-family exclusion must be file-scoped`);
      if (!rule.receiver) issues.push(`${label} lowercase method-family exclusion must be receiver-scoped`);
    }
  });
  return issues;
}

function surfaceForJsx(element: string, event: string, file: string): ControlSurface {
  if (file.endsWith('/StandaloneExtensionIframe.tsx') && element === 'ExtensionIframeHost') return 'rpc-handler';
  if (event === 'onContextMenu' || /Menu(Item|Trigger|Content)?$/.test(element)) return 'menu';
  if (element === 'Command.Item') return 'palette';
  if (element === 'a' || element === 'Link' || element === 'NavLink') return 'link';
  if (element === 'button' || /Button$/.test(element)) return 'button';
  return 'dom';
}

function ownerForShortcut(component: string): ControlOwner {
  return component === 'editShortcuts' ? 'editor' : 'us';
}

function makeRawControl(
  parsed: ParsedFile,
  values: Omit<RawControl, 'repo' | 'repoRelative' | 'file' | 'parsed' | 'ordinal'>,
): RawControl {
  return {
    ...values,
    repo: parsed.repo,
    repoRelative: parsed.repoRelative,
    file: parsed.rel,
    parsed,
    ordinal: 0,
  };
}

function collectJsxControls(
  files: ParsedFile[],
  exclusions: Exclusions,
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): {
  controls: RawControl[];
  rawOnClick: number;
  rawOnClickFiles: number;
  rawOnClickByRepo: Record<string, number>;
  excluded: number;
} {
  const controls: RawControl[] = [];
  let rawOnClick = 0;
  const rawOnClickByRepo: Record<string, number> = {};
  const onClickFiles = new Set<string>();
  let excluded = 0;
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isJsxAttribute(node)) return;
      const event = nodeName(node.name);
      if (!/^on[A-Z]\w*$/.test(event)) return;
      if (event === 'onClick') {
        rawOnClick += 1;
        rawOnClickByRepo[parsed.repo] = (rawOnClickByRepo[parsed.repo] ?? 0) + 1;
        onClickFiles.add(parsed.rel);
      }
      const opening = node.parent?.parent;
      if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) return;
      const element = jsxElementName(opening);
      if (parsed.rel.endsWith('/StandaloneExtensionIframe.tsx') && element === 'ExtensionIframeHost') return;
      const exclusion = exclusions.jsx_event_rules.find((rule) => ruleMatches(rule, parsed.rel, event, element));
      if (exclusion) {
        excluded += 1;
        return;
      }
      const component = enclosingFunctionName(opening);
      const handler = rawJsxHandler(node);
      const analysis = analyzeHandler(handler, parsed, component, setterMap, actionMap, commandMap, endpointMap);
      const custom = !/^[a-z]/.test(element);
      controls.push(makeRawControl(parsed, {
        surface: surfaceForJsx(element, event, parsed.rel),
        event,
        component,
        line: lineOf(parsed.sf, node),
        elementType: element,
        stableAttributes: staticJsxAttributes(opening),
        staticText: directJsxText(opening),
        handler,
        collector: 'react-event-prop',
        propagation: custom ? 'forwarded' : 'direct',
        owner: analysis.owner,
        notes: [custom ? 'custom-component callback retained and traced' : 'intrinsic DOM event'],
        forwardedProps: analysis.forwardedProps,
        effects: analysis.effects,
      }));
    });
  }
  return {
    controls,
    rawOnClick,
    rawOnClickFiles: onClickFiles.size,
    excluded,
    rawOnClickByRepo: sortRecord(rawOnClickByRepo),
  };
}

function collectRpcControls(
  files: ParsedFile[],
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): RawControl[] {
  const controls: RawControl[] = [];
  for (const parsed of files.filter((file) => file.rel.endsWith('/components/MainArea/StandaloneExtensionIframe.tsx'))) {
    visit(parsed.sf, (node) => {
      if (!ts.isJsxAttribute(node)) return;
      const event = nodeName(node.name);
      if (!/^on[A-Z]\w*$/.test(event)) return;
      const opening = node.parent?.parent;
      if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) return;
      if (jsxElementName(opening) !== 'ExtensionIframeHost') return;
      const component = enclosingFunctionName(opening);
      const handler = rawJsxHandler(node);
      const analysis = analyzeHandler(handler, parsed, component, setterMap, actionMap, commandMap, endpointMap);
      controls.push(makeRawControl(parsed, {
        surface: 'rpc-handler',
        event,
        component,
        line: lineOf(parsed.sf, node),
        elementType: 'ExtensionIframeHost',
        stableAttributes: staticJsxAttributes(opening),
        staticText: directJsxText(opening),
        handler,
        collector: 'rpc-handler',
        propagation: 'forwarded',
        owner: analysis.owner,
        notes: ['host-sdk RPC callback retained and traced'],
        forwardedProps: analysis.forwardedProps,
        effects: analysis.effects,
      }));
    });
  }
  return controls;
}

interface MessageEffectBranch {
  call: any;
  callName: string;
  tag: string;
}

function directEffectCall(expression: any): any | null {
  let current = unwrap(expression);
  while (current && ts.isVoidExpression?.(current)) current = unwrap(current.expression);
  if (current && ts.isCallExpression(current)) return current;
  if (
    current
    && ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return directEffectCall(current.right);
  }
  return null;
}

function conditionDiscriminators(condition: any): string[] {
  const values = new Set<string>();
  visit(condition, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) return;
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    const leftStatic = staticString(left);
    const rightStatic = staticString(right);
    if (leftStatic === null && rightStatic !== null && !ts.isTypeOfExpression(left)) values.add(rightStatic);
    if (rightStatic === null && leftStatic !== null && !ts.isTypeOfExpression(right)) values.add(leftStatic);
  });
  return [...values].sort();
}

function negativeGuardDiscriminators(condition: any): string[] {
  const values = new Set<string>();
  visit(condition, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    if (![ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return;
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    const leftStatic = staticString(left);
    const rightStatic = staticString(right);
    if (leftStatic === null && rightStatic !== null && !ts.isTypeOfExpression(left)) values.add(rightStatic);
    if (rightStatic === null && leftStatic !== null && !ts.isTypeOfExpression(right)) values.add(leftStatic);
  });
  return [...values].sort();
}

function statementAlwaysExits(node: any): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (!ts.isBlock(node) || node.statements.length === 0) return false;
  return statementAlwaysExits(node.statements[node.statements.length - 1]);
}

function messageBranchTag(call: any, handler: any): string {
  let current = call.parent;
  while (current && current !== handler) {
    if (ts.isIfStatement(current)) {
      const values = conditionDiscriminators(current.expression);
      if (values.length > 0) return values.join('|');
    }
    if (ts.isCaseClause(current)) {
      const value = staticString(current.expression);
      if (value !== null) return value;
    }
    current = current.parent;
  }
  current = call;
  while (current?.parent && current.parent !== handler) {
    const parent = current.parent;
    if (ts.isBlock(parent)) {
      const index = parent.statements.findIndex((statement: any) => statement.pos <= call.pos && call.end <= statement.end);
      for (let i = index - 1; i >= 0; i -= 1) {
        const prior = parent.statements[i];
        if (!ts.isIfStatement(prior) || !statementAlwaysExits(prior.thenStatement)) continue;
        const values = negativeGuardDiscriminators(prior.expression);
        if (values.length > 0) return values.join('|');
      }
    }
    current = parent;
  }
  return callLastName(call) || 'anonymous-call';
}

/**
 * Return only statement-level calls from a message handler. Calls nested in
 * guards, argument construction, and local callback declarations are not
 * independent effects; prop forwards are filtered after handler analysis.
 */
function messageEffectBranches(handler: any): MessageEffectBranch[] {
  const root = unwrap(handler);
  if (!root) return [];
  const calls: any[] = [];
  const seen = new Set<any>();
  const add = (expression: any) => {
    const call = directEffectCall(expression);
    if (!call || seen.has(call)) return;
    seen.add(call);
    calls.push(call);
  };
  const walk = (node: any): void => {
    if (!node) return;
    if (
      node !== root
      && (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node))
    ) return;
    if (ts.isExpressionStatement(node)) {
      add(node.expression);
      return;
    }
    if (ts.isReturnStatement(node)) {
      if (node.expression) add(node.expression);
      return;
    }
    if (ts.isIfStatement(node)) {
      // A call used as the complete condition can intentionally consume an
      // event (for example `if (ingest(data)) return`). Negated/compound guard
      // calls are not mistaken for effects because directEffectCall rejects
      // those expression shapes.
      add(node.expression);
      walk(node.thenStatement);
      if (node.elseStatement) walk(node.elseStatement);
      return;
    }
    ts.forEachChild(node, (child: any) => walk(child));
  };
  if (ts.isArrowFunction(root) && !ts.isBlock(root.body)) add(root.body);
  walk(root);
  return calls.map((call) => ({
    call,
    callName: callLastName(call) || 'anonymous-call',
    tag: messageBranchTag(call, root),
  }));
}

function collectListenerControls(
  files: ParsedFile[],
  allFiles: Map<string, ParsedFile>,
  exclusions: Exclusions,
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): {
  controls: RawControl[];
  excluded: number;
  constantAudits: ConstantListenerAudit[];
  unresolvedExpressions: number;
  manual: ManualPoolRow[];
} {
  const controls: RawControl[] = [];
  const constantAudits: ConstantListenerAudit[] = [];
  const manual: ManualPoolRow[] = [];
  let excluded = 0;
  let unresolvedExpressions = 0;
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node) || callLastName(node) !== 'addEventListener') return;
      const eventExpression = node.arguments[0];
      const literalExpression = Boolean(eventExpression && (
        ts.isStringLiteral(unwrap(eventExpression)) || ts.isNoSubstitutionTemplateLiteral(unwrap(eventExpression))
      ));
      const events = staticEventNames(parsed, eventExpression, allFiles);
      if (events.length === 0) {
        if (!literalExpression) {
          unresolvedExpressions += 1;
          manual.push(manualRow(
            'listener-event',
            parsed.rel,
            lineOf(parsed.sf, node),
            enclosingFunctionName(node),
            'addEventListener',
            null,
            eventExpression?.getText(parsed.sf) ?? '<missing>',
            'listener event expression is not statically resolvable across the supported local/named-import constant graph',
            { collector: 'event-listener-constant', receiver: receiverName(node) || 'EventTarget' },
          ));
        }
        return;
      }
      const element = receiverName(node) || 'EventTarget';
      const component = enclosingFunctionName(node);
      const handler = unwrap(node.arguments[1]);
      const auditReasons = new Set<string>();
      let collectedEvents = 0;
      let excludedEvents = 0;
      let directBranches = 0;
      for (const event of events) {
        // Only Window's `message` listener is the postMessage command surface.
        // EventSource/WebSocket `message` listeners remain ordinary transport
        // registrations and can be audited/excluded as a whole.
        if (event === 'message' && (element === 'window' || element === 'globalThis')) {
          const messageHandler = handler && ts.isIdentifier(handler)
            ? resolveLocal(parsed, handler.text, handler) ?? handler
            : handler;
          for (const branch of messageEffectBranches(messageHandler)) {
            const analysis = analyzeHandler(branch.call, parsed, component, setterMap, actionMap, commandMap, endpointMap);
            // Prop forwarding is represented by the concrete custom-component
            // callback usage (for example ExtensionIframeHost.onNavigate). The
            // postMessage collector owns only direct, non-prop effects.
            if (analysis.effects.size === 0 && analysis.forwardedProps.size > 0) continue;
            directBranches += 1;
            const exclusion = exclusions.listener_rules.find((rule) => (
              ruleMatches(rule, parsed.rel, event, element, branch.callName)
            ));
            if (exclusion) {
              excluded += 1;
              excludedEvents += 1;
              auditReasons.add(exclusion.reason);
              continue;
            }
            controls.push(makeRawControl(parsed, {
              surface: 'postmessage-handler',
              event: `message:${branch.tag}`,
              component,
              line: lineOf(parsed.sf, branch.call),
              elementType: `listener:${element}:message-branch`,
              stableAttributes: { target: element, branch: branch.tag },
              staticText: '',
              handler: branch.call,
              collector: 'postmessage-handler',
              propagation: 'direct',
              owner: analysis.owner,
              notes: [`direct postMessage branch call ${branch.callName}`],
              forwardedProps: analysis.forwardedProps,
              effects: analysis.effects,
            }));
            collectedEvents += 1;
          }
          continue;
        }
        const exclusion = exclusions.listener_rules.find((rule) => ruleMatches(rule, parsed.rel, event, element));
        if (exclusion) {
          excluded += 1;
          excludedEvents += 1;
          auditReasons.add(exclusion.reason);
          continue;
        }
        const analysis = analyzeHandler(handler, parsed, component, setterMap, actionMap, commandMap, endpointMap);
        controls.push(makeRawControl(parsed, {
          surface: event === 'contextmenu' ? 'menu' : event === 'keydown' ? 'shortcut' : 'dom',
          event,
          component,
          line: lineOf(parsed.sf, node),
          elementType: `listener:${element}`,
          stableAttributes: { target: element, capture: staticString(node.arguments[2]) ?? '' },
          staticText: '',
          handler,
          collector: 'event-listener',
          propagation: 'direct',
          owner: analysis.owner,
          notes: ['source-level addEventListener registration'],
          forwardedProps: analysis.forwardedProps,
          effects: analysis.effects,
        }));
        collectedEvents += 1;
      }
      if (!literalExpression) {
        const disposition = collectedEvents > 0 && excludedEvents > 0
          ? 'mixed'
          : collectedEvents > 0
            ? 'collected'
            : excludedEvents > 0
              ? 'excluded'
              : directBranches === 0
                ? 'no-direct-effect'
                : 'collected';
        constantAudits.push({
          repo: parsed.repo,
          file: parsed.rel,
          line: lineOf(parsed.sf, node),
          expression: eventExpression?.getText(parsed.sf) ?? '<missing>',
          events,
          disposition,
          reasons: [...auditReasons].sort(),
        });
      }
    });
  }
  return {
    controls,
    excluded,
    constantAudits: constantAudits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    unresolvedExpressions,
    manual: manual.sort((a, b) => a.manual_id.localeCompare(b.manual_id)),
  };
}

function isSubscriptionCallback(node: any): boolean {
  return Boolean(
    node
    && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node)),
  );
}

function subscriptionCallback(
  call: any,
  family: SubscriptionCandidateAudit['family'],
): any | null {
  if (family === 'lowercase-method') {
    const candidate = unwrap(call.arguments[call.arguments.length - 1]);
    return isSubscriptionCallback(candidate) ? candidate : null;
  }
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const candidate = unwrap(call.arguments[index]);
    if (isSubscriptionCallback(candidate)) return candidate;
  }
  return null;
}

function subscriptionReceiver(call: any): string {
  const expression = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(expression)) return '';
  return nodeName(unwrap(expression.expression));
}

function subscriptionTopic(call: any): string | null {
  return staticString(call.arguments[0]);
}

function subscriptionFamily(method: string): SubscriptionCandidateAudit['family'] | null {
  if (/^on[A-Z]\w*$/.test(method)) return 'on-xxx';
  if (NARROW_SUBSCRIPTION_METHODS.has(method)) return 'lowercase-method';
  return null;
}

function subscriptionRuleMatches(
  rule: ExclusionRule,
  file: string,
  method: string,
  receiver: string,
  topic: string | null,
): boolean {
  return (!rule.file || rule.file === file)
    && (!rule.event || rule.event === topic)
    && (!rule.method || rule.method === method)
    && (!rule.receiver || rule.receiver === receiver);
}

function collectSubscriptionControls(
  files: ParsedFile[],
  exclusions: Exclusions,
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): { controls: RawControl[]; excluded: number; audits: SubscriptionCandidateAudit[] } {
  const controls: RawControl[] = [];
  const audits: SubscriptionCandidateAudit[] = [];
  let excluded = 0;
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const expression = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(expression)) return;
      const method = expression.name.text;
      const family = subscriptionFamily(method);
      if (!family) return;
      const handler = subscriptionCallback(node, family);
      if (!handler) return;
      const receiver = subscriptionReceiver(node) || 'unknown';
      const topic = subscriptionTopic(node);
      const auditBase = {
        family,
        file: parsed.rel,
        evidence_line: lineOf(parsed.sf, node),
        receiver,
        method,
        topic,
      } as const;
      const exclusion = exclusions.subscription_rules.find((rule) => (
        subscriptionRuleMatches(rule, parsed.rel, method, receiver, topic)
      ));
      if (exclusion) {
        excluded += 1;
        audits.push({
          ...auditBase,
          disposition: 'excluded',
          exclusion_reason: exclusion.reason,
          verified_applicability: exclusion.verified_applicability ?? null,
        });
        return;
      }
      audits.push({
        ...auditBase,
        disposition: 'collected',
        exclusion_reason: null,
        verified_applicability: null,
      });
      const component = enclosingFunctionName(node);
      const analysis = analyzeHandler(handler, parsed, component, setterMap, actionMap, commandMap, endpointMap);
      controls.push(makeRawControl(parsed, {
        surface: 'subscription-handler',
        event: method,
        component,
        line: lineOf(parsed.sf, node),
        elementType: `subscription:${receiver}`,
        stableAttributes: { receiver, method, ...(topic === null ? {} : { topic }) },
        staticText: '',
        handler,
        collector: 'subscription-handler',
        propagation: 'direct',
        owner: analysis.owner,
        notes: [
          family === 'lowercase-method'
            ? `narrow lowercase subscription ${receiver}.${method}${topic === null ? '' : `(${topic})`}`
            : `custom subscription ${receiver}.${method}`,
        ],
        forwardedProps: analysis.forwardedProps,
        effects: analysis.effects,
      }));
    });
  }
  return {
    controls,
    excluded,
    audits: audits.sort((a, b) => a.file.localeCompare(b.file) || a.evidence_line - b.evidence_line),
  };
}

function methodSubscriptionKey(row: {
  file: string;
  line?: number;
  evidence_line?: number;
  receiver: string;
  method: string;
  topic: string | null;
}): string {
  return JSON.stringify({
    file: row.file,
    line: row.line ?? row.evidence_line,
    receiver: row.receiver,
    method: row.method,
    topic: row.topic,
  });
}

function reviewMethodSubscriptionCandidates(
  candidates: SubscriptionCandidateAudit[],
  controls: ControlRow[],
  rules: ExclusionRule[],
): MethodSubscriptionAudit[] {
  const narrow = candidates.filter((row): row is SubscriptionCandidateAudit & { family: 'lowercase-method' } => (
    row.family === 'lowercase-method'
  ));
  const narrowRules = rules.filter((rule) => rule.method !== undefined && NARROW_SUBSCRIPTION_METHODS.has(rule.method));
  const issues: string[] = [];

  for (const rule of narrowRules) {
    const matches = narrow.filter((row) => subscriptionRuleMatches(
      rule,
      row.file,
      row.method,
      row.receiver,
      row.topic,
    ));
    const label = `${rule.file ?? '*'}:${rule.receiver ?? '*'}.${rule.method ?? '*'}(${rule.event ?? '*'})`;
    if (matches.length !== 1) {
      issues.push(`signed lowercase subscription exclusion ${label} matched ${matches.length} candidates (expected exactly 1)`);
    } else if (matches[0].disposition !== 'excluded') {
      issues.push(`signed lowercase subscription exclusion ${label} did not exclude its candidate`);
    }
  }

  const reviewsByKey = new Map<string, RetainedMethodSubscriptionReview>();
  for (const review of RETAINED_METHOD_SUBSCRIPTION_REVIEWS) {
    const key = methodSubscriptionKey(review);
    if (reviewsByKey.has(key)) issues.push(`duplicate retained lowercase subscription review: ${key}`);
    reviewsByKey.set(key, review);
  }

  const reviewed: MethodSubscriptionAudit[] = [];
  for (const candidate of narrow) {
    const matchingRules = narrowRules.filter((rule) => subscriptionRuleMatches(
      rule,
      candidate.file,
      candidate.method,
      candidate.receiver,
      candidate.topic,
    ));
    const control = controls.find((row) => (
      row.surface === 'subscription-handler'
      && row.file === candidate.file
      && row.evidence_line === candidate.evidence_line
      && row.event === candidate.method
    ));
    if (candidate.disposition === 'excluded') {
      if (matchingRules.length !== 1) {
        issues.push(`${candidate.file}:${candidate.evidence_line} is excluded without exactly one signed lowercase method-family rule`);
      }
      if (control) issues.push(`${candidate.file}:${candidate.evidence_line} is both excluded and collected`);
      reviewed.push({
        ...candidate,
        decision: 'infrastructure-plumbing',
        rationale: candidate.exclusion_reason ?? 'missing exclusion reason',
        control_id: null,
        effect_id: null,
        propagation: null,
      });
      continue;
    }

    const key = methodSubscriptionKey(candidate);
    const review = reviewsByKey.get(key);
    if (!review) {
      issues.push(`${candidate.file}:${candidate.evidence_line} is a collected lowercase subscription without a human review`);
      continue;
    }
    reviewsByKey.delete(key);
    if (!control) {
      issues.push(`${candidate.file}:${candidate.evidence_line} passed collection but has no control row`);
      continue;
    }
    if (review.decision === 'real-user-entry' && (control.effect_id === null || control.propagation === 'manual-pool')) {
      issues.push(`${candidate.file}:${candidate.evidence_line} was reviewed as a real user entry but its effect is unresolved`);
    }
    if (review.decision === 'effect-unclear' && (control.effect_id !== null || control.propagation !== 'manual-pool')) {
      issues.push(`${candidate.file}:${candidate.evidence_line} was reviewed for the manual pool but now resolves to ${control.effect_id}`);
    }
    reviewed.push({
      ...candidate,
      decision: review.decision,
      rationale: review.rationale,
      control_id: control.control_id,
      effect_id: control.effect_id,
      propagation: control.propagation,
    });
  }

  for (const review of reviewsByKey.values()) {
    issues.push(`retained lowercase subscription review has no collected candidate: ${review.file}:${review.line}`);
  }
  if (issues.length > 0) throw new Error(`lowercase subscription audit failed:\n${issues.join('\n')}`);
  return reviewed.sort((a, b) => a.file.localeCompare(b.file) || a.evidence_line - b.evidence_line);
}

function providerCallbackSummary(property: string, handler: any): string {
  const calls: string[] = [];
  visit(handler, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = nodeName(unwrap(node.expression));
    if (name && !calls.includes(name)) calls.push(name);
  });
  const suffix = calls.length > 0 ? ` invokes ${calls.slice(0, 4).join(', ')}` : ' inline callback';
  return `${property}${suffix}`;
}

function forgeaxImportDomain(source: string): string | null {
  const match = source.match(/^@forgeax\/([^/]+)/);
  if (!match) return null;
  return snake(match[1].replace(/-(core|runtime)$/, ''));
}

function collectProviderDiBranches(files: ParsedFile[]): ProviderDiBranch[] {
  const branches: ProviderDiBranch[] = [];
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = callLastName(node);
      const imported = parsed.imports.get(callee);
      const targetDomain = imported ? forgeaxImportDomain(imported.source) : null;
      if (!imported || !targetDomain || targetDomain === parsed.repo) return;
      for (const argument of node.arguments) {
        const object = unwrap(argument);
        if (!object || !ts.isObjectLiteralExpression(object)) continue;
        for (const property of object.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const handler = unwrap(property.initializer);
          if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) continue;
          const propertyName = nodeName(property.name);
          if (!propertyName) continue;
          branches.push({
            repo: parsed.repo,
            file: parsed.rel,
            line: lineOf(parsed.sf, property),
            component: enclosingFunctionName(node),
            callee,
            importSource: imported.source,
            targetDomain,
            property: propertyName,
            handler,
            summary: providerCallbackSummary(propertyName, handler),
          });
        }
      }
    });
  }
  return branches.sort((a, b) => (
    a.file.localeCompare(b.file) || a.line - b.line || a.property.localeCompare(b.property)
  ));
}

function providerAssociationKeys(property: string): Set<string> {
  const names = new Set([property]);
  let current = property;
  for (const prefix of ['confirm', 'guard', 'validate', 'before', 'after', 'request', 'handle']) {
    const match = current.match(new RegExp(`^${prefix}([A-Z].+)$`));
    if (!match) continue;
    current = `${match[1][0].toLowerCase()}${match[1].slice(1)}`;
    names.add(current);
    break;
  }
  for (const name of [...names]) {
    const stripped = name.replace(/(Callback|Handler|Guard)$/, '');
    if (stripped) names.add(stripped);
  }
  return new Set([...names].map(snake).filter(Boolean));
}

function annotateProviderDiBranches(
  branches: ProviderDiBranch[],
  controls: ControlRow[],
  edges: EdgeRow[],
): { annotations: number; manual: ManualPoolRow[] } {
  const controlsById = new Map(controls.map((row) => [row.control_id, row]));
  const manual: ManualPoolRow[] = [];
  let annotations = 0;
  for (const branch of branches) {
    const keys = providerAssociationKeys(branch.property);
    const matchingControlIds = new Set(edges.filter((edge) => {
      if (!edge.effect_id.startsWith(`${branch.targetDomain}.`)) return false;
      const effectKey = edge.effect_id.split('.').at(-1) ?? '';
      if (keys.has(effectKey)) return true;
      return edge.via.some((via) => {
        const callbacks = [...via.matchAll(/editor-callback:([A-Za-z0-9_$]+)/g)];
        return callbacks.some((match) => keys.has(snake(match[1])));
      });
    }).map((edge) => edge.control_id));
    if (matchingControlIds.size === 1) {
      const controlIdValue = [...matchingControlIds][0];
      const control = controlsById.get(controlIdValue);
      if (!control) throw new Error(`provider-DI association target missing: ${controlIdValue}`);
      control.notes += `; di_provider_branch=${branch.file}:${branch.line} ${branch.summary}`;
      annotations += 1;
      continue;
    }
    manual.push(manualRow(
      'provider-di',
      branch.file,
      branch.line,
      branch.component,
      branch.property,
      null,
      `${branch.callee}({ ${branch.property}: callback })`,
      matchingControlIds.size === 0
        ? 'cross-package provider-DI callback has no statically name-correlated consumer control'
        : 'cross-package provider-DI callback correlates to multiple consumer controls and is not unique',
      {
        collector: 'provider-di',
        import_source: branch.importSource,
        target_domain: branch.targetDomain,
        summary: branch.summary,
        candidate_control_ids: [...matchingControlIds].sort(),
      },
    ));
  }
  return { annotations, manual: manual.sort((a, b) => a.manual_id.localeCompare(b.manual_id)) };
}

function mappedTemplateValues(node: any): Array<Record<string, string>> {
  let p = node.parent;
  while (p && !ts.isCallExpression(p)) p = p.parent;
  if (!p || callLastName(p) !== 'map') return [{}];
  const expr = unwrap(p.expression);
  if (!ts.isPropertyAccessExpression(expr)) return [{}];
  const arrayExpr = unwrap(expr.expression);
  if (!ts.isArrayLiteralExpression(arrayExpr)) return [{}];
  const callback = unwrap(p.arguments[0]);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return [{}];
  const param = callback.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return [{}];
  const values = arrayExpr.elements.map((el: any) => staticString(el)).filter((v: string | null): v is string => v !== null);
  return values.map((value: string) => ({ [param.text]: value }));
}

function shortcutCombo(node: any, substitutions: Record<string, string>): string | null {
  const exact = staticString(node, substitutions);
  if (exact !== null) return exact;
  const value = unwrap(node);
  if (!value || !ts.isConditionalExpression(value)) return null;
  const whenTrue = staticString(value.whenTrue, substitutions);
  const whenFalse = staticString(value.whenFalse, substitutions);
  if (!whenTrue || !whenFalse) return null;
  const condition = value.condition.getText();
  return condition === 'isMac'
    ? `${whenTrue} (macOS) / ${whenFalse} (other)`
    : `${whenTrue} / ${whenFalse}`;
}

function collectShortcutControls(
  files: ParsedFile[],
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): RawControl[] {
  const controls: RawControl[] = [];
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const comboProp = propertyOf(node, 'combo');
      const runProp = propertyOf(node, 'run');
      if (!comboProp || !runProp) return;
      const component = enclosingFunctionName(node);
      const run = unwrap(propertyValue(runProp));
      for (const substitutions of mappedTemplateValues(node)) {
        const combo = shortcutCombo(propertyValue(comboProp), substitutions);
        if (!combo) continue;
        const analysis = analyzeHandler(run, parsed, component, setterMap, actionMap, commandMap, endpointMap);
        const owner = ownerForShortcut(component) === 'editor' ? 'editor' : analysis.owner;
        const editorInjected = component === 'editShortcuts' || owner === 'editor';
        controls.push(makeRawControl(parsed, {
          surface: 'shortcut',
          event: combo,
          component,
          line: lineOf(parsed.sf, node),
          elementType: 'shortcut',
          stableAttributes: {
            combo,
            group: literalProperty(node, 'group') ?? '',
            label: staticString(propertyValue(propertyOf(node, 'label')), substitutions) ?? '',
          },
          staticText: staticString(propertyValue(propertyOf(node, 'label')), substitutions) ?? '',
          handler: run,
          collector: 'shortcut',
          propagation: component === 'editShortcuts' ? 'forwarded' : 'direct',
          owner,
          notes: [editorInjected ? 'editor-injected via routerDeps' : 'shell-owned combo'],
          forwardedProps: analysis.forwardedProps,
          effects: analysis.effects,
        }));
      }
    });
  }
  return controls;
}

function collectLinks(files: ParsedFile[]): RawControl[] {
  const controls: RawControl[] = [];
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const element = jsxElementName(node);
      if (!['a', 'Link', 'NavLink'].includes(element)) return;
      const attrName = element === 'a' ? 'href' : 'to';
      const prop = node.attributes.properties.find((p: any) => ts.isJsxAttribute(p) && nodeName(p.name) === attrName);
      if (!prop || !ts.isJsxAttribute(prop)) return;
      const target = prop.initializer && ts.isStringLiteral(prop.initializer)
        ? prop.initializer.text
        : prop.initializer && ts.isJsxExpression(prop.initializer)
          ? staticString(prop.initializer.expression)
          : null;
      const effects = new Map<string, string[]>();
      const targetEvidence = target ?? `dynamic:${prop.initializer?.getText() ?? attrName}`;
      addEffect(effects, 'navigation.navigate', `link:${targetEvidence}`);
      controls.push(makeRawControl(parsed, {
        surface: 'link',
        event: 'navigate',
        component: enclosingFunctionName(node),
        line: lineOf(parsed.sf, node),
        elementType: element,
        stableAttributes: staticJsxAttributes(node),
        staticText: directJsxText(node),
        handler: null,
        collector: 'navigation-link',
        propagation: 'direct',
        owner: 'us',
        notes: [target ? `static navigation target ${target}` : `dynamic navigation target ${targetEvidence}`],
        forwardedProps: new Set(),
        effects,
      }));
    });
  }
  return controls;
}

function collectMenuObjects(
  files: ParsedFile[],
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): RawControl[] {
  const controls: RawControl[] = [];
  for (const parsed of files.filter((file) => /menu/i.test(file.rel))) {
    visit(parsed.sf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const click = propertyOf(node, 'onClick');
      const action = propertyOf(node, 'action');
      const handlerProp = click ?? action;
      if (!handlerProp) return;
      const kind = literalProperty(node, 'kind');
      if (kind && kind !== 'item') return;
      const handler = unwrap(propertyValue(handlerProp));
      const component = enclosingFunctionName(node);
      const analysis = analyzeHandler(handler, parsed, component, setterMap, actionMap, commandMap, endpointMap);
      const label = staticString(propertyValue(propertyOf(node, 'label')))
        ?? staticString(propertyValue(propertyOf(node, 'text')))
        ?? '';
      controls.push(makeRawControl(parsed, {
        surface: 'menu',
        event: nodeName(handlerProp.name),
        component,
        line: lineOf(parsed.sf, node),
        elementType: 'native-menu-item',
        stableAttributes: { label, kind: kind ?? 'item' },
        staticText: label,
        handler,
        collector: 'native-menu',
        propagation: 'direct',
        owner: analysis.owner,
        notes: ['menu item object callback'],
        forwardedProps: analysis.forwardedProps,
        effects: analysis.effects,
      }));
    });
    // Dockview also accepts built-in menu ids as direct array items. They have
    // no callback object but are still concrete human operations.
    visit(parsed.sf, (node) => {
      if (!ts.isArrayLiteralExpression(node) || enclosingFunctionName(node) !== 'buildTabContextMenuItems') return;
      for (const element of node.elements) {
        const id = staticString(element);
        if (!id || id === 'separator' || !['close', 'closeOthers', 'closeAll'].includes(id)) continue;
        const effects = new Map<string, string[]>();
        addEffect(effects, `panel.${snake(id)}`, `dockview-menu:${id}`);
        controls.push(makeRawControl(parsed, {
          surface: 'menu',
          event: 'action',
          component: 'buildTabContextMenuItems',
          line: lineOf(parsed.sf, element),
          elementType: 'native-menu-item',
          stableAttributes: { id },
          staticText: id,
          handler: null,
          collector: 'native-menu',
          propagation: 'direct',
          owner: 'us',
          notes: ['dockview built-in context menu item'],
          forwardedProps: new Set(),
          effects,
        }));
      }
    });
  }
  return controls;
}

function collectUseSurfaceControls(
  files: ParsedFile[],
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
): { controls: RawControl[]; callSites: number } {
  const controls: RawControl[] = [];
  let callSites = 0;
  for (const parsed of files) {
    visit(parsed.sf, (node) => {
      if (!ts.isCallExpression(node) || callLastName(node) !== 'useSurface') return;
      // Filter the declaration itself: only call expressions can arrive here.
      const opts = unwrap(node.arguments[0]);
      const surfaceId = opts && ts.isObjectLiteralExpression(opts) ? literalProperty(opts, 'id') : null;
      const actions = opts && ts.isObjectLiteralExpression(opts) ? unwrap(propertyValue(propertyOf(opts, 'actions'))) : null;
      if (!surfaceId || !actions || !ts.isObjectLiteralExpression(actions)) return;
      callSites += 1;
      for (const prop of actions.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
        const actionName = nodeName(prop.name);
        const def = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : null;
        const run = def && ts.isObjectLiteralExpression(def) ? unwrap(propertyValue(propertyOf(def, 'run'))) : null;
        const component = enclosingFunctionName(node);
        const analysis = analyzeHandler(run, parsed, component, setterMap, actionMap, commandMap, endpointMap);
        if (analysis.effects.size === 0) addEffect(analysis.effects, `surface.${snake(surfaceId)}_${snake(actionName)}`, `useSurface:${surfaceId}.${actionName}`);
        controls.push(makeRawControl(parsed, {
          surface: 'dom',
          event: actionName,
          component,
          line: lineOf(parsed.sf, prop),
          elementType: 'useSurface-action',
          stableAttributes: { surfaceId, action: actionName },
          staticText: actionName,
          handler: run,
          collector: 'use-surface',
          propagation: 'direct',
          owner: analysis.owner,
          notes: ['real useSurface call action'],
          forwardedProps: analysis.forwardedProps,
          effects: analysis.effects,
        }));
      }
    });
  }
  return { controls, callSites };
}

function collectCommandControls(files: Map<string, ParsedFile>, commands: CommandDef[], commandMap: Map<string, string>): RawControl[] {
  return commands.map((command) => {
    const parsed = files.get(command.file);
    if (!parsed) throw new Error(`command registration source missing: ${command.file}`);
    const effects = new Map<string, string[]>();
    addEffect(effects, commandMap.get(command.id)!, `command:${command.id}`);
    return makeRawControl(parsed, {
      surface: 'palette',
      event: 'execute',
      component: 'builtinCommandsExtension',
      line: command.line,
      elementType: 'command-bus-command',
      stableAttributes: { id: command.id, title: command.title },
      staticText: command.title,
      handler: command.execute,
      collector: 'command-bus',
      propagation: 'direct',
      owner: 'us',
      notes: ['builtin command bus declaration'],
      forwardedProps: new Set(),
      effects,
    });
  });
}

function collectPaletteControls(files: Map<string, ParsedFile>, actions: ActionDef[], actionMap: Map<string, string>): RawControl[] {
  return actions.map((action) => {
    const parsed = files.get(action.file);
    if (!parsed) throw new Error(`action registration source missing: ${action.file}`);
    const effects = new Map<string, string[]>();
    addEffect(effects, actionMap.get(action.id)!, `action:${action.id}`);
    return makeRawControl(parsed, {
      surface: 'palette',
      event: 'select',
      component: 'CommandPalette',
      line: action.line,
      elementType: 'action-registry-item',
      stableAttributes: { id: action.id, title: action.title },
      staticText: action.title,
      handler: action.run,
      collector: 'action-palette',
      propagation: 'direct',
      owner: 'us',
      notes: ['ActionRegistry-derived command palette path; evidence is the registerAction call'],
      forwardedProps: new Set(),
      effects,
    });
  });
}

function assignOrdinals(controls: RawControl[]): void {
  const counts = new Map<string, number>();
  controls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.event.localeCompare(b.event));
  for (const control of controls) {
    const key = JSON.stringify({
      repo: control.repo,
      path: control.repoRelative,
      component: control.component,
      event: control.event,
      element: control.elementType,
      attrs: sortRecord(control.stableAttributes),
      text: control.staticText.replace(/\s+/g, ' ').trim(),
    });
    const ordinal = counts.get(key) ?? 0;
    control.ordinal = ordinal;
    counts.set(key, ordinal + 1);
  }
}

function propagateCallbacks(controls: RawControl[]): void {
  // Iterate to a fixed point so a wrapper→wrapper→DOM chain still resolves;
  // each individual join remains the required one-layer component/prop edge.
  for (let pass = 0; pass < controls.length; pass += 1) {
    const usageEffects = new Map<string, Map<string, string[]>>();
    for (const control of controls) {
      if (!/^[A-Z]/.test(control.elementType) || control.effects.size === 0) continue;
      const key = `${control.elementType.split('.').at(-1)}|${control.event}`;
      const merged = usageEffects.get(key) ?? new Map<string, string[]>();
      for (const [effect, vias] of control.effects) {
        for (const via of vias) addEffect(merged, effect, `parent:${control.component}>${via}`);
      }
      usageEffects.set(key, merged);
    }
    let changed = false;
    for (const control of controls) {
      if (control.effects.size > 0 || control.forwardedProps.size === 0) continue;
      for (const prop of control.forwardedProps) {
        const key = `${control.component}|${prop}`;
        const parent = usageEffects.get(key);
        if (!parent) continue;
        for (const [effect, vias] of parent) {
          for (const via of vias) addEffect(control.effects, effect, `forward:${prop}>${via}`);
        }
      }
      if (control.effects.size > 0) {
        changed = true;
        control.propagation = 'forwarded';
        control.notes.push('resolved through component callback forwarding');
      }
    }
    if (!changed) break;
  }
}

function manualRow(
  kind: ManualPoolRow['kind'],
  file: string,
  evidenceLine: number,
  component: string,
  event: string,
  controlIdValue: string | null,
  candidate: string,
  reason: string,
  details: Record<string, unknown>,
): ManualPoolRow {
  const stable = JSON.stringify({ kind, file, evidenceLine, component, event, controlIdValue, candidate, reason });
  return {
    manual_id: `manual_${hash(stable).slice(0, 20)}`,
    kind,
    file,
    evidence_line: evidenceLine,
    component,
    event,
    control_id: controlIdValue,
    candidate,
    reason,
    details,
  };
}

function effectAccumulator(map: Map<string, EffectAccumulator>, id: string): EffectAccumulator {
  let value = map.get(id);
  if (!value) {
    value = {
      repos: new Set(),
      setters: new Set(),
      commands: new Set(),
      actions: new Set(),
      endpoints: new Set(),
      actionDefs: [],
      toolIds: new Set(),
      headless: false,
    };
    map.set(id, value);
  }
  return value;
}

function extractHeadless(files: Map<string, ParsedFile>): Set<string> {
  const parsed = files.get('packages/orchestrator/src/kernel/ui-headless-actions.ts');
  if (!parsed) return new Set();
  const out = new Set<string>();
  visit(parsed.sf, (node) => {
    if (!ts.isPropertyAssignment(node) || nodeName(node.name) !== 'actionId') return;
    const id = staticString(node.initializer);
    if (id) out.add(id);
  });
  return out;
}

function controlsToRows(controls: RawControl[]): { rows: ControlRow[]; edges: EdgeRow[]; manual: ManualPoolRow[] } {
  assignOrdinals(controls);
  propagateCallbacks(controls);
  const rows: ControlRow[] = [];
  const edges: EdgeRow[] = [];
  const manual: ManualPoolRow[] = [];
  for (const control of controls) {
    const id = controlId({
      repo: control.repo,
      relativePath: control.repoRelative,
      component: control.component,
      event: control.event,
      elementType: control.elementType,
      stableAttributes: control.stableAttributes,
      staticText: control.staticText,
      ordinal: control.ordinal,
    });
    const effectIds = [...control.effects.keys()].sort();
    const unresolved = effectIds.length === 0;
    const primary = effectIds[0] ?? null;
    const notes = [...control.notes];
    notes.push(`source=${control.collector}`);
    if (effectIds.length > 1) notes.push(`primary effect plus ${effectIds.length - 1} additional edge(s)`);
    if (unresolved) notes.push('requires manual classification');
    rows.push({
      control_id: id,
      repo: control.repo as UiRepo,
      surface: control.surface,
      event: control.event,
      component: control.component,
      file: control.file,
      evidence_line: control.line,
      effect_id: primary,
      propagation: unresolved ? 'manual-pool' : control.propagation,
      owner: control.owner,
      notes: notes.join('; '),
    });
    if (unresolved) {
      manual.push(manualRow(
        'control', control.file, control.line, control.component, control.event, id,
        control.elementType,
        control.forwardedProps.size > 0
          ? 'custom callback forwarding target has no statically resolvable parent business handler'
          : 'handler has no recognized store/action/command/navigation/server/local-state effect within two call layers',
        { forwardedProps: [...control.forwardedProps].sort(), collector: control.collector },
      ));
    } else {
      for (const effectId of effectIds) {
        edges.push({
          control_id: id,
          effect_id: effectId,
          propagation: control.propagation,
          via: [...control.effects.get(effectId)!].sort(),
          evidence_line: control.line,
        });
      }
    }
  }
  return {
    rows: rows.sort((a, b) => a.control_id.localeCompare(b.control_id)),
    edges: edges.sort((a, b) => a.control_id.localeCompare(b.control_id) || a.effect_id.localeCompare(b.effect_id)),
    manual: manual.sort((a, b) => a.manual_id.localeCompare(b.manual_id)),
  };
}

function buildEffects(
  setters: SetterDef[],
  actions: ActionDef[],
  commands: CommandDef[],
  endpoints: EndpointDef[],
  controls: ControlRow[],
  edges: EdgeRow[],
  setterMap: Map<string, string>,
  actionMap: Map<string, string>,
  commandMap: Map<string, string>,
  endpointMap: Map<string, string>,
  headlessIds: Set<string>,
): EffectRow[] {
  const map = new Map<string, EffectAccumulator>();
  for (const setter of setters) {
    const acc = effectAccumulator(map, setterMap.get(setter.name)!);
    acc.setters.add(setter.name);
    acc.repos.add(setter.repo);
  }
  for (const action of actions) {
    const effect = actionMap.get(action.id)!;
    const acc = effectAccumulator(map, effect);
    acc.repos.add(action.repo);
    acc.actions.add(action.id);
    acc.actionDefs.push(action);
    for (const endpoint of action.endpoints) acc.endpoints.add(endpoint);
    // A literal toolId in an action body is not evidence that the tool is
    // exposedToAI (role.create deliberately calls a user-only tool). With no
    // team manifests under packages/orchestrator, exposed tool ids remain runtime-fill.
    if (headlessIds.has(action.id)) acc.headless = true;
  }
  for (const command of commands) {
    const acc = effectAccumulator(map, commandMap.get(command.id)!);
    acc.commands.add(command.id);
    acc.repos.add(command.repo);
  }
  for (const endpoint of endpoints) {
    const wire = `${endpoint.method} ${endpoint.path}`;
    const effect = endpointMap.get(normalizeEndpointKey(wire)) ?? endpointEffectId(wire);
    const acc = effectAccumulator(map, effect);
    acc.endpoints.add(wire);
    acc.repos.add(endpoint.repo);
  }
  const controlRepos = new Map(controls.map((control) => [control.control_id, control.repo]));
  for (const edge of edges) {
    const acc = effectAccumulator(map, edge.effect_id);
    const repo = controlRepos.get(edge.control_id);
    if (repo) acc.repos.add(repo);
  }
  // Controls with null effects intentionally do not mint speculative effects.
  void controls;

  const rows: EffectRow[] = [];
  for (const [effectId, acc] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const action = acc.actionDefs.sort((a, b) => a.id.localeCompare(b.id))[0];
    const headless: 'yes' | 'no' | 'n-a' = acc.headless
      ? 'yes'
      : action && (action.surface === 'server' || action.surface === 'both')
        ? 'no'
        : 'n-a';
    rows.push({
      effect_id: effectId,
      repo: [...acc.repos].sort(),
      vocab: {
        setters: [...acc.setters].sort(),
        commands: [...acc.commands].sort(),
        actions: [...acc.actions].sort(),
      },
      agent_equiv: {
        ...(action
          ? {
              action: {
                id: action.id,
                capability: action.capability,
                surface: action.surface,
                firstClass: action.firstClass,
              },
            }
          : {}),
        tool: {
          ids: [...acc.toolIds].sort(),
          runtime_fill: true,
          source: 'GET /api/tools (marketplace manifests intentionally excluded; no team manifest lives under packages/orchestrator)',
        },
        headless,
      },
      server_endpoints: [...acc.endpoints].sort(),
      domain: effectId.split('.')[0],
    });
  }
  return rows;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function liveCombo(root: string): Record<string, string> {
  const rootSha = git(root, ['rev-parse', 'HEAD']);
  const out: Record<string, string> = { studio: rootSha };
  const raw = git(root, ['submodule', 'status', '--recursive']);
  for (const line of raw.split('\n')) {
    const match = line.match(/^[ +\-U]?([0-9a-f]{40})\s+([^\s]+)/);
    if (!match) continue;
    const path = match[2];
    const key = path.startsWith('packages/') ? path.slice('packages/'.length).replaceAll('/', ':') : path.replaceAll('/', ':');
    out[key] = match[1];
  }
  return sortRecord(out);
}

function scannedProductCombo(root: string): Record<string, string> {
  const pinnedMetaPath = join(root, 'docs/ai-native/baseline', PINNED_PRODUCT_BASELINE_ID, 'meta.json');
  if (!existsSync(pinnedMetaPath)) throw new Error(`pinned product combo source missing: ${pinnedMetaPath}`);
  const pinnedMeta = JSON.parse(readFileSync(pinnedMetaPath, 'utf8')) as {
    combo?: Record<string, string>;
    scanned_product_combo?: Record<string, string>;
  };
  const pinned = pinnedMeta.scanned_product_combo ?? pinnedMeta.combo;
  if (!pinned?.studio) throw new Error(`pinned product combo is malformed: ${pinnedMetaPath}`);

  // Root HEAD may advance for docs/scanner/gate work. Prove that no product
  // path changed before retaining the original product SHA in the combo.
  const rootChanges = git(root, ['diff', '--name-only', pinned.studio, 'HEAD', '--'])
    .split('\n')
    .filter(Boolean)
    .filter((path) => path !== 'package.json' && !path.startsWith('docs/') && !path.startsWith('scripts/'));
  if (rootChanges.length > 0) {
    throw new Error(`root product code differs from pinned ${pinned.studio}: ${rootChanges.join(', ')}`);
  }

  const live = liveCombo(root);
  const mismatches = Object.entries(pinned)
    .filter(([repo]) => repo !== 'studio')
    .filter(([repo, sha]) => live[repo] !== sha)
    .map(([repo, sha]) => `${repo}: expected ${sha}, found ${live[repo] ?? '<missing>'}`);
  if (mismatches.length > 0) throw new Error(`scanned submodule combo differs from the product pin:\n${mismatches.join('\n')}`);
  return sortRecord(pinned);
}

function artifactCommit(root: string): string {
  return git(root, ['rev-parse', 'HEAD']);
}

function assertOwnedUiSourcesClean(root: string, roots: readonly UiScanRoot[]): void {
  const dirty: string[] = [];
  for (const entry of roots) {
    const repoRoot = join(root, 'packages', entry.repo);
    const isSubmodule = existsSync(join(repoRoot, '.git'));
    const cwd = isSubmodule ? repoRoot : root;
    const path = isSubmodule ? slash(relative(repoRoot, join(root, entry.path))) : entry.path;
    const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', path]);
    if (status) dirty.push(`${entry.repo}: ${status.replaceAll('\n', '; ')}`);
  }
  if (dirty.length > 0) {
    throw new Error(`owned UI sources are dirty, so commit SHAs cannot describe the scanned bytes:\n${dirty.join('\n')}`);
  }
}

function domainCounts(effects: EffectRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const effect of effects) counts[effect.domain] = (counts[effect.domain] ?? 0) + 1;
  return sortRecord(counts);
}

function sourceCounts(raw: RawControl[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const control of raw) counts[control.collector] = (counts[control.collector] ?? 0) + 1;
  return sortRecord(counts);
}

function repoControlCounts(rows: ControlRow[], roots: readonly UiScanRoot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.repo] = (counts[row.repo] ?? 0) + 1;
  for (const repo of roots.map((entry) => entry.repo)) counts[repo] ??= 0;
  return sortRecord(counts);
}

function scanOtherTeamSurface(root: string): OtherTeamSurfaceRow[] {
  return OTHER_TEAM_REPOS.map(({ repo, owner }) => {
    const repoRoot = join(root, 'packages', repo);
    const perFile = new Map<string, { controls: number; events: Set<string> }>();
    for (const abs of listRepoOwnedSourceFiles(repoRoot).filter((file) => file.endsWith('.tsx'))) {
      const parsed = parseFile(root, abs);
      let controls = 0;
      const events = new Set<string>();
      visit(parsed.sf, (node) => {
        if (!ts.isJsxAttribute(node)) return;
        const event = nodeName(node.name);
        if (!/^on[A-Z]\w*$/.test(event)) return;
        controls += 1;
        events.add(event);
      });
      if (controls > 0) perFile.set(parsed.rel, { controls, events });
    }
    const topFiles = [...perFile.entries()]
      .map(([file, value]) => ({ file, controls: value.controls, events: [...value.events].sort() }))
      .sort((a, b) => b.controls - a.controls || a.file.localeCompare(b.file))
      .slice(0, 5);
    return {
      repo,
      owner,
      controls: [...perFile.values()].reduce((sum, value) => sum + value.controls, 0),
      interactiveFiles: perFile.size,
      topFiles,
    };
  });
}

function otherTeamSurfaceMarkdown(rows: OtherTeamSurfaceRow[]): string {
  const overview = rows.map((row) => (
    `| ${row.repo} | ${row.owner} | ${row.controls} | ${row.interactiveFiles} |`
  )).join('\n');
  const details = rows.map((row) => {
    const top = row.topFiles.length > 0
      ? row.topFiles.map((file) => `| \`${file.file}\` | ${file.controls} | ${file.events.map((event) => `\`${event}\``).join(', ')} |`).join('\n')
      : '| _No repository-owned TSX event props found._ | 0 | — |';
    return `## ${row.repo}\n\n| Major interaction file | JSX controls | Event props |\n|---|---:|---|\n${top}`;
  }).join('\n\n');
  return `# Other-team UI surface scale inventory\n\n` +
    `> This is a scale-only inventory of repository-owned JSX \`on[A-Z]*\` event props. It is **not** a per-control audit, does **not** assign \`control_id\`, and is excluded from the M2 migration denominator. Nested git repositories, tests, dependencies, and generated output are excluded from the parent repository's count.\n\n` +
    `| Repository | Owner | JSX control count | Interactive files |\n|---|---|---:|---:|\n${overview}\n\n` +
    `${details}\n`;
}

function manualSourceCounts(rows: ManualPoolRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const source = typeof row.details.collector === 'string' ? row.details.collector : row.kind;
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return sortRecord(counts);
}

function negativeCandidates(files: ParsedFile[], hitFiles: Set<string>): Array<{ stratum: string; file: string }> {
  const out: Array<{ stratum: string; file: string }> = [];
  for (const parsed of files) {
    if (!parsed.abs.endsWith('.tsx') || hitFiles.has(parsed.rel)) continue;
    let hasJsx = false;
    visit(parsed.sf, (node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) hasJsx = true;
    });
    if (!hasJsx) continue;
    const within = parsed.repoRelative.replace(/^src\/?/, '');
    const seg = within.split('/');
    const localStratum = seg.length === 1
      ? 'src'
      : seg[0] === 'components' && seg.length >= 3
        ? `components/${seg[1]}`
        : seg[0] || 'src';
    out.push({ stratum: `${parsed.repo}:${localStratum}`, file: parsed.rel });
  }
  return out.sort((a, b) => a.stratum.localeCompare(b.stratum) || a.file.localeCompare(b.file));
}

export function stratifiedNegativeSample(
  candidates: Array<{ stratum: string; file: string }>,
  n: number,
  seed: string,
): Array<{ stratum: string; file: string }> {
  if (!Number.isInteger(n) || n < 0) throw new Error('--sample-negatives must be a non-negative integer');
  const buckets = new Map<string, Array<{ stratum: string; file: string }>>();
  for (const row of candidates) {
    const list = buckets.get(row.stratum) ?? [];
    list.push(row);
    buckets.set(row.stratum, list);
  }
  for (const list of buckets.values()) list.sort((a, b) => hash(`${seed}|${a.file}`).localeCompare(hash(`${seed}|${b.file}`)));
  const strata = [...buckets.keys()].sort((a, b) => hash(`${seed}|${a}`).localeCompare(hash(`${seed}|${b}`)));
  const out: Array<{ stratum: string; file: string }> = [];
  let round = 0;
  while (out.length < n) {
    let added = false;
    for (const stratum of strata) {
      const row = buckets.get(stratum)?.[round];
      if (!row) continue;
      out.push(row);
      added = true;
      if (out.length === n) break;
    }
    if (!added) break;
    round += 1;
  }
  return out;
}

function previousBaselineControlDiff(
  root: string,
  baselineId: string,
  controls: ControlRow[],
  aliasMap: AliasMap,
): BaselineControlDiff | null {
  const parent = join(root, 'docs/ai-native/baseline');
  if (!existsSync(parent)) return null;
  const previousBaselineId = SCANNER_PREVIOUS_BASELINE_ID;
  if (previousBaselineId === baselineId || !existsSync(join(parent, previousBaselineId, 'controls.jsonl'))) return null;
  const previous = readFileSync(join(parent, previousBaselineId, 'controls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ControlRow);
  const previousEffects = readFileSync(join(parent, previousBaselineId, 'effects.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean).length;
  const previousManual = readFileSync(join(parent, previousBaselineId, 'manual-classification-pool.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ManualPoolRow);
  const previousById = new Map(previous.map((row) => [row.control_id, row]));
  const currentById = new Map(controls.map((row) => [row.control_id, row]));
  const migrated = previous.flatMap((old) => {
    const currentId = resolveAlias(old.control_id, aliasMap);
    const current = currentId === old.control_id ? undefined : currentById.get(currentId);
    return current ? [{ old, current }] : [];
  });
  const migratedOld = new Set(migrated.map((row) => row.old.control_id));
  const migratedCurrent = new Set(migrated.map((row) => row.current.control_id));
  return {
    previousBaselineId,
    previousCount: previous.length,
    previousEffects,
    previousManualPool: previousManual.length,
    previousManualControls: previousManual.filter((row) => row.kind === 'control').length,
    added: controls.filter((row) => !previousById.has(row.control_id) && !migratedCurrent.has(row.control_id)),
    removed: previous.filter((row) => !currentById.has(row.control_id) && !migratedOld.has(row.control_id)),
    migrated,
  };
}

function controlDiffMarkdown(
  diff: BaselineControlDiff | null,
  stats: InventoryStats,
  otherTeamSurface: OtherTeamSurfaceRow[],
  methodSubscriptionAudit: MethodSubscriptionAudit[],
): string {
  if (!diff) return '';
  const currentCount = stats.controls;
  const delta = currentCount - diff.previousCount;
  const sign = delta >= 0 ? `+${delta}` : String(delta);
  const effectDelta = stats.effects - diff.previousEffects;
  const manualDelta = stats.manualPool - diff.previousManualPool;
  const previousManualRatio = diff.previousCount === 0 ? 0 : diff.previousManualControls / diff.previousCount;
  const signed = (value: number) => value >= 0 ? `+${value}` : String(value);
  const addedByRepo = sortRecord(diff.added.reduce<Record<string, number>>((counts, row) => {
    counts[row.repo] = (counts[row.repo] ?? 0) + 1;
    return counts;
  }, {}));
  const repoDelta = ['interface', 'chat', 'studio']
    .map((repo) => `\`${repo}\` **${addedByRepo[repo] ?? 0}**`)
    .join(', ');
  const added = diff.added.length === 0
    ? '_None._'
    : `| Control | Repo | Surface / event | Source | Effect |\n|---|---|---|---|---|\n${diff.added.map((row) => (
      `| \`${row.control_id}\` | \`${row.repo}\` | \`${row.surface}\` / \`${row.event}\` | \`${row.file}:${row.evidence_line}\` | \`${row.effect_id ?? 'manual-pool'}\` |`
    )).join('\n')}`;
  const removed = diff.removed.length === 0
    ? '_None._'
    : diff.removed.map((row) => `- \`${row.control_id}\` — \`${row.file}:${row.evidence_line}\` (\`${row.event}\`)`).join('\n');
  const migrated = diff.migrated.length === 0
    ? '_None._'
    : `| Old id / evidence | New id / evidence | Effect |\n|---|---|---|\n${diff.migrated.map(({ old, current }) => (
      `| \`${old.control_id}\` · \`${old.file}:${old.evidence_line}\` | \`${current.control_id}\` · \`${current.file}:${current.evidence_line}\` | \`${current.effect_id ?? 'manual-pool'}\` |`
    )).join('\n')}`;
  const addedSubscriptions = diff.added.filter((row) => row.surface === 'subscription-handler');
  const subscriptionRows = addedSubscriptions.length === 0
    ? '_None._'
    : `| Control | Repo | Event | Source | Effect |\n|---|---|---|---|---|\n${addedSubscriptions.map((row) => (
      `| \`${row.control_id}\` | \`${row.repo}\` | \`${row.event}\` | \`${row.file}:${row.evidence_line}\` | \`${row.effect_id ?? 'manual-pool'}\` |`
    )).join('\n')}`;
  const otherTeamTotal = otherTeamSurface.reduce((sum, row) => sum + row.controls, 0);
  const otherTeamCounts = otherTeamSurface.map((row) => `\`${row.repo}\` **${row.controls}**`).join(', ');
  const methodAuditRows = methodSubscriptionAudit.length === 0
    ? '| — | — | — | — | No lowercase method-family candidates. |'
    : methodSubscriptionAudit.map((row) => {
      const decision = row.decision === 'real-user-entry'
        ? 'real user entry — kept'
        : row.decision === 'effect-unclear'
          ? 'effect unclear — manual pool'
          : 'infrastructure plumbing — excluded';
      const result = row.control_id
        ? `\`${row.control_id}\` → \`${row.effect_id ?? 'manual-pool'}\``
        : 'signed call-scoped exclusion';
      const topic = row.topic === null ? 'callback' : JSON.stringify(row.topic);
      return `| \`${row.file}:${row.evidence_line}\` | \`${row.receiver}.${row.method}(${topic})\` | ${decision} | ${result} | ${row.rationale} |`;
    }).join('\n');
  return `## Diff from ${diff.previousBaselineId}\n\n` +
    `- Controls: **${diff.previousCount} → ${currentCount} (${sign})**\n` +
    `- Canonical effects: **${diff.previousEffects} → ${stats.effects} (${signed(effectDelta)})**\n` +
    `- Manual-classification pool: **${diff.previousManualPool} → ${stats.manualPool} (${signed(manualDelta)})**; control ratio **${(previousManualRatio * 100).toFixed(1)}% → ${(stats.manualControlRatio * 100).toFixed(1)}%**\n` +
    `- Newly inventoried: **${diff.added.length}** (${repoDelta}); removed: **${diff.removed.length}**; identity migrations: **${diff.migrated.length}**\n` +
    `- Custom-subscription additions (A): **${addedSubscriptions.length}**; unresolved callbacks remain explicit controls in the manual pool.\n` +
    `- Lowercase method-family audit: **${stats.narrowSubscriptionCandidates}** candidates; **${stats.narrowSubscriptionRetained}** retained; **${stats.narrowSubscriptionExcluded}** excluded by **${stats.narrowSubscriptionExclusionRules}** new signed call-scoped rules.\n` +
    `- Provider-DI annotations (B): **${stats.diProviderAnnotations}** of **${stats.diProviderBranches}** detected branches; **${stats.diProviderManual}** unassociated branches routed to the manual pool.\n` +
    `- Other-team scale disclosure: **${otherTeamTotal}** raw JSX event props (${otherTeamCounts}); scale-only and excluded from the migration denominator.\n` +
    `- Scanner rule repair: ${SCANNER_CHANGE_NOTE}\n\n` +
    `### Added controls\n\n${added}\n\n` +
    `### Added custom subscription controls (A)\n\n${subscriptionRows}\n\n` +
    `### Lowercase method-family adjudication (all candidates)\n\n` +
    `| Source | Call | Verdict | Baseline result | Basis |\n|---|---|---|---|---|\n${methodAuditRows}\n\n` +
    `### Removed controls\n\n${removed}\n\n` +
    `### Corrected control identities\n\n${migrated}\n\n`;
}

function summaryMarkdown(
  baselineId: string,
  stats: InventoryStats,
  diff: BaselineControlDiff | null,
  constantListeners: ConstantListenerAudit[],
  otherTeamSurface: OtherTeamSurfaceRow[],
  methodSubscriptionAudit: MethodSubscriptionAudit[],
): string {
  const sourceRows = Object.entries(stats.sourceCounts).map(([source, count]) => `| ${source} | ${count} |`).join('\n');
  const manualRows = Object.entries(stats.manualSourceCounts).map(([source, count]) => `| ${source} | ${count} |`).join('\n');
  const domainRows = Object.entries(stats.domainCounts).map(([domain, count]) => `| ${domain} | ${count} |`).join('\n');
  const repoRows = Object.entries(stats.repoControlCounts).map(([repo, count]) => (
    `| ${repo} | ${count} | ${stats.repoOnClickCounts[repo] ?? 0} |`
  )).join('\n');
  const otherTeamRows = otherTeamSurface.map((row) => `| ${row.repo} | ${row.controls} | ${row.interactiveFiles} | ${row.owner} |`).join('\n');
  const constantRows = constantListeners.length > 0
    ? constantListeners.map((row) => (
      `| \`${row.file}:${row.line}\` | \`${row.expression}\` | ${row.events.length}: ${row.events.map((event) => `\`${event}\``).join(', ')} | ${row.disposition} | ${row.reasons.join('; ') || '—'} |`
    )).join('\n')
    : '| — | — | 0 | — | No statically resolved constant-form listeners. |';
  const clickDelta = stats.rawOnClick - 195;
  const fileDelta = stats.rawOnClickFiles - 40;
  const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
  const judgment = stats.manualControlRatio <= 0.25
    ? '可接受：未分类控件不超过 25%，可作为 M0 后续人工收敛队列。'
    : stats.manualControlRatio <= 0.4
      ? '临界：可冻结为 M0 原始基线，但应优先人工收敛自定义组件回调。'
      : '不可接受：人工池超过 40%，应先补传播规则再用于能力覆盖结论。';
  return `# AI-native capability baseline ${baselineId}\n\n` +
    `## Key numbers\n\n` +
    `- Controls: **${stats.controls}**\n` +
    `- Canonical effects: **${stats.effects}**\n` +
    `- Effects with an existing agent equivalent: **${stats.agentEquivalentEffects}**\n` +
    `- Manual-classification pool: **${stats.manualPool}** (${stats.manualControls} controls, ${(stats.manualControlRatio * 100).toFixed(1)}% of controls)\n` +
    `- Side-effect server endpoints (POST/PUT/DELETE): **${stats.endpoints}**\n` +
    `- Real \`useSurface(\` call sites (definition/comments excluded): **${stats.actualUseSurfaceCalls}** (${stats.sourceCounts['use-surface'] ?? 0} declared action controls)\n` +
    `- Provider-DI callback branches: **${stats.diProviderBranches}** detected; **${stats.diProviderAnnotations}** uniquely annotated; **${stats.diProviderManual}** manual\n` +
    `- Narrow lowercase subscription family: **${stats.narrowSubscriptionCandidates}** candidates; **${stats.narrowSubscriptionRetained}** retained; **${stats.narrowSubscriptionExcluded}** excluded by **${stats.narrowSubscriptionExclusionRules}** new rules\n` +
    `- Audited exclusions applied: **${stats.excluded}**\n\n` +
    `Manual-pool judgment: **${judgment}**\n\n` +
    controlDiffMarkdown(diff, stats, otherTeamSurface, methodSubscriptionAudit) +
    `## Owned controls by repository\n\n| Repo | Controls | Raw onClick props |\n|---|---:|---:|\n${repoRows}\n\n` +
    `## Controls by source\n\n| Source | Count |\n|---|---:|\n${sourceRows}\n\n` +
    `## Manual pool by source\n\n| Source | Count |\n|---|---:|\n${manualRows}\n\n` +
    `## Effects by domain\n\n| Domain | Count |\n|---|---:|\n${domainRows}\n\n` +
    `## onClick reference anchor\n\n` +
    `The AST found **${stats.rawOnClick}** \`onClick\` JSX attributes in **${stats.rawOnClickFiles}** source files before exclusions. ` +
    `Against the planning anchor (~195 occurrences / ~40 files), the deltas are **${sign(clickDelta)} occurrences** and **${sign(fileDelta)} files**. ` +
    `The delta is expected because the anchor covered interface only, while v${SCANNER_VERSION} includes chat and studio. This is an observation, not a pass/fail gate: the scanner collects every \`on[A-Z]\\w*\` prop.\n\n` +
    `## Constant-form listener audit\n\n` +
    `Resolved **${stats.constantListenerCallSites}** non-literal call sites into **${stats.constantListenerEvents}** event registrations; **${stats.unresolvedListenerExpressions}** non-literal expressions remained non-static. Internal synchronization/telemetry/transport registrations were excluded by audited rules rather than promoted into controls.\n\n` +
    `| Source | Expression | Resolved events | Disposition | Audit reason |\n|---|---|---|---|---|\n${constantRows}\n\n` +
    `## Other-team scale disclosure (excluded from denominator)\n\n` +
    `These are JSX event-prop counts only, not per-control inventories. Full top-file evidence is frozen in \`other-team-surface.md\`.\n\n` +
    `| Repo | JSX controls | Interactive files | Owner |\n|---|---:|---:|---|\n${otherTeamRows}\n\n` +
    `## Scope notes\n\n` +
    `- Owned UI scan roots: \`packages/interface/src\`, \`packages/chat/src\`, and \`packages/studio/src\`. Tests, \`__tests__\`, build output, dependencies, nested git repositories, and the editor's vendored interface copy are excluded.\n` +
    `- Command-palette rows derive from all ${stats.sourceCounts['action-palette'] ?? 0} statically declared ActionRegistry entries; each row's file/line is its real \`registerAction\` call.\n` +
    `- Every control has one scalar \`repo\`; canonical effects use a sorted \`repo\` array because one effect may aggregate declarations, routes, or control edges from multiple repositories.\n` +
    `- Tool equivalence records the offline loader boundary. Marketplace manifests are intentionally not parsed; \`agent_equiv.tool.runtime_fill\` points to the runtime \`GET /api/tools\` fill.\n` +
    `- Known long-tail and out-of-scope collector patterns are registered in \`docs/ai-native/known-collector-gaps.md\`; detected unresolved owned entries stay in the manual pool.\n` +
    `- Product-code identity comes from \`meta.json.scanned_product_combo\`; \`artifact_commit\` is informational and ignored during byte verification. The recursive pin snapshot is \`docs/ai-native/PINNED-submodule-status.txt\`.\n` +
    `- Evidence line numbers are audit pointers only and are not part of \`control_id\`.\n`;
}

export async function buildInventory(options: BuildOptions = {}): Promise<InventoryResult> {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const uiRoots = options.uiRoots ?? DEFAULT_UI_SCAN_ROOTS;
  const date = options.baselineDate ?? new Date().toISOString().slice(0, 10);
  const baselineId = `b0-${date}-${SCANNER_VERSION}`;
  const configDir = join(root, 'scripts/ai-native');
  const exclusions = JSON.parse(readFileSync(join(configDir, 'exclusions.json'), 'utf8')) as Exclusions;
  const exclusionIssues = validateExclusions(exclusions);
  if (exclusionIssues.length) throw new Error(`invalid exclusions.json:\n${exclusionIssues.join('\n')}`);
  const vocabConfig = JSON.parse(readFileSync(join(configDir, 'vocab-map.json'), 'utf8')) as VocabConfig;
  const aliasMap = JSON.parse(readFileSync(join(configDir, 'alias-map.json'), 'utf8')) as AliasMap;
  const aliasIssues = validateAliasMap(aliasMap);
  if (aliasIssues.length) throw new Error(`invalid alias-map.json:\n${aliasIssues.join('\n')}`);

  assertOwnedUiSourcesClean(root, uiRoots);
  const uiFiles = configuredUiFiles(root, uiRoots);
  const extraFiles = [
    join(root, 'packages/orchestrator/src/kernel/ui-headless-actions.ts'),
  ].filter(existsSync).map((file) => parseFile(root, file));
  const allParsed = new Map([...uiFiles, ...extraFiles].map((file) => [file.rel, file]));
  const setters = extractStoreFunctions(allParsed);
  const setterNames = new Set(setters.map((row) => row.name));
  const actions = extractActions(allParsed, setterNames);
  const commands = extractCommands(allParsed, setterNames);
  const vocab = deriveVocab(vocabConfig, setters, actions, commands);
  const routes = extractEndpoints(root);
  const routeKeys = new Set(routes.endpoints.map((endpoint) => normalizeEndpointKey(`${endpoint.method} ${endpoint.path}`)));
  for (const [effect, endpoints] of Object.entries(vocab.config.server_endpoint_overrides ?? {})) {
    for (const endpoint of endpoints) {
      if (!routeKeys.has(normalizeEndpointKey(endpoint))) {
        throw new Error(`server endpoint override for ${effect} is not present in the Hono route table: ${endpoint}`);
      }
    }
  }

  // Client facades sometimes hide the concrete fetch from an action body.
  // These explicit, reviewed joins keep server anchors semantic without
  // teaching the scanner to guess endpoints from English verbs.
  for (const action of actions) {
    const effect = vocab.actionMap.get(action.id)!;
    const configured = vocab.config.server_endpoint_overrides?.[effect] ?? [];
    action.endpoints = [...new Set([...action.endpoints, ...configured])].sort();
  }

  const endpointMap = new Map<string, string>();
  const endpointActionEffects = new Map<string, Set<string>>();
  for (const action of actions) {
    const effect = vocab.actionMap.get(action.id)!;
    for (const endpoint of action.endpoints) {
      const key = normalizeEndpointKey(endpoint);
      const candidates = endpointActionEffects.get(key) ?? new Set<string>();
      candidates.add(effect);
      endpointActionEffects.set(key, candidates);
    }
  }
  for (const endpoint of routes.endpoints) {
    const wire = `${endpoint.method} ${endpoint.path}`;
    const normalized = normalizeEndpointKey(wire);
    endpointMap.set(normalized, endpointEffectId(wire));
  }
  // Only a one-to-one action↔endpoint relationship is safe to collapse. A
  // dispatcher such as POST /api/tools/call serves many semantic actions; a
  // generic RPC call to it must remain tool.invoke/server.*, never inherit the
  // last action that happened to be scanned.
  for (const [endpoint, candidates] of endpointActionEffects) {
    if (candidates.size === 1) endpointMap.set(endpoint, [...candidates][0]);
  }

  const jsx = collectJsxControls(uiFiles, exclusions, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap);
  const listeners = collectListenerControls(uiFiles, allParsed, exclusions, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap);
  const subscriptions = collectSubscriptionControls(uiFiles, exclusions, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap);
  const surfaceControls = collectUseSurfaceControls(uiFiles, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap);
  const rawControls = [
    ...jsx.controls,
    ...listeners.controls,
    ...subscriptions.controls,
    ...collectShortcutControls(uiFiles, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap),
    ...collectLinks(uiFiles),
    ...collectMenuObjects(uiFiles, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap),
    ...surfaceControls.controls,
    ...collectRpcControls(uiFiles, vocab.setterMap, vocab.actionMap, vocab.commandMap, endpointMap),
    ...collectCommandControls(allParsed, commands, vocab.commandMap),
    ...collectPaletteControls(allParsed, actions, vocab.actionMap),
  ];
  const rows = controlsToRows(rawControls);
  const methodSubscriptionAudit = reviewMethodSubscriptionCandidates(
    subscriptions.audits,
    rows.rows,
    exclusions.subscription_rules,
  );
  const providerDiBranches = collectProviderDiBranches(uiFiles);
  const providerDi = annotateProviderDiBranches(providerDiBranches, rows.rows, rows.edges);
  const currentControlIds = new Set(rows.rows.map((row) => row.control_id));
  for (const entry of aliasMap.aliases) {
    const current = resolveAlias(entry.old_control_id, aliasMap);
    if (!currentControlIds.has(current)) {
      throw new Error(`alias target is not present in current controls: ${entry.old_control_id} -> ${current}`);
    }
  }
  const headless = extractHeadless(allParsed);
  const effects = buildEffects(
    setters,
    actions,
    commands,
    routes.endpoints,
    rows.rows,
    rows.edges,
    vocab.setterMap,
    vocab.actionMap,
    vocab.commandMap,
    endpointMap,
    headless,
  );
  const manualPool = [...rows.manual, ...listeners.manual, ...providerDi.manual, ...vocab.manual, ...routes.manual]
    .sort((a, b) => a.manual_id.localeCompare(b.manual_id));
  const sources = sourceCounts(rawControls);
  const otherTeamSurface = scanOtherTeamSurface(root);
  const manualControls = rows.manual.filter((row) => row.kind === 'control').length;
  const stats: InventoryStats = {
    controls: rows.rows.length,
    effects: effects.length,
    agentEquivalentEffects: effects.filter((effect) => Boolean(effect.agent_equiv.action) || effect.agent_equiv.headless === 'yes' || (effect.agent_equiv.tool?.ids.length ?? 0) > 0).length,
    manualPool: manualPool.length,
    manualControls,
    manualControlRatio: rows.rows.length === 0 ? 0 : manualControls / rows.rows.length,
    rawOnClick: jsx.rawOnClick,
    rawOnClickFiles: jsx.rawOnClickFiles,
    endpoints: routes.endpoints.length,
    sourceCounts: sources,
    manualSourceCounts: manualSourceCounts(manualPool),
    domainCounts: domainCounts(effects),
    repoControlCounts: repoControlCounts(rows.rows, uiRoots),
    repoOnClickCounts: jsx.rawOnClickByRepo,
    excluded: jsx.excluded + listeners.excluded + subscriptions.excluded,
    actualUseSurfaceCalls: surfaceControls.callSites,
    constantListenerCallSites: listeners.constantAudits.length,
    constantListenerEvents: listeners.constantAudits.reduce((sum, row) => sum + row.events.length, 0),
    unresolvedListenerExpressions: listeners.unresolvedExpressions,
    diProviderBranches: providerDiBranches.length,
    diProviderAnnotations: providerDi.annotations,
    diProviderManual: providerDi.manual.length,
    narrowSubscriptionCandidates: methodSubscriptionAudit.length,
    narrowSubscriptionRetained: methodSubscriptionAudit.filter((row) => row.disposition === 'collected').length,
    narrowSubscriptionExcluded: methodSubscriptionAudit.filter((row) => row.disposition === 'excluded').length,
    narrowSubscriptionExclusionRules: exclusions.subscription_rules.filter((rule) => (
      rule.method !== undefined && NARROW_SUBSCRIPTION_METHODS.has(rule.method)
    )).length,
  };
  const meta = {
    baseline_id: baselineId,
    scanner_version: SCANNER_VERSION,
    scanned_product_combo: scannedProductCombo(root),
    artifact_commit: artifactCommit(root),
    pinned_submodule_status: 'docs/ai-native/PINNED-submodule-status.txt',
  };
  const baselineDiff = previousBaselineControlDiff(root, baselineId, rows.rows, aliasMap);
  const hitFiles = new Set(rawControls.map((control) => control.file));
  return {
    baselineId,
    scannerVersion: SCANNER_VERSION,
    controls: rows.rows,
    effects,
    edges: rows.edges,
    manualPool,
    meta,
    summary: summaryMarkdown(
      baselineId,
      stats,
      baselineDiff,
      listeners.constantAudits,
      otherTeamSurface,
      methodSubscriptionAudit,
    ),
    stats,
    vocabMap: vocab.config,
    otherTeamSurface,
    constantListeners: listeners.constantAudits,
    methodSubscriptionAudit,
    negativeCandidates: negativeCandidates(uiFiles, hitFiles),
  };
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function renderInventory(result: InventoryResult): Record<string, string> {
  return {
    'controls.jsonl': result.controls.map((row) => jsonLine(row)).join(''),
    'effects.jsonl': result.effects.map((row) => jsonLine(row)).join(''),
    'edges.jsonl': result.edges.map((row) => jsonLine(row)).join(''),
    'manual-classification-pool.jsonl': result.manualPool.map((row) => jsonLine(row)).join(''),
    'vocab-map.json': renderVocabMap(result.vocabMap),
    'other-team-surface.md': otherTeamSurfaceMarkdown(result.otherTeamSurface),
    'summary.md': result.summary,
    'meta.json': `${JSON.stringify(result.meta, null, 2)}\n`,
  };
}

export function renderVocabMap(config: VocabConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Test helper: parse JSX controls from one fixture without touching the repo baseline. */
export function fixtureControlIds(
  source: string,
  options: { file?: string; repo?: string } = {},
): Array<{ id: string; event: string; component: string; element: string }> {
  const file = options.file ?? 'src/Fixture.tsx';
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parsed: ParsedFile = {
    abs: file,
    rel: file,
    repo: options.repo ?? 'interface',
    repoRelative: file,
    text: source,
    sf,
    locals: new Map(),
    localStateSetters: new Set(),
    constantDeclarations: new Map(),
    imports: new Map(),
  };
  indexParsedFile(parsed);
  const raw: RawControl[] = [];
  visit(sf, (node) => {
    if (!ts.isJsxAttribute(node) || !/^on[A-Z]\w*$/.test(nodeName(node.name))) return;
    const opening = node.parent?.parent;
    if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) return;
    raw.push(makeRawControl(parsed, {
      surface: surfaceForJsx(jsxElementName(opening), nodeName(node.name), file),
      event: nodeName(node.name),
      component: enclosingFunctionName(opening),
      line: lineOf(sf, node),
      elementType: jsxElementName(opening),
      stableAttributes: staticJsxAttributes(opening),
      staticText: directJsxText(opening),
      handler: rawJsxHandler(node),
      collector: 'fixture',
      propagation: 'direct',
      owner: 'us',
      notes: [],
      forwardedProps: new Set(),
      effects: new Map(),
    }));
  });
  assignOrdinals(raw);
  return raw.map((control) => ({
    id: controlId({
      repo: control.repo,
      relativePath: control.repoRelative,
      component: control.component,
      event: control.event,
      elementType: control.elementType,
      stableAttributes: control.stableAttributes,
      staticText: control.staticText,
      ordinal: control.ordinal,
    }),
    event: control.event,
    component: control.component,
    element: control.elementType,
  }));
}

/** Test helper for the custom-component callback propagation rule. */
export function fixtureScan(
  source: string,
  setters: Record<string, string> = {},
  options: { file?: string; subscriptionRules?: ExclusionRule[] } = {},
): {
  controls: ControlRow[];
  edges: EdgeRow[];
  manual: ManualPoolRow[];
  subscriptionAudits: SubscriptionCandidateAudit[];
} {
  const file = options.file ?? 'src/Fixture.tsx';
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parsed: ParsedFile = {
    abs: file,
    rel: file,
    repo: 'interface',
    repoRelative: file,
    text: source,
    sf,
    locals: new Map(),
    localStateSetters: new Set(),
    constantDeclarations: new Map(),
    imports: new Map(),
  };
  indexParsedFile(parsed);
  const emptyExclusions: Exclusions = {
    version: 1,
    jsx_event_rules: [],
    listener_rules: [],
    subscription_rules: options.subscriptionRules ?? [],
  };
  const collected = collectJsxControls(
    [parsed],
    emptyExclusions,
    new Map(Object.entries(setters)),
    new Map(),
    new Map(),
    new Map(),
  );
  const listeners = collectListenerControls(
    [parsed],
    new Map([[parsed.rel, parsed]]),
    emptyExclusions,
    new Map(Object.entries(setters)),
    new Map(),
    new Map(),
    new Map(),
  );
  const subscriptions = collectSubscriptionControls(
    [parsed],
    emptyExclusions,
    new Map(Object.entries(setters)),
    new Map(),
    new Map(),
    new Map(),
  );
  const result = controlsToRows([...collected.controls, ...listeners.controls, ...subscriptions.controls]);
  const providerDi = annotateProviderDiBranches(collectProviderDiBranches([parsed]), result.rows, result.edges);
  return {
    controls: result.rows,
    edges: result.edges,
    manual: [...result.manual, ...listeners.manual, ...providerDi.manual].sort((a, b) => a.manual_id.localeCompare(b.manual_id)),
    subscriptionAudits: subscriptions.audits,
  };
}
