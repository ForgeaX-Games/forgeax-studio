import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`expected exact semver, received ${version}`);
}

export type ReleaseMetadata = { packageJson: string; changelog: string };

/** Validate every input and render both complete files before any caller writes. */
export function renderReleaseMetadata(root: string, version: string): ReleaseMetadata {
  assertVersion(version);
  const packageValue: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (typeof packageValue !== 'object' || packageValue === null || Array.isArray(packageValue)) {
    throw new Error('package.json must contain an object');
  }
  const packageJson = packageValue as Record<string, unknown>;
  if (typeof packageJson.version !== 'string' || !VERSION_PATTERN.test(packageJson.version)) {
    throw new Error('package.json current version is not an exact semver');
  }
  if (packageJson.version === version) throw new Error(`package.json is already version ${version}`);

  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const duplicate = new RegExp(`^## v${version.replaceAll('.', '\\.')} \\u00b7 IDE-owned Release$`, 'm');
  if (duplicate.test(changelog)) throw new Error(`CHANGELOG.md already contains the exact v${version} release heading`);
  const marker = '## 🚧 [Unreleased]';
  const markerIndex = changelog.indexOf(marker);
  if (markerIndex < 0) throw new Error('CHANGELOG.md is missing the Unreleased marker');
  const nextMarker = changelog.indexOf(marker, markerIndex + marker.length);
  if (nextMarker >= 0) throw new Error('CHANGELOG.md contains multiple Unreleased markers');
  const separator = changelog.indexOf('\n---\n', markerIndex + marker.length);
  if (separator < 0) throw new Error('CHANGELOG.md is missing the Unreleased section separator');
  const earlierSeparator = changelog.lastIndexOf('\n---\n', separator - 1);
  if (earlierSeparator > markerIndex) throw new Error('CHANGELOG.md Unreleased insertion point is ambiguous');

  const nextPackage = { ...packageJson, version };
  const entry = [
    '',
    `## v${version} · IDE-owned Release`,
    '',
    '- Build, signing, notarization, installers, and the GitHub Release are produced by the immutable ForgeaX IDE candidate.',
    '- Studio records the exact IDE and integration revisions and verifies candidate-bound evidence before mirror orchestration.',
    '',
    '---',
    '',
  ].join('\n');
  const insertAt = separator + '\n---\n'.length;
  return {
    packageJson: `${JSON.stringify(nextPackage, null, 2)}\n`,
    changelog: changelog.slice(0, insertAt) + entry + changelog.slice(insertAt),
  };
}

export function updateReleaseMetadata(root: string, version: string): void {
  const rendered = renderReleaseMetadata(root, version);
  writeFileSync(resolve(root, 'package.json'), rendered.packageJson);
  writeFileSync(resolve(root, 'CHANGELOG.md'), rendered.changelog);
}

export function writeReleaseMetadataOutput(root: string, version: string, outputDirectory: string): void {
  const rendered = renderReleaseMetadata(root, version);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'package.json'), rendered.packageJson);
  writeFileSync(resolve(outputDirectory, 'CHANGELOG.md'), rendered.changelog);
}

if (import.meta.main) {
  try {
    const version = process.argv[2];
    if (!version) throw new Error('usage: bun scripts/release/update-release-metadata.ts <exact-version> [--output-dir PATH]');
    const outputIndex = process.argv.indexOf('--output-dir');
    if (outputIndex >= 0) {
      const outputDirectory = process.argv[outputIndex + 1];
      if (!outputDirectory) throw new Error('--output-dir requires a path');
      writeReleaseMetadataOutput(process.cwd(), version, outputDirectory);
    } else {
      updateReleaseMetadata(process.cwd(), version);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(3);
  }
}
