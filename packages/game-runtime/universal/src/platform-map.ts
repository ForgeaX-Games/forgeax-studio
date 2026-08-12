declare const process: { readonly platform: string; readonly arch: string };

export const PLATFORM_PACKAGES = {
  'darwin-arm64': '@forgeax/game-runtime-darwin-arm64',
  'win32-x64': '@forgeax/game-runtime-win32-x64',
  'linux-x64': '@forgeax/game-runtime-linux-x64',
} as const;

export interface RuntimeMachine {
  readonly platform: string;
  readonly arch: string;
}

export type PlatformPackageName = typeof PLATFORM_PACKAGES[keyof typeof PLATFORM_PACKAGES];
export type PlatformModuleLoader<T> = (packageName: PlatformPackageName) => Promise<T>;

export function platformPackageName(machine: RuntimeMachine = {
  platform: process.platform,
  arch: process.arch,
}): PlatformPackageName {
  const key = `${machine.platform}-${machine.arch}` as keyof typeof PLATFORM_PACKAGES;
  const packageName = PLATFORM_PACKAGES[key];
  if (!packageName) throw new Error(`unsupported Game Runtime platform: ${machine.platform}/${machine.arch}`);
  return packageName;
}

export async function loadPlatformPackage<T>(
  machine: RuntimeMachine,
  loader: PlatformModuleLoader<T>,
): Promise<T> {
  const packageName = platformPackageName(machine);
  try {
    return await loader(packageName);
  } catch (error) {
    throw new Error(
      `${packageName} is not installed for ${machine.platform}/${machine.arch}; reinstall @forgeax/game-runtime with optional dependencies enabled`,
      { cause: error },
    );
  }
}
