/**
 * Manifest-driven desktop extension selection.
 *
 * The selector intentionally knows nothing about an extension's resource
 * files.  A selected `dir` is copied as a complete tree by the desktop
 * assembler; the manifest is only used to decide which trees belong in the
 * payload and to resolve the dependency closure.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
type AnyExtensionManifest = Record<string, unknown>;
type ExtensionManifestV2 = Record<string, any>;
type ManifestSkillEntry = Record<string, any>;
type SkillRef = Record<string, any>;

// Keep schema ownership in @forgeax/types without pulling its zod graph into
// syntax-only builds or Game Runtime assembly. Lite/full desktop selection
// executes this module only in a prepared workspace where the contract package
// is installed.
const contractModuleId = '@forgeax/types';
const {
  SkillRefSchema,
  normalizeManifest,
  parseAnyManifest,
} = await import(contractModuleId);

export type DesktopExtensionSelectionProfile = 'lite' | 'full';

/** Capabilities exposed to the desktop assembler and its audit checks. */
export interface DesktopExtensionCapabilities {
  readonly agent: boolean;
  readonly cliProvider: boolean;
  readonly modelBinding: boolean;
  readonly skill: boolean;
  readonly tool: boolean;
  /** A workbench or any v2 UI contribution (pages/panels/activities/surfaces). */
  readonly productWorkbench: boolean;
}

export interface ParsedDesktopExtension {
  readonly id: string;
  /** Complete extension directory. */
  readonly dir: string;
  /** Compatibility spelling used by the desktop assembler. */
  readonly directory: string;
  /** Compatibility family classification used by the build audit. */
  readonly family: DesktopExtensionFamily;
  readonly capabilities: DesktopExtensionCapabilities;
  readonly manifest: AnyExtensionManifest;
  readonly normalizedManifest: ExtensionManifestV2;
}

export type DesktopExtensionFamily =
  | 'agent'
  | 'cli-provider'
  | 'model-binding'
  | 'skill'
  | 'tool'
  | 'product';

export interface DesktopExtensionSelection {
  readonly profile: DesktopExtensionSelectionProfile;
  readonly extensions: readonly ParsedDesktopExtension[];
  readonly directories: readonly string[];
  readonly warnings: readonly string[];
}

export interface DesktopExtensionSelectionEntry {
  readonly id: string;
  readonly dir: string;
  readonly capabilities: DesktopExtensionCapabilities;
}

/** Preserve the scanner's one-directory-deep layout for scoped manifest ids. */
export function desktopExtensionOutputName(
  extension: Pick<DesktopExtensionSelectionEntry, 'dir'>,
): string {
  return basename(extension.dir);
}

export function desktopExtensionPathEscapesRoot(relativePath: string): boolean {
  return isAbsolute(relativePath) || relativePath.split(/[\\/]/, 1)[0] === '..';
}

export interface DesktopExtensionClosure {
  readonly included: readonly DesktopExtensionSelectionEntry[];
  readonly excluded: readonly DesktopExtensionSelectionEntry[];
  /** Non-fatal defaultSkills diagnostics (kept stable for build logs/tests). */
  readonly warnings: readonly string[];
}

export class DesktopExtensionSelectionError extends Error {
  readonly code:
    | 'INVALID_ROOT'
    | 'INVALID_MANIFEST'
    | 'DUPLICATE_ID'
    | 'OUTSIDE_ROOT'
    | 'MISSING_REQUIRED_DEPENDENCY'
    | 'MISSING_SOFT_REFERENCE'
    | 'DISALLOWED_REQUIRED_DEPENDENCY'
    | 'REQUIRED_DEPENDENCY_CYCLE'
    | 'INVALID_REFERENCE';

  constructor(code: DesktopExtensionSelectionError['code'], message: string) {
    super(message);
    this.name = 'DesktopExtensionSelectionError';
    this.code = code;
  }
}

type ManifestWithKind = AnyExtensionManifest & { kind?: string };
type UnknownRecord = Record<string, unknown>;

const UI_CONTRIBUTION_KEYS = ['pages', 'panelTypes', 'activities', 'surfaces'] as const;
const BUILTIN_CLI_PROVIDERS = new Set(['forgeax-native']);

function entries(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is UnknownRecord => !!item && typeof item === 'object')
    : [];
}

