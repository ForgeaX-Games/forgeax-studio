import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION = 2 as const;

const PREVIEW_ORIGIN = 'http://forgeax-preview.invalid';
const EXCLUDED_DIRECTORIES = new Set(['.git', '.forgeax', 'dist', 'node_modules']);

export interface PreviewBuildManifestRecord {
  readonly schemaVersion: typeof PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION;
  readonly gameId: string;
  readonly buildHash: string;
  readonly runtimeVersion: string;
  readonly engineCommit: string;
  readonly projectRoot: string;
  readonly gameRoot: string;
  readonly outputRoot: string;
  readonly payloadDigest: string;
}

export interface PreviewPackValidation {
  readonly entryCount: number;
  readonly packageFiles: readonly string[];
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))) {
      return [];
    }
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function outputRelativePath(outputRoot: string, packageUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(packageUrl, PREVIEW_ORIGIN);
  } catch {
    throw new Error(`preview pack packageUrl is not a URL: ${packageUrl}`);
  }
  if (parsed.origin !== PREVIEW_ORIGIN) {
    throw new Error(`preview pack packageUrl must stay on the preview origin: ${packageUrl}`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`preview pack packageUrl is not URI-decodable: ${packageUrl}`);
  }
  const withoutPreview = pathname.replace(/^\/preview\/?/u, '').replace(/^\/+/, '');
  if (!withoutPreview || withoutPreview.split('/').some((part) => part === '..' || part.length === 0)) {
    throw new Error(`preview pack packageUrl is not output-relative: ${packageUrl}`);
  }
  const candidate = resolve(outputRoot, withoutPreview);
  const escaped = relative(outputRoot, candidate);
  if (!escaped || escaped === '..' || escaped.startsWith(`..${sep}`) || escaped.startsWith(`.${sep}`)) {
    throw new Error(`preview pack packageUrl escapes the output root: ${packageUrl}`);
  }
  return candidate;
}

function requireOutputFile(outputRoot: string, packageUrl: string): string {
  const path = outputRelativePath(outputRoot, packageUrl);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`preview pack payload is missing: ${packageUrl}`);
  }
  return path;
}

