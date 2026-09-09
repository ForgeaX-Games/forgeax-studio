import { createHash } from 'node:crypto';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface SourceReachIn {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
}

function portable(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//u, '');
}

function belowGitlink(target: string, gitlinks: readonly string[]): boolean {
  return gitlinks.some((gitlink) => target.startsWith(`${gitlink}/`));
}

function resolveSpecifier(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return portable(normalize(resolve('/', dirname(file), specifier)).slice(1));
  if (specifier.startsWith('packages/')) return portable(specifier);
  return undefined;
}

export function findSourceReachIns(input: {
  readonly gitlinks: readonly string[];
  readonly files: readonly SourceFile[];
}): SourceReachIn[] {
  const findings: SourceReachIn[] = [];
  const quoted = /(['"])([^'"\n]+)\1/gu;
  for (const file of input.files) {
    for (const match of file.content.matchAll(quoted)) {
      const specifier = match[2];
      const target = resolveSpecifier(file.path, specifier);
      if (!target || isAbsolute(target) || !belowGitlink(target, input.gitlinks)) continue;
      const line = file.content.slice(0, match.index).split('\n').length;
      findings.push({ file: portable(file.path), line, specifier, target });
    }
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

export function sourceReachInFingerprint(finding: SourceReachIn): string {
  return createHash('sha256')
    .update(finding.file)
    .update('\0')
    .update(finding.specifier)
    .update('\0')
    .update(finding.target)
    .digest('hex');
}

export function newReachIns(
  current: readonly SourceReachIn[],
  baseline: readonly SourceReachIn[] | readonly string[],
): SourceReachIn[] {
  const allowed = new Set(baseline.map((item) => typeof item === 'string' ? item : sourceReachInFingerprint(item)));
  return current.filter((finding) => !allowed.has(sourceReachInFingerprint(finding)));
}

export function repositoryRelative(root: string, path: string): string {
  return portable(relative(root, path));
}
