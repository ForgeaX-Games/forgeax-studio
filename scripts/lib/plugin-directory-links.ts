import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkTarget(linkPath: string, stat: ReturnType<typeof lstatSync>): string | null {
  if (stat.isSymbolicLink()) {
    try {
      return readlinkSync(linkPath);
    } catch {
      return null;
    }
  }

  if (!stat.isFile()) return null;
  try {
    const placeholder = readFileSync(linkPath, 'utf8').trim();
    return placeholder.length > 0 && !placeholder.includes('\n') ? placeholder : null;
  } catch {
    return null;
  }
}

/**
 * Repair a Windows checkout where a directory plugin alias was materialized as
 * a file symlink (or Git's plain-text symlink placeholder). Git records only
 * the link target, so this must be normalized to a directory junction before a
 * child process uses the alias as its cwd.
 *
 * Returns the absolute target when a repair was made, otherwise null.
 */
export function repairPluginDirectoryLink(
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return null;
  }

  // A correctly materialized directory junction already works as a cwd.
  if (isDirectory(linkPath)) return null;
  if (!stat.isSymbolicLink() && !stat.isFile()) return null;

  const rawTarget = linkTarget(linkPath, stat);
  if (!rawTarget) return null;
  const target = resolve(dirname(linkPath), rawTarget);
  if (!isDirectory(target) || !existsSync(resolve(target, 'package.json'))) return null;

  try {
    unlinkSync(linkPath);
    symlinkSync(target, linkPath, 'junction');
  } catch (error) {
    throw new Error(
      `failed to repair Windows plugin directory link ${linkPath} → ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return target;
}