function parsePackIndex(outputRoot: string): readonly Record<string, unknown>[] {
  const indexPath = join(outputRoot, 'pack-index.json');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`preview pack-index is missing: ${indexPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new Error(`preview pack-index is not valid JSON: ${indexPath}`, { cause: error });
  }
  if (!Array.isArray(value)) throw new Error(`preview pack-index must be an array: ${indexPath}`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.guid !== 'string' || typeof entry.packageUrl !== 'string') {
      throw new Error(`preview pack-index entry ${index} lacks guid/packageUrl`);
    }
    return entry;
  });
}

function validatePackBody(outputRoot: string, packagePath: string): void {
  if (!packagePath.endsWith('.pack.json')) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`preview pack body is not valid JSON: ${packagePath}`, { cause: error });
  }
  if (!isRecord(value) || value.assets === undefined) return;
  if (!Array.isArray(value.assets)) throw new Error(`preview pack body assets must be an array: ${packagePath}`);
  for (const asset of value.assets) {
    if (!isRecord(asset) || asset.artifacts === undefined) continue;
    if (!isRecord(asset.artifacts)) throw new Error(`preview pack artifacts must be an object: ${packagePath}`);
    for (const artifact of Object.values(asset.artifacts)) {
      if (!isRecord(artifact) || typeof artifact.path !== 'string') {
        throw new Error(`preview pack artifact lacks a path: ${packagePath}`);
      }
      const artifactPath = resolve(dirname(packagePath), artifact.path);
      const escaped = relative(outputRoot, artifactPath);
      if (!escaped || escaped === '..' || escaped.startsWith(`..${sep}`) || escaped.startsWith(`.${sep}`)) {
        throw new Error(`preview pack artifact escapes the output root: ${packagePath}`);
      }
      if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
        throw new Error(`preview pack artifact is missing: ${artifactPath}`);
      }
    }
  }
}

function readDeclaredLocalRoots(gameRoot: string): string[] {
  try {
    const packageJson = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8')) as {
      forgeax?: { assets?: { roots?: unknown } };
    };
    const roots = packageJson.forgeax?.assets?.roots;
    if (Array.isArray(roots)) {
      const localRoots = roots.filter(
        (root): root is string => typeof root === 'string' && !root.startsWith('@shared/'),
      );
      if (localRoots.length > 0) return localRoots;
    }
  } catch {
    // The Editor resolver also falls back to the engine default on malformed package.json.
  }
  return ['assets'];
}

function collectAssetGuids(value: unknown, output: Set<string>): void {
  if (!isRecord(value)) return;
  if (typeof value.guid === 'string') output.add(value.guid.toLowerCase());
  if (Array.isArray(value.subAssets)) {
    for (const subAsset of value.subAssets) {
      if (isRecord(subAsset) && typeof subAsset.guid === 'string') {
        output.add(subAsset.guid.toLowerCase());
      }
    }
  }
  if (Array.isArray(value.assets)) {
    for (const asset of value.assets) collectAssetGuids(asset, output);
  }
}

function collectExpectedAssetGuids(gameRoot: string): ReadonlySet<string> {
  const guids = new Set<string>();
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))) continue;
        visit(join(path, entry.name));
      }
      return;
    }
    const name = basename(path);
    if (!name.endsWith('.meta.json') && !name.endsWith('.pack.json')) return;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return;
    }
    if (isRecord(value) && value.importer === 'shader') return;
    if (
      isRecord(value)
      && value.importer === 'gltf'
      && isRecord(value.importSettings)
      && value.importSettings.geometry === 'procedural'
    ) {
      return;
    }
    collectAssetGuids(value, guids);
  };
  for (const root of readDeclaredLocalRoots(gameRoot)) visit(resolve(gameRoot, root));
  return guids;
}

export function validatePreviewPack(outputRoot: string, gameRoot?: string): PreviewPackValidation {
  const entries = parsePackIndex(outputRoot);
  const packageFiles = new Set<string>();
  for (const entry of entries) {
    const packagePath = requireOutputFile(outputRoot, entry.packageUrl as string);
    packageFiles.add(relative(outputRoot, packagePath).split(sep).join('/'));
    validatePackBody(outputRoot, packagePath);
  }
  if (gameRoot !== undefined && existsSync(gameRoot)) {
    const expected = collectExpectedAssetGuids(gameRoot);
    const published = new Set(entries.map((entry) => String(entry.guid).toLowerCase()));
    const missing = [...expected].filter((guid) => !published.has(guid)).sort();
    if (missing.length > 0) {
      throw new Error(
        `preview pack catalog is missing authored asset GUIDs: ${missing.slice(0, 8).join(', ')}`
        + (missing.length > 8 ? ` (+${missing.length - 8} more)` : ''),
      );
    }
  }
  return { entryCount: entries.length, packageFiles: [...packageFiles].sort() };
}

export function previewPayloadDigest(outputRoot: string): string {
  const files = filesUnder(outputRoot)
    .map((path) => ({
      path: relative(outputRoot, path).split(sep).join('/'),
      sha256: sha256File(path),
    }))
    .filter((file) => file.path !== 'preview-manifest.json')
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error(`preview output has no payload files: ${outputRoot}`);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function readPreviewManifest(outputRoot: string): PreviewBuildManifestRecord {
  const manifestPath = join(outputRoot, 'preview-manifest.json');
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`preview manifest is missing: ${manifestPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`preview manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION
    || typeof value.gameId !== 'string'
    || !isSha256(value.buildHash)
    || typeof value.runtimeVersion !== 'string'
    || typeof value.engineCommit !== 'string'
    || !/^[a-f0-9]{7,64}$/iu.test(value.engineCommit)
    || typeof value.projectRoot !== 'string'
    || !isAbsolute(value.projectRoot)
    || typeof value.gameRoot !== 'string'
    || !isAbsolute(value.gameRoot)
    || typeof value.outputRoot !== 'string'
    || !isAbsolute(value.outputRoot)
    || !isSha256(value.payloadDigest)
  ) {
    throw new Error(`invalid preview manifest (expected schema ${PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION})`);
  }
  return {
    schemaVersion: PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION,
    gameId: value.gameId,
    buildHash: value.buildHash.toLowerCase(),
    runtimeVersion: value.runtimeVersion,
    engineCommit: value.engineCommit,
    projectRoot: value.projectRoot,
    gameRoot: value.gameRoot,
    outputRoot: value.outputRoot,
    payloadDigest: value.payloadDigest.toLowerCase(),
  };
}

export function validatePreviewOutput(outputRoot: string, gameRoot?: string): PreviewPackValidation {
  const indexPath = join(outputRoot, 'index.html');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`preview entrypoint is missing: ${indexPath}`);
  }
  const validation = validatePreviewPack(outputRoot, gameRoot);
  const manifest = readPreviewManifest(outputRoot);
  const actualDigest = previewPayloadDigest(outputRoot);
  if (actualDigest !== manifest.payloadDigest) {
    throw new Error(`preview payload digest mismatch: ${outputRoot}`);
  }
  return validation;
}
