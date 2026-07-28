import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';

const EVIDENCE_ROOT = 'docs/ai-native/evidence';

export interface ResolvedEvidenceFile {
  absolutePath: string;
  repositoryPath: string;
  sha256: string;
}

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

export function resolveEvidenceFileIfPresent(
  repoRoot: string,
  repositoryPath: string,
): ResolvedEvidenceFile | null {
  if (
    !repositoryPath
    || isAbsolute(repositoryPath)
    || repositoryPath.includes('\\')
    || /\s/.test(repositoryPath)
    || !repositoryPath.endsWith('.md')
    || posix.normalize(repositoryPath) !== repositoryPath
    || !repositoryPath.startsWith(`${EVIDENCE_ROOT}/`)
  ) {
    throw new Error(`ratification evidence path is not canonical: ${repositoryPath}`);
  }

  const root = resolve(repoRoot);
  const evidenceRoot = resolve(root, EVIDENCE_ROOT);
  const target = resolve(root, repositoryPath);
  const relativeTarget = slash(relative(evidenceRoot, target));
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith('../')) {
    throw new Error(`ratification evidence escapes ${EVIDENCE_ROOT}: ${repositoryPath}`);
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`ratification evidence must not be a symlink: ${repositoryPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`ratification evidence must be a regular file: ${repositoryPath}`);
  }

  const realEvidenceRoot = realpathSync(evidenceRoot);
  const realTarget = realpathSync(target);
  const realRelative = slash(relative(realEvidenceRoot, realTarget));
  if (!realRelative || realRelative === '..' || realRelative.startsWith('../')) {
    throw new Error(`ratification evidence resolves outside ${EVIDENCE_ROOT}: ${repositoryPath}`);
  }

  return {
    absolutePath: target,
    repositoryPath,
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
  };
}

export function resolveEvidenceFile(repoRoot: string, repositoryPath: string): ResolvedEvidenceFile {
  const evidence = resolveEvidenceFileIfPresent(repoRoot, repositoryPath);
  if (!evidence) {
    throw new Error(`ratification evidence file does not exist: ${repositoryPath}`);
  }
  return evidence;
}
