export type ExtensionPackage = {
  packageManager?: string;
};

export type ExtensionBuildCommand = readonly [command: string, args: readonly string[]];

export class UnsupportedExtensionPackageManagerError extends Error {
  readonly packageManager: string | undefined;

  constructor(packageManager: string | undefined) {
    super(`unsupported extension package manager: ${packageManager ?? '<missing>'}`);
    this.name = 'UnsupportedExtensionPackageManagerError';
    this.packageManager = packageManager;
  }
}

export function extensionBuildCommands(pkg: ExtensionPackage): ExtensionBuildCommand[] {
  if (pkg.packageManager?.startsWith('bun@')) {
    return [
      ['bun', ['install', '--frozen-lockfile']],
      ['bun', ['run', 'build']],
    ];
  }
  if (pkg.packageManager?.startsWith('pnpm@')) {
    return [
      ['pnpm', ['install', '--no-frozen-lockfile']],
      ['pnpm', ['build']],
    ];
  }
  throw new UnsupportedExtensionPackageManagerError(pkg.packageManager);
}
