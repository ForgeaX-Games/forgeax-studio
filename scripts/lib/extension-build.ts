export type ExtensionPackage = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
};

export type ExtensionManifest = {
  id?: string;
  entry?: {
    frontend?: string;
    standalone?: { embeddedAlso?: boolean };
  };
};

export type ExtensionPackageManager = 'bun' | 'pnpm';

export type ExtensionPackageManagerSignals = Readonly<{
  bunLock: boolean;
  pnpmLock: boolean;
  pnpmWorkspace: boolean;
}>;

export type ExtensionBuildCommand = readonly [command: string, args: readonly string[]];

export class UnsupportedExtensionPackageManagerError extends Error {
  readonly packageManager: string | undefined;

  constructor(packageManager: string | undefined) {
    super(`unsupported extension package manager: ${packageManager ?? '<missing>'}`);
    this.name = 'UnsupportedExtensionPackageManagerError';
    this.packageManager = packageManager;
  }
}

export function extensionPackageManagerFallback(
  signals: ExtensionPackageManagerSignals,
): ExtensionPackageManager {
  if (signals.bunLock) return 'bun';
  if (signals.pnpmLock || signals.pnpmWorkspace) return 'pnpm';
  return 'bun';
}

export function extensionPackageManager(
  pkg: ExtensionPackage,
  fallback?: ExtensionPackageManager,
): ExtensionPackageManager {
  if (pkg.packageManager?.startsWith('bun@')) return 'bun';
  if (pkg.packageManager?.startsWith('pnpm@')) return 'pnpm';
  if (!pkg.packageManager && fallback) return fallback;
  throw new UnsupportedExtensionPackageManagerError(pkg.packageManager);
}

export function extensionBuildCommands(
  pkg: ExtensionPackage,
  fallback?: ExtensionPackageManager,
): ExtensionBuildCommand[] {
  const manager = extensionPackageManager(pkg, fallback);
  if (manager === 'bun') {
    return [
      ['bun', pkg.packageManager ? ['install', '--frozen-lockfile'] : ['install']],
      ['bun', ['run', 'build']],
    ];
  }
  return [
    ['pnpm', ['install', '--no-frozen-lockfile']],
    ['pnpm', ['build']],
  ];
}

export function extensionPreparationCommands(
  pkg: ExtensionPackage,
  fallback: ExtensionPackageManager | undefined,
  options: { hasFrontend: boolean; artifactBroken: boolean; force: boolean },
): ExtensionBuildCommand[] {
  const [install, build] = extensionBuildCommands(pkg, fallback);
  return options.hasFrontend && pkg.scripts?.build && (options.force || options.artifactBroken)
    ? [install!, build!]
    : [install!];
}

/**
 * Resolve the browser artifact consumed by the server's /extensions/:id mount.
 *
 * A manifest frontend can be either a released HTML artifact or a source panel
 * entry used by the Extension Platform. Buildable source entries still need the
 * server convention's dist/index.html for iframe delivery.
 */
export function extensionFrontendArtifact(manifest: ExtensionManifest): string | undefined {
  const frontend = manifest.entry?.frontend;
  if (!frontend) return undefined;
  return frontend.endsWith('.html') ? frontend : './dist/index.html';
}

/** Marketplace sources are discovered by contract, not legacy directory name. */
export function isExtensionSourceDirectory(
  name: string,
  options: { symbolicLink: boolean; hasManifest: boolean; hasPackage: boolean },
): boolean {
  return name !== '_template'
    && !options.symbolicLink
    && options.hasManifest
    && options.hasPackage;
}

export function matchesExtensionSelector(
  selector: string | undefined,
  directoryName: string,
  pkg: ExtensionPackage,
  manifest: ExtensionManifest,
): boolean {
  return selector === undefined
    || selector === directoryName
    || selector === pkg.name
    || selector === manifest.id;
}