function oneOrEntries(value: unknown): readonly UnknownRecord[] {
  if (Array.isArray(value)) return entries(value);
  return value && typeof value === 'object' ? [value as UnknownRecord] : [];
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function parseManifestFile(manifestPath: string): {
  readonly manifest: AnyExtensionManifest;
  readonly normalizedManifest: ExtensionManifestV2;
} {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new DesktopExtensionSelectionError(
      'INVALID_MANIFEST',
      `invalid manifest ${manifestPath}: ${(error as Error).message}`,
    );
  }

  const parsed = parseAnyManifest(input);
  if (!parsed.ok || !parsed.manifest) {
    const detail = parsed.error?.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('; ') ?? 'schema validation failed';
    throw new DesktopExtensionSelectionError(
      'INVALID_MANIFEST',
      `invalid manifest ${manifestPath}: ${detail}`,
    );
  }

  try {
    return {
      manifest: parsed.manifest,
      normalizedManifest: normalizeManifest(parsed.manifest),
    };
  } catch (error) {
    throw new DesktopExtensionSelectionError(
      'INVALID_MANIFEST',
      `invalid manifest ${manifestPath}: ${(error as Error).message}`,
    );
  }
}

function capabilitiesOf(
  manifest: AnyExtensionManifest,
  normalized: ExtensionManifestV2,
): DesktopExtensionCapabilities {
  const original = manifest as ManifestWithKind;
  const contributes = normalized.contributes as UnknownRecord;
  const ui = UI_CONTRIBUTION_KEYS.some((key) => hasEntries(contributes[key]));

  return {
    // A v1 agent with tools is still an agent.  Capability flags are
    // independent, so mixed server-side contributions do not turn it into a
    // product extension.
    agent: original.schemaVersion === 1
      ? original.kind === 'agent'
      : hasEntries(contributes.agents),
    cliProvider: original.schemaVersion === 1
      ? original.kind === 'cli-provider'
      : hasEntries(contributes.cliProviders),
    modelBinding: original.schemaVersion === 1
      ? original.kind === 'model-binding'
      : hasEntries(contributes.modelBindings),
    skill: original.schemaVersion === 1
      ? original.kind === 'skill' || hasEntries((original.provides as UnknownRecord).skills)
      : hasEntries(contributes.skills),
    tool: original.schemaVersion === 1
      ? original.kind === 'tool' || hasEntries((original.provides as UnknownRecord).tools)
      : hasEntries(contributes.tools),
    productWorkbench: original.schemaVersion === 1
      ? original.kind === 'workbench'
      : ui,
  };
}

function familyOf(capabilities: DesktopExtensionCapabilities): DesktopExtensionFamily {
  // Product/workbench wins over every other contribution for lite selection.
  if (capabilities.productWorkbench) return 'product';
  if (capabilities.agent) return 'agent';
  if (capabilities.cliProvider) return 'cli-provider';
  if (capabilities.modelBinding) return 'model-binding';
  if (capabilities.skill) return 'skill';
  return capabilities.tool ? 'tool' : 'product';
}

/**
 * Scan exactly one extension directory level.  Symlinked extension roots are
 * accepted only when their real path remains below `root`.
 */
export function scanDesktopExtensions(rootInput: string): ParsedDesktopExtension[] {
  const root = resolve(rootInput);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new DesktopExtensionSelectionError(
      'INVALID_ROOT',
      `extensions root is not a directory: ${rootInput}`,
    );
  }
  const canonicalRoot = realpathSync(root);
  const records: ParsedDesktopExtension[] = [];

  const children = readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;

    const candidate = resolve(root, child.name);
    let canonicalDir: string;
    try {
      canonicalDir = realpathSync(candidate);
    } catch {
      // Broken links are not extension manifests and can be ignored.
      continue;
    }
    const escaped = relative(canonicalRoot, canonicalDir);
    if (desktopExtensionPathEscapesRoot(escaped)) {
      throw new DesktopExtensionSelectionError(
        'OUTSIDE_ROOT',
        `extension directory escapes extensions root: ${candidate}`,
      );
    }

    const manifestPath = resolve(canonicalDir, 'forgeax-extension.json');
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;

    const { manifest, normalizedManifest } = parseManifestFile(manifestPath);
    const capabilities = capabilitiesOf(manifest, normalizedManifest);
    const record: ParsedDesktopExtension = {
      id: String(manifest.id),
      dir: canonicalDir,
      directory: canonicalDir,
      family: familyOf(capabilities),
      capabilities,
      manifest,
      normalizedManifest,
    };
    if (records.some((item) => item.id === record.id)) {
      throw new DesktopExtensionSelectionError(
        'DUPLICATE_ID',
        `duplicate extension id ${record.id} (at ${manifestPath})`,
      );
    }
    records.push(record);
  }

  return records.sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir));
}

