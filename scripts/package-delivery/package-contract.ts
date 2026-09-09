export type PackageProfile = 'library' | 'bin' | 'extension';

export interface PackageContractIssue {
  readonly code: string;
  readonly message: string;
}

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly main?: string;
  readonly exports?: unknown;
  readonly bin?: string | Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export interface PackageContractOptions {
  readonly profile: PackageProfile;
  readonly expectedTag?: string;
  readonly extensionManifestPresent?: boolean;
}

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SOURCE_DEPENDENCY = /^(?:workspace:|file:|link:|git\+|git:|https?:\/\/|github:|bitbucket:)/iu;

function issue(code: string, message: string): PackageContractIssue {
  return { code, message };
}

function entrypoints(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(entrypoints);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(entrypoints);
}

function dependencyEntries(manifest: PackageManifest): Array<[string, string]> {
  return [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .flatMap((dependencies) => Object.entries(dependencies ?? {}));
}

export function validatePackageManifest(
  manifest: PackageManifest,
  options: PackageContractOptions,
): PackageContractIssue[] {
  const issues: PackageContractIssue[] = [];
  if (!manifest.name?.trim()) issues.push(issue('name-missing', 'package name is required'));
  if (!manifest.version || !SEMVER.test(manifest.version)) {
    issues.push(issue('version-invalid', 'package version must be semantic and immutable'));
  }
  if (manifest.private === true) issues.push(issue('package-private', 'publishable package must not be private'));
  if (options.expectedTag && manifest.version && options.expectedTag.replace(/^v/u, '') !== manifest.version) {
    issues.push(issue('tag-version-mismatch', `tag ${options.expectedTag} does not match ${manifest.version}`));
  }

  const files = manifest.files ?? [];
  if (files.length === 0 || files.some((path) => path === '.' || path === '*' || path === './' || path.includes('**'))) {
    issues.push(issue('files-not-whitelisted', 'files must be a non-empty explicit publish whitelist'));
  }
  const publicEntrypoints = [...entrypoints(manifest.exports), ...entrypoints(manifest.main), ...entrypoints(manifest.bin)];
  if (publicEntrypoints.some((path) => /(?:^|\/)src(?:\/|$)|\.(?:ts|tsx)$/u.test(path) && !path.endsWith('.d.ts'))) {
    issues.push(issue('source-entrypoint', 'public runtime entrypoints must reference built output, not source files'));
  }
  for (const [name, specifier] of dependencyEntries(manifest)) {
    if (SOURCE_DEPENDENCY.test(specifier)) {
      issues.push(issue('source-dependency', `${name} uses forbidden source dependency ${specifier}`));
    }
  }

  if (options.profile === 'library' && entrypoints(manifest.exports).length === 0 && !manifest.main) {
    issues.push(issue('library-entrypoint-missing', 'library profile requires exports or main'));
  }
  if (options.profile === 'bin' && entrypoints(manifest.bin).length === 0) {
    issues.push(issue('bin-missing', 'bin profile requires at least one executable entry'));
  }
  if (options.profile === 'extension') {
    if (!manifest.name?.startsWith('@forgeax-extension/')) {
      issues.push(issue('extension-name-invalid', 'extension profile requires the @forgeax-extension/* scope'));
    }
    if (!files.includes('forgeax-extension.json') || options.extensionManifestPresent === false) {
      issues.push(issue('extension-manifest-missing', 'extension profile must publish forgeax-extension.json'));
    }
  }
  return issues;
}

export interface PackageSize {
  readonly packedBytes: number;
  readonly unpackedBytes: number;
}

export interface PackageSizeBaseline extends PackageSize {
  readonly maxGrowthPercent?: number;
}

export interface PackageSizeAssessment {
  readonly ok: boolean;
  readonly packedGrowthPercent: number;
  readonly unpackedGrowthPercent: number;
  readonly exceeded: Array<keyof PackageSize>;
}

function growth(current: number, baseline: number): number {
  return Number((((current - baseline) / baseline) * 100).toFixed(2));
}

export function assessPackageSize(current: PackageSize, baseline: PackageSizeBaseline): PackageSizeAssessment {
  const threshold = baseline.maxGrowthPercent ?? 20;
  const packedGrowthPercent = growth(current.packedBytes, baseline.packedBytes);
  const unpackedGrowthPercent = growth(current.unpackedBytes, baseline.unpackedBytes);
  const exceeded: Array<keyof PackageSize> = [];
  if (packedGrowthPercent > threshold) exceeded.push('packedBytes');
  if (unpackedGrowthPercent > threshold) exceeded.push('unpackedBytes');
  return { ok: exceeded.length === 0, packedGrowthPercent, unpackedGrowthPercent, exceeded };
}
