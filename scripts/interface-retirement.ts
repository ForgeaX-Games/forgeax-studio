import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type ReferenceBudget = Record<string, number>;

export type InterfaceRetirementBaseline = {
  schemaVersion: number;
  token: string;
  consumers: Record<string, {
    root: string;
    evidenceCommit: string;
    allowedReferences: ReferenceBudget;
  }>;
  gitlinkPath: string;
  interfacePackageRetirementEvidence: {
    repository: string;
    pullRequest: string | null;
    mergeCommit: string | null;
  };
  retirementInputs: string[];
};

export type ConsumerAudit = {
  root: string;
  evidenceCommit: string;
  referenceCount: number;
  references: ReferenceBudget;
};

export type InterfaceRetirementAudit = {
  consumers: Record<string, ConsumerAudit>;
  ratchetViolations: string[];
  readinessBlockers: string[];
  ready: boolean;
};

const SCANNED_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.jsx', '.mjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'test',
  'tests',
  '__tests__',
]);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function isScannedFile(path: string): boolean {
  const name = path.split(sep).at(-1) ?? path;
  if (name === 'bun.lock' || name.includes('.spec.') || name.includes('.test.')) return false;
  return SCANNED_EXTENSIONS.has(extension(name));
}

function countToken(text: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(token, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + token.length;
  }
}

export function scanInterfaceReferences(
  consumerRoot: string,
  token = '@forgeax/interface',
): ReferenceBudget {
  if (!existsSync(consumerRoot)) {
    throw new Error(`Interface retirement consumer root unavailable: ${consumerRoot}`);
  }

  const findings: ReferenceBudget = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // A materialized nested repository owns its own source.  Do not count
        // that repository's self-references as debt in the parent consumer.
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !existsSync(join(path, '.git'))) visit(path);
        continue;
      }
      if (!entry.isFile() || !isScannedFile(path)) continue;
      const count = countToken(readFileSync(path, 'utf8'), token);
      if (count > 0) findings[relative(consumerRoot, path).split(sep).join('/')] = count;
    }
  };
  visit(consumerRoot);
  return Object.fromEntries(Object.entries(findings).sort(([left], [right]) => left.localeCompare(right)));
}

export function evaluateReferenceRatchet(
  references: ReferenceBudget,
  allowedReferences: ReferenceBudget,
): string[] {
  const violations: string[] = [];
  for (const [path, count] of Object.entries(references)) {
    const allowed = allowedReferences[path];
    if (allowed === undefined) {
      violations.push(`new Interface consumer path: ${path} (${count} ${count === 1 ? 'reference' : 'references'})`);
    } else if (count > allowed) {
      violations.push(`Interface debt increased: ${path} has ${count} references (allowed ${allowed})`);
    }
  }
  return violations;
}

function tracksGitlink(root: string, path: string): boolean {
  const result = Bun.spawnSync(['git', 'ls-files', '--stage', '--', path], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed while checking Interface retirement: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().split('\n').some((line) => line.startsWith('160000 '));
}

export function auditInterfaceRetirement(
  studioRoot: string,
  baseline: InterfaceRetirementBaseline,
): InterfaceRetirementAudit {
  if (baseline.schemaVersion !== 1) throw new Error(`Unsupported Interface retirement schema: ${baseline.schemaVersion}`);

  const consumers: Record<string, ConsumerAudit> = {};
  const ratchetViolations: string[] = [];
  const readinessBlockers: string[] = [];

  for (const [name, contract] of Object.entries(baseline.consumers)) {
    const root = resolve(studioRoot, contract.root);
    let references: ReferenceBudget;
    try {
      references = scanInterfaceReferences(root, baseline.token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ratchetViolations.push(`${name}: ${message}`);
      readinessBlockers.push(`${name} source is unavailable for retirement verification`);
      references = {};
    }
    const referenceCount = Object.values(references).reduce((sum, count) => sum + count, 0);
    consumers[name] = {
      root: contract.root,
      evidenceCommit: contract.evidenceCommit,
      referenceCount,
      references,
    };
    ratchetViolations.push(...evaluateReferenceRatchet(references, contract.allowedReferences)
      .map((violation) => `${name}: ${violation}`));
    if (referenceCount > 0) readinessBlockers.push(`${name} still references ${baseline.token}`);
  }

  if (tracksGitlink(studioRoot, baseline.gitlinkPath)) {
    readinessBlockers.push(`Studio still tracks ${baseline.gitlinkPath} as a gitlink`);
  }
  const packageEvidence = baseline.interfacePackageRetirementEvidence;
  if (
    packageEvidence.repository !== 'ForgeaX-Games/forgeax-interface'
    || !packageEvidence.pullRequest?.match(/^https:\/\/github\.com\/ForgeaX-Games\/forgeax-interface\/pull\/\d+$/)
    || !packageEvidence.mergeCommit?.match(/^[0-9a-f]{40}$/)
  ) {
    readinessBlockers.push('Interface package retirement merge evidence is not recorded');
  }
  for (const input of baseline.retirementInputs) {
    const path = resolve(studioRoot, input);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (source.includes(baseline.gitlinkPath) || source.includes(baseline.token)) {
      readinessBlockers.push(`${input} still participates in Interface integration`);
    }
  }

  return {
    consumers,
    ratchetViolations,
    readinessBlockers,
    ready: ratchetViolations.length === 0 && readinessBlockers.length === 0,
  };
}