function contributionIds(record: ParsedDesktopExtension): readonly string[] {
  const original = record.manifest as ManifestWithKind;
  const normalized = record.normalizedManifest.contributes as UnknownRecord;
  const ids = [record.id];
  const add = (values: unknown): void => {
    for (const item of entries(values)) {
      if (typeof item.id === 'string' && item.id.length > 0) ids.push(item.id);
    }
  };

  if (original.schemaVersion === 1) {
    const provides = original.provides as UnknownRecord;
    for (const agent of oneOrEntries(provides.agent)) {
      if (typeof agent.id === 'string' && agent.id.length > 0) ids.push(agent.id);
    }
    add(provides.agents);
    add(provides.skills);
    add(provides.tools);
    add(provides.cliProvider);
    add(provides.modelBinding);
    add(provides.workbench);
  }
  add(normalized.agents);
  add(normalized.skills);
  add(normalized.tools);
  add(normalized.cliProviders);
  add(normalized.modelBindings);
  add(normalized.pages);
  add(normalized.panelTypes);
  add(normalized.activities);
  add(normalized.surfaces);
  return [...new Set(ids)];
}

function recordsByReference(records: readonly ParsedDesktopExtension[]): Map<string, ParsedDesktopExtension> {
  const map = new Map<string, ParsedDesktopExtension>();
  for (const record of records) {
    for (const id of contributionIds(record)) {
      const previous = map.get(id);
      if (previous && previous.id !== record.id) {
        // A contribution id is also a valid reference key.  Ambiguous keys
        // would make closure selection depend on directory order, so reject
        // them as duplicate manifest identity.
        throw new DesktopExtensionSelectionError(
          'DUPLICATE_ID',
          `duplicate extension contribution id ${id} (${previous.id}, ${record.id})`,
        );
      }
      map.set(id, record);
    }
  }
  return map;
}

function agentsOf(record: ParsedDesktopExtension): readonly UnknownRecord[] {
  const original = record.manifest as ManifestWithKind;
  if (original.schemaVersion === 1) {
    const provides = original.provides as UnknownRecord;
    return original.kind === 'agent'
      ? oneOrEntries(provides.agent)
      : entries(provides.agents);
  }
  return entries((record.normalizedManifest.contributes as UnknownRecord).agents);
}

function skillsOf(record: ParsedDesktopExtension): readonly ManifestSkillEntry[] {
  return ((record.normalizedManifest.contributes as UnknownRecord).skills ?? []) as readonly ManifestSkillEntry[];
}

function validateAgentRefs(record: ParsedDesktopExtension): void {
  for (const agent of agentsOf(record)) {
    if (agent.preferredCliProvider !== undefined
      && (typeof agent.preferredCliProvider !== 'string' || agent.preferredCliProvider.trim() === '')) {
      throw new DesktopExtensionSelectionError(
        'INVALID_REFERENCE',
        `invalid preferredCliProvider in ${record.id}`,
      );
    }
    if (agent.defaultSkills === undefined) continue;
    if (!Array.isArray(agent.defaultSkills)) {
      throw new DesktopExtensionSelectionError('INVALID_REFERENCE', `defaultSkills must be an array in ${record.id}`);
    }
    for (const ref of agent.defaultSkills) {
      if (!SkillRefSchema.safeParse(ref).success) {
        throw new DesktopExtensionSelectionError(
          'INVALID_REFERENCE',
          `invalid defaultSkills reference in ${record.id}`,
        );
      }
    }
  }
}

function dependenciesOf(record: ParsedDesktopExtension): readonly { id: string; optional?: boolean }[] {
  return (record.manifest.dependencies ?? []) as readonly { id: string; optional?: boolean }[];
}

function entryOf(record: ParsedDesktopExtension): DesktopExtensionSelectionEntry {
  return { id: record.id, dir: record.dir, capabilities: record.capabilities };
}

