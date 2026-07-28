import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { canonicalSha256 } from './runtime-snapshot-core.ts';
import { assertIntegrityDomainGenerated } from './integrity-domain.ts';

export interface ScannerProductTreeFingerprint {
  schema_version: 1;
  algorithm: 'sha256-path-content-v2';
  file_count: number;
  content_sha256: string;
  combo_sha256: string;
  bound_sha256: string;
}

export interface ScannerFingerprintBoundaryInput {
  path: string;
  /** A pinned hash makes an enforcement-only legacy boundary byte-neutral. */
  sha256?: string;
}

const SCANNER_SOURCE_ROOTS = [
  'packages/interface/src',
  'packages/chat/src',
  'packages/studio/src',
  'packages/orchestrator/src',
  'packages/server/src',
] as const;

const OTHER_TEAM_SURFACE_ROOTS = [
  'packages/editor',
  'packages/marketplace',
  'packages/platform-io',
  'packages/settings',
  'packages/workbench',
  'packages/dashboard',
] as const;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'build', 'coverage', '__tests__']);

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function scannerSourceFiles(repoRoot: string, relativeRoot: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) throw new Error(`scanner product fingerprint root missing: ${relativeRoot}`);
    for (const name of readdirSync(current).sort()) {
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const full = join(current, name);
      if (slash(full).includes('/packages/editor/packages/interface/')) continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith('.d.ts')) continue;
      files.push(full);
    }
  };
  walk(resolve(repoRoot, relativeRoot));
  return files;
}

function otherTeamSurfaceFiles(repoRoot: string, relativeRoot: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) throw new Error(`scanner product fingerprint root missing: ${relativeRoot}`);
    for (const name of readdirSync(current).sort()) {
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (existsSync(join(full, '.git'))) continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.tsx') || /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith('.d.ts')) continue;
      files.push(full);
    }
  };
  walk(resolve(repoRoot, relativeRoot));
  return files;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function computeScannerProductTreeFingerprint(
  repoRoot: string,
  scannedProductCombo: Readonly<Record<string, string>>,
  explicitBoundaryInputs?: readonly ScannerFingerprintBoundaryInput[],
): ScannerProductTreeFingerprint {
  const root = resolve(repoRoot);
  const integrityDomain = assertIntegrityDomainGenerated(root);
  const absoluteFiles = new Set<string>();
  for (const relativeRoot of SCANNER_SOURCE_ROOTS) {
    for (const file of scannerSourceFiles(root, relativeRoot)) absoluteFiles.add(file);
  }
  for (const relativeRoot of OTHER_TEAM_SURFACE_ROOTS) {
    for (const file of otherTeamSurfaceFiles(root, relativeRoot)) absoluteFiles.add(file);
  }
  const boundaryInputs: readonly ScannerFingerprintBoundaryInput[] = explicitBoundaryInputs
    ?? integrityDomain.snapshot_boundary_inputs.map((path) => ({ path }));
  const boundaryHashes = new Map<string, string>();
  for (const input of boundaryInputs) {
    const file = resolve(root, input.path);
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw new Error(`scanner product fingerprint boundary input missing: ${input.path}`);
    }
    boundaryHashes.set(input.path, input.sha256 ?? sha256Bytes(readFileSync(file)));
  }
  const fileRows = [
    ...[...absoluteFiles]
    .map((file) => ({
      path: slash(relative(root, file)),
      sha256: sha256Bytes(readFileSync(file)),
    })),
    ...[...boundaryHashes].map(([path, sha256]) => ({ path, sha256 })),
  ]
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.path === row.path) === index)
    .sort((left, right) => codePointCompare(left.path, right.path));
  const combo = Object.fromEntries(
    Object.entries(scannedProductCombo).sort(([left], [right]) => codePointCompare(left, right)),
  );
  const contentSha256 = canonicalSha256(fileRows);
  const comboSha256 = canonicalSha256(combo);
  const binding = {
    algorithm: 'sha256-path-content-v2' as const,
    file_count: fileRows.length,
    content_sha256: contentSha256,
    combo_sha256: comboSha256,
  };
  return {
    schema_version: 1,
    ...binding,
    bound_sha256: canonicalSha256(binding),
  };
}
