export type ExtensionPackage = {
  packageManager?: string;
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

export function extensionBuildCommands(pkg: ExtensionPackage): ExtensionBuildCommand[] {
  if (extensionPackageManager(pkg) === 'bun') {
    return [
      ['bun', ['install', '--frozen-lockfile']],
      ['bun', ['run', 'build']],
    ];
  }
  return [
    ['pnpm', ['install', '--no-frozen-lockfile']],
    ['pnpm', ['build']],
  ];
}
