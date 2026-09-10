import {
  hasOnlyKeys,
  isEngineCommit,
  isNonEmptyString,
  isPortableAbsolutePath,
  isRecord,
  isSha256,
  isStableRelativePath,
} from './contract-validation';
import {
  PREVIEW_BUILD_HASH_INPUT_VERSION,
  PREVIEW_BUILD_MANIFEST_VERSION,
  PREVIEW_HEALTH_VERSION,
  type PreviewBuildHashFile,
  type PreviewBuildHashInput,
  type PreviewBuildManifest,
  type PreviewHealthIdentity,
  type PreviewIdentity,
} from './types';

const IDENTITY_KEYS = [
  'gameId',
  'buildHash',
  'runtimeVersion',
  'engineCommit',
  'projectRoot',
  'gameRoot',
  'outputRoot',
  'payloadDigest',
] as const;

function parseIdentity(value: Record<string, unknown>): PreviewIdentity {
  if (
    !isNonEmptyString(value.gameId)
    || !isSha256(value.buildHash)
    || !isNonEmptyString(value.runtimeVersion)
    || !isEngineCommit(value.engineCommit)
    || !isPortableAbsolutePath(value.projectRoot)
    || !isPortableAbsolutePath(value.gameRoot)
    || !isPortableAbsolutePath(value.outputRoot)
    || !isSha256(value.payloadDigest)
  ) {
    throw new Error('preview identity contains an invalid or missing field');
  }
  return {
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

export function parsePreviewBuildHashInput(value: unknown): PreviewBuildHashInput {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'gameId', 'runtimeVersion', 'engineCommit', 'files'])
    || value.schemaVersion !== PREVIEW_BUILD_HASH_INPUT_VERSION
    || !isNonEmptyString(value.gameId)
    || !isNonEmptyString(value.runtimeVersion)
    || !isEngineCommit(value.engineCommit)
    || !Array.isArray(value.files)
    || value.files.length === 0
  ) {
    throw new Error(`invalid preview build hash input (expected schema ${PREVIEW_BUILD_HASH_INPUT_VERSION})`);
  }
  const files: PreviewBuildHashFile[] = value.files.map((file) => {
    if (
      !isRecord(file)
      || !hasOnlyKeys(file, ['path', 'sha256'])
      || !isStableRelativePath(file.path)
      || !isSha256(file.sha256)
    ) {
      throw new Error('preview build hash input contains an invalid file');
    }
    return { path: file.path, sha256: file.sha256.toLowerCase() };
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    throw new Error('preview build hash input files must be unique and sorted by path');
  }
  return {
    schemaVersion: PREVIEW_BUILD_HASH_INPUT_VERSION,
    gameId: value.gameId,
    runtimeVersion: value.runtimeVersion,
    engineCommit: value.engineCommit,
    files,
  };
}

export function parsePreviewBuildManifest(value: unknown): PreviewBuildManifest {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', ...IDENTITY_KEYS])
    || value.schemaVersion !== PREVIEW_BUILD_MANIFEST_VERSION
  ) {
    throw new Error(`invalid preview build manifest (expected schema ${PREVIEW_BUILD_MANIFEST_VERSION})`);
  }
  return {
    schemaVersion: PREVIEW_BUILD_MANIFEST_VERSION,
    ...parseIdentity(value),
  };
}

export function parsePreviewHealthIdentity(value: unknown): PreviewHealthIdentity {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'status', ...IDENTITY_KEYS])
    || value.schemaVersion !== PREVIEW_HEALTH_VERSION
    || value.status !== 'ok'
  ) {
    throw new Error(`invalid preview health identity (expected schema ${PREVIEW_HEALTH_VERSION})`);
  }
  return {
    schemaVersion: PREVIEW_HEALTH_VERSION,
    status: 'ok',
    ...parseIdentity(value),
  };
}
