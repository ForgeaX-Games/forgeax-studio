import { lstatSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export type WorkspacePackageLinkResult = 'current' | 'linked' | 'relinked' | 'occupied';

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function ensureWorkspacePackageLink(
  linkPath: string,
  targetPath: string,
  workspaceRoot: string,
  isWindows = process.platform === 'win32',
): WorkspacePackageLinkResult {
  const existing = lstatIfPresent(linkPath);
  if (existing && !existing.isSymbolicLink()) return 'occupied';

  if (existing) {
    try {
      const relativeTarget = relative(realpathSync(workspaceRoot), realpathSync(linkPath));
      if (relativeTarget !== '..' && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget)) {
        return 'current';
      }
    } catch {
      // A dangling link is stale and should be rebuilt below.
    }
    rmSync(linkPath);
  }

  symlinkSync(targetPath, linkPath, isWindows ? 'junction' : 'dir');
  return existing ? 'relinked' : 'linked';
}