/** Resolve a complete closure for a desktop bundle profile. */
export function selectDesktopExtensionClosure(
  parsed: readonly ParsedDesktopExtension[],
  profile: DesktopExtensionSelectionProfile,
): DesktopExtensionClosure {
  if (profile !== 'lite' && profile !== 'full') {
    throw new DesktopExtensionSelectionError('INVALID_ROOT', `unknown desktop bundle profile: ${profile}`);
  }

  const records = [...parsed].sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir));
  const seenManifestIds = new Set<string>();
  for (const record of records) {
    if (!record.id || !record.dir || !record.manifest) {
      throw new DesktopExtensionSelectionError('INVALID_MANIFEST', 'selection input contains an invalid extension record');
    }
    if (seenManifestIds.has(record.id)) {
      throw new DesktopExtensionSelectionError('DUPLICATE_ID', `duplicate extension id ${record.id}`);
    }
    seenManifestIds.add(record.id);
    validateAgentRefs(record);
  }

  const byReference = recordsByReference(records);
  const warnings: string[] = [];

  if (profile === 'full') {
    return {
      included: records.map(entryOf),
      excluded: [],
      warnings,
    };
  }

  const included = new Map<string, ParsedDesktopExtension>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (record: ParsedDesktopExtension, stack: readonly string[], reason: string): void => {
    if (visiting.has(record.id)) {
      throw new DesktopExtensionSelectionError(
        'REQUIRED_DEPENDENCY_CYCLE',
        `required dependency cycle (${reason}): ${[...stack, record.id].join(' -> ')}`,
      );
    }
    if (visited.has(record.id)) return;
    if (record.capabilities.productWorkbench) {
      throw new DesktopExtensionSelectionError(
        'DISALLOWED_REQUIRED_DEPENDENCY',
        `lite selection cannot include product/workbench extension ${record.id}`,
      );
    }

    visiting.add(record.id);
    included.set(record.id, record);

    // Optional dependencies are metadata only.  They are deliberately not
    // followed, even when present in the scanned extension tree.
    for (const dependency of dependenciesOf(record)) {
      if (dependency.optional) continue;
      const target = records.find((item) => item.id === dependency.id);
      if (!target) {
        throw new DesktopExtensionSelectionError(
          'MISSING_REQUIRED_DEPENDENCY',
          `required dependency ${dependency.id} of ${record.id} is missing from extensions root`,
        );
      }
      visit(target, [...stack, record.id], 'dependency');
    }

    for (const agent of agentsOf(record)) {
      const provider = agent.preferredCliProvider;
      if (typeof provider === 'string' && provider !== '' && !BUILTIN_CLI_PROVIDERS.has(provider)) {
        const target = byReference.get(provider);
        if (!target) {
          throw new DesktopExtensionSelectionError(
            'MISSING_SOFT_REFERENCE',
            `${record.id} preferredCliProvider references unavailable extension ${provider}`,
          );
        }
        visit(target, [...stack, record.id], 'preferredCliProvider');
      }

      for (const ref of (Array.isArray(agent.defaultSkills) ? agent.defaultSkills : []) as SkillRef[]) {
        if (ref.source !== 'plugin') continue;
        const target = byReference.get(ref.pluginId);
        if (!target) {
          warnings.push(`${record.id} defaultSkills references unavailable extension ${ref.pluginId}`);
          continue;
        }
        if (target.capabilities.productWorkbench) {
          warnings.push(`${record.id} defaultSkills references excluded product extension ${target.id}`);
          continue;
        }
        if (ref.skillId && !skillsOf(target).some((skill) => skill.id === ref.skillId)) {
          warnings.push(`${record.id} defaultSkills references unavailable skill ${ref.pluginId}#${ref.skillId}`);
        }
        visit(target, [...stack, record.id], 'defaultSkills');
      }
    }

    visiting.delete(record.id);
    visited.add(record.id);
  };

  for (const record of records) {
    if (record.capabilities.agent && !record.capabilities.productWorkbench) {
      visit(record, [], 'agent root');
    }
  }

  const includedEntries = [...included.values()]
    .sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir))
    .map(entryOf);
  const includedIds = new Set(included.keys());
  const excludedEntries = records
    .filter((record) => !includedIds.has(record.id))
    .sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir))
    .map(entryOf);

  return {
    included: includedEntries,
    excluded: excludedEntries,
    warnings: [...new Set(warnings)].sort(),
  };
}

/* Compatibility surface for the earlier build helper.  New callers should
 * use the fixed scanDesktopExtensions/selectDesktopExtensionClosure API. */
export const discoverDesktopExtensions = scanDesktopExtensions;

/** Legacy assembler-facing shape; the closure API above is the SSOT. */
export function selectDesktopExtensions(
  parsed: readonly ParsedDesktopExtension[],
  profile: DesktopExtensionSelectionProfile,
): DesktopExtensionSelection {
  const closure = selectDesktopExtensionClosure(parsed, profile);
  const byId = new Map(parsed.map((record) => [record.id, record]));
  const extensions = closure.included
    .map((entry) => byId.get(entry.id))
    .filter((record): record is ParsedDesktopExtension => !!record)
    .sort((a, b) => a.id.localeCompare(b.id) || a.directory.localeCompare(b.directory));
  return {
    profile,
    extensions,
    directories: extensions.map((extension) => extension.directory),
    warnings: closure.warnings,
  };
}

export const resolveDesktopExtensionSelection = selectDesktopExtensions;
