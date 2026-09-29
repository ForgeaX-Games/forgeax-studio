import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION, resolveEngineRelease } from '../../../src/engine/release';
import {
  INSTALL_SCHEMA,
  MAX_JSON_BYTES,
  PROVENANCE_SCHEMA,
  TRANSACTION_SCHEMA,
  canonicalJson,
  sha256,
} from './constants';
import { atomicWrite, ensurePrivateDir } from './fs';
import { parseProviderResult, type ManifestEntry, type ProviderSuccess } from './schema';
import { readAsset3dConfig, type Asset3dInstallManifest } from './install';
import { parseEnvelope } from '../../../src/run/engine-preview';
import { readPackBuildCatalog } from './pack-readback';

type TransactionState = 'begun' | 'provider_complete' | 'validated' | 'committing' | 'engine_verified' | 'committed' | 'complete' | 'failed' | 'rolled_back' | 'aborted';

interface Journal {
  readonly schemaVersion: typeof TRANSACTION_SCHEMA;
  readonly execution: string;
  readonly queryDigest: string;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly engineCommit: string;
  readonly allowedQuarantineRoot: string;
  readonly requestedCount: number;
  readonly createdAt: string;
  readonly state: TransactionState;
  readonly destination?: string;
  readonly backupPath?: string;
  readonly previousDigest?: string;
  readonly newDigest?: string;
  readonly error?: string;
}

interface EngineEnvelope {
  readonly schemaVersion?: unknown;
  readonly command?: unknown;
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: unknown;
}

export interface BeginResult {
  readonly execution: string;
  readonly output_dir: string;
}

export interface Asset3dRuntimeOptions {
  /** Test-only installed carrier fixture; production leaves this unset. */
  readonly carrierPluginRoot?: string;
}

export interface CommitOptions {
  readonly projectRoot: string;
  readonly execution: string;
  readonly providerResult?: string | Uint8Array;
  readonly refresh?: boolean;
  readonly lockTimeoutMs?: number;
  readonly carrierPluginRoot?: string;
}

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function forgeaxRoot(projectRoot: string): string { return resolve(projectRoot, '.forgeax/extensions/asset3d/data'); }
function journalPath(projectRoot: string, execution: string): string { return resolve(forgeaxRoot(projectRoot), 'asset3d-transactions', `${execution}.json`); }
function providerResultPath(projectRoot: string, execution: string): string {
  return resolve(forgeaxRoot(projectRoot), 'asset3d-results', `${execution}.json`);
}

const readInstall = readAsset3dConfig;

function readJournal(projectRoot: string, execution: string): Journal {
  if (!/^[0-9a-f-]{36}$/.test(execution)) throw new Error('asset3d_execution_invalid');
  let journal: Journal;
  try { journal = JSON.parse(readFileSync(journalPath(projectRoot, execution), 'utf8')) as Journal; }
  catch { throw new Error('asset3d_execution_not_found'); }
  if (journal.schemaVersion !== TRANSACTION_SCHEMA || journal.execution !== execution) throw new Error('asset3d_journal_invalid');
  return journal;
}

function updateJournal(projectRoot: string, journal: Journal, patch: Partial<Journal>): Journal {
  const next = { ...journal, ...patch } as Journal;
  atomicWrite(journalPath(projectRoot, journal.execution), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function beginAsset3d(
  projectRootInput: string,
  queries: readonly string[],
  options: Asset3dRuntimeOptions = {},
): BeginResult {
  const projectRoot = realpathSync(projectRootInput);
  if (queries.length < 1 || queries.length > 16 || queries.some((query) => [...query].length < 1 || [...query].length > 200)) {
    throw new Error('asset3d_queries_invalid: expected 1..16 queries of 1..200 characters');
  }
  const install = readInstall(projectRoot);
  const release = resolveEngineRelease(
    projectRoot,
    options.carrierPluginRoot === undefined ? {} : { pluginRoot: options.carrierPluginRoot },
  );
  const execution = randomUUID();
  const relativeOutput = `workspace/asset3d/${execution}`;
  const quarantine = resolve(projectRoot, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine');
  const allowedQuarantineRoot = resolve(quarantine, relativeOutput);
  ensurePrivateDir(resolve(projectRoot, '.forgeax/extensions/asset3d/data', 'asset3d-transactions'));
  ensurePrivateDir(allowedQuarantineRoot);
  const journal: Journal = {
    schemaVersion: TRANSACTION_SCHEMA,
    execution,
    queryDigest: sha256(canonicalJson(queries)),
    adapterVersion: install.adapterVersion,
    engineVersion: release.version,
    engineCommit: release.commit,
    allowedQuarantineRoot,
    requestedCount: queries.length,
    createdAt: new Date().toISOString(),
    state: 'begun',
  };
  atomicWrite(journalPath(projectRoot, execution), `${JSON.stringify(journal, null, 2)}\n`);
  return { execution, output_dir: relativeOutput };
}

export function asset3dSearchOutputDir(
  projectRootInput: string,
  execution: string,
  queries: readonly string[],
): string {
  const projectRoot = realpathSync(projectRootInput);
  const journal = readJournal(projectRoot, execution);
  if (journal.state !== 'begun') {
    throw new Error(`asset3d_execution_state_invalid: ${journal.state}`);
  }
  if (
    queries.length !== journal.requestedCount ||
    sha256(canonicalJson(queries)) !== journal.queryDigest
  ) {
    throw new Error('asset3d_search_query_identity_mismatch');
  }
  const outputDir = `workspace/asset3d/${execution}`;
  const expectedRoot = resolve(forgeaxRoot(projectRoot), 'asset3d-quarantine', outputDir);
  if (
    journal.allowedQuarantineRoot !== expectedRoot ||
    !existsSync(expectedRoot) ||
    realpathSync(expectedRoot) !== expectedRoot
  ) {
    throw new Error('asset3d_search_output_identity_mismatch');
  }
  return outputDir;
}

export function recordAsset3dProviderResult(
  projectRootInput: string,
  execution: string,
  providerResult: string,
): void {
  const projectRoot = realpathSync(projectRootInput);
  const journal = readJournal(projectRoot, execution);
  if (journal.state !== 'begun') {
    throw new Error(`asset3d_execution_state_invalid: ${journal.state}`);
  }
  const bytes = Buffer.byteLength(providerResult);
  if (bytes < 1 || bytes > MAX_JSON_BYTES) {
    throw new Error('provider_result_too_large: expected 1 byte..1 MiB');
  }
  ensurePrivateDir(resolve(forgeaxRoot(projectRoot), 'asset3d-results'));
  atomicWrite(providerResultPath(projectRoot, execution), providerResult, 0o600);
  updateJournal(projectRoot, journal, { state: 'provider_complete' });
}

function fileBytesChecked(root: string, entry: ManifestEntry): Buffer {
  const source = resolve(root, entry.path);
  if (!confined(root, source)) throw new Error('asset_manifest_escape');
  const canonicalRoot = realpathSync(root);
  const canonicalSource = realpathSync(source);
  if (!confined(canonicalRoot, canonicalSource)) throw new Error('asset_manifest_escape');
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('asset_manifest_not_regular');
  const fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== entry.bytes) throw new Error('asset_manifest_bytes_mismatch');
    const bytes = readFileSync(fd);
    if (sha256(bytes) !== entry.sha256) throw new Error('asset_manifest_digest_mismatch');
    return bytes;
  } finally { closeSync(fd); }
}

function acquireLock(projectRoot: string, assetId: string, timeoutMs: number): () => void {
  const root = resolve(forgeaxRoot(projectRoot), 'asset3d-locks');
  ensurePrivateDir(root);
  const path = resolve(root, `${assetId}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
          if (current.token === token) unlinkSync(path);
        } catch { /* never remove a lock whose ownership cannot be re-proved */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('asset_busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100, deadline - Date.now()));
    }
  }
}

function engineCommand(projectRoot: string, args: readonly string[], carrierPluginRoot?: string): EngineEnvelope {
  const release = resolveEngineRelease(
    projectRoot,
    carrierPluginRoot === undefined ? {} : { pluginRoot: carrierPluginRoot },
  );
  const result = spawnSync(process.execPath, [release.cliPath, ...args], {
    cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 + 1, timeout: 150_000,
  });
  const stdout = result.stdout ?? '';
  if (Buffer.byteLength(stdout) > 1024 * 1024) throw new Error('engine_envelope_too_large');
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1 || !stdout.endsWith('\n')) throw new Error('engine_terminal_envelope_invalid');
  let envelope: EngineEnvelope;
  try { envelope = JSON.parse(lines[0]!) as EngineEnvelope; } catch { throw new Error('engine_terminal_envelope_invalid'); }
  if (envelope.schemaVersion !== '1.0.0' || typeof envelope.command !== 'string' || typeof envelope.ok !== 'boolean') {
    throw new Error('engine_terminal_envelope_invalid');
  }
  if (result.status !== 0 || envelope.ok !== true) {
    throw new Error(`engine_${String(envelope.command).replace('.', '_')}_failed:${canonicalJson(envelope.error ?? { exitCode: result.status })}`);
  }
  return envelope;
}

interface EngineAddedAsset {
  readonly source?: unknown;
  readonly metaPath?: unknown;
  readonly reused?: unknown;
  readonly subAssets?: readonly Record<string, unknown>[];
}

function engineAddedRows(projectRoot: string, asset: EngineAddedAsset): readonly Record<string, unknown>[] {
  let subAssets = asset.subAssets;
  if (!Array.isArray(subAssets)) {
    if (typeof asset.metaPath !== 'string') throw new Error('engine_readback_missing_meta');
    const metaPath = resolve(projectRoot, asset.metaPath);
    if (!confined(projectRoot, metaPath)) throw new Error('engine_readback_meta_escape');
    const canonical = realpathSync(metaPath);
    const info = lstatSync(metaPath);
    if (!confined(projectRoot, canonical) || !info.isFile() || info.isSymbolicLink()) {
      throw new Error('engine_readback_meta_invalid');
    }
    let meta: { subAssets?: unknown };
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { subAssets?: unknown }; }
    catch { throw new Error('engine_readback_meta_invalid'); }
    if (!Array.isArray(meta.subAssets)) throw new Error('engine_readback_missing_subassets');
    subAssets = meta.subAssets.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row));
  }
  const projectPath = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const absolute = resolve(projectRoot, value);
    if (!confined(projectRoot, absolute)) throw new Error('engine_readback_path_escape');
    return relative(projectRoot, absolute).split(sep).join('/');
  };
  return subAssets.map((row) => ({ source: projectPath(asset.source), metaPath: projectPath(asset.metaPath), reused: asset.reused, ...row }));
}

function engineReadback(projectRoot: string, assetRelative: string, add: EngineEnvelope | undefined, carrierPluginRoot?: string): { add?: unknown; verify: unknown; list: unknown; inspect: readonly unknown[]; rows: readonly Record<string, unknown>[] } {
  const verify = engineCommand(projectRoot, ['asset', 'verify', '--json'], carrierPluginRoot);
  const list = engineCommand(projectRoot, ['asset', 'list', '--json'], carrierPluginRoot);
  const addAssets = ((add?.value as { assets?: readonly EngineAddedAsset[] } | undefined)?.assets ?? []);
  const rows: Record<string, unknown>[] = addAssets.flatMap((asset) => engineAddedRows(projectRoot, asset));
  const guids = [...new Set(rows.flatMap((row) => typeof row.guid === 'string' ? [row.guid] : []))];
  if (add && guids.length === 0) throw new Error('engine_readback_missing_guid');
  const inspect = guids.map((guid) => engineCommand(projectRoot, ['asset', 'inspect', guid, '--json'], carrierPluginRoot).value);
  const listed = Array.isArray(list.value) ? list.value as readonly { guid?: unknown }[]
    : Array.isArray((list.value as { assets?: unknown } | undefined)?.assets)
      ? (list.value as { assets: readonly { guid?: unknown }[] }).assets : [];
  for (const guid of guids) if (!listed.some((entry) => entry.guid === guid)) throw new Error('engine_catalog_readback_missing');
  return { ...(add ? { add: add.value } : {}), verify: verify.value, list: listed, inspect, rows };
}

function packReadback(projectRoot: string, item: ProviderSuccess, carrierPluginRoot?: string) {
  const release = resolveEngineRelease(projectRoot, carrierPluginRoot === undefined ? {} : { pluginRoot: carrierPluginRoot });
  const result = spawnSync(process.execPath, [release.cliPath, 'project', 'build', '--json'], {
    cwd: projectRoot, encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('engine_pack_build_failed');
  const envelope = parseEnvelope(result.stdout, 'build');
  const prefix = `assets/3d/ea-3d/${item.providerAssetId}/`;
  return readPackBuildCatalog(projectRoot, item.manifest.map(entry => prefix + entry.path), envelope.value);
}

function priorProvenance(destination: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(resolve(destination, '.forgeax-asset.json'), 'utf8')) as Record<string, unknown>; }
  catch { return undefined; }
}

function liveFilesMatch(destination: string, item: ProviderSuccess): boolean {
  return item.manifest.every((entry) => {
    const path = resolve(destination, entry.path);
    try { return confined(destination, path) && statSync(path).isFile() && statSync(path).size === entry.bytes && sha256(readFileSync(path)) === entry.sha256; }
    catch { return false; }
  });
}

function quarantineFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('asset_quarantine_symlink_rejected');
    if (info.isDirectory()) files.push(...quarantineFiles(root, path));
    else if (info.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error('asset_quarantine_special_file_rejected');
  }
  return files;
}

function validateQuarantine(journal: Journal, items: readonly ProviderSuccess[]): void {
  const root = realpathSync(journal.allowedQuarantineRoot);
  const expected = items.flatMap((item) => item.manifest.map((entry) => entry.path)).sort();
  if (new Set(expected).size !== expected.length) throw new Error('provider_result_invalid: cross-item manifest collision');
  const actual = quarantineFiles(root).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('asset_quarantine_undeclared_file');
}

function stageItem(projectRoot: string, journal: Journal, item: ProviderSuccess, destination: string, prior?: Record<string, unknown>): string {
  const root = realpathSync(journal.allowedQuarantineRoot);
  const stageRoot = resolve(forgeaxRoot(projectRoot), 'asset3d-staging', journal.execution, item.providerAssetId);
  rmSync(stageRoot, { recursive: true, force: true });
  ensurePrivateDir(resolve(stageRoot, '..'));
  if (existsSync(destination)) cpSync(destination, stageRoot, { recursive: true, errorOnExist: true, force: false });
  else ensurePrivateDir(stageRoot);
  const nextPaths = new Set(item.manifest.map((entry) => entry.path));
  const previousFiles = Array.isArray(prior?.files) ? prior.files as readonly { relativePath?: unknown }[] : [];
  for (const previous of previousFiles) {
    if (typeof previous.relativePath !== 'string' || nextPaths.has(previous.relativePath)) continue;
    const stale = resolve(stageRoot, previous.relativePath);
    if (!confined(stageRoot, stale)) throw new Error('asset_provenance_path_escape');
    rmSync(stale, { force: true });
    // Engine owns the adjacent importer sidecar. Remove it only from the
    // transaction stage when its provider source disappears; the untouched
    // destination remains available for rollback until verification passes.
    rmSync(`${stale}.meta.json`, { force: true });
  }
  for (const entry of item.manifest) {
    const target = resolve(stageRoot, entry.path);
    if (!confined(stageRoot, target)) throw new Error('asset_manifest_escape');
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
    atomicWrite(target, fileBytesChecked(root, entry), 0o600);
  }
  return stageRoot;
}

function provenance(item: ProviderSuccess, install: Asset3dInstallManifest, readback: ReturnType<typeof engineReadback>, refreshed: boolean) {
  const rows = readback.rows;
  const sourcePrefix = `assets/3d/ea-3d/${item.providerAssetId}/`;
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    provider: 'ea-3d',
    providerAssetId: item.providerAssetId,
    adapterVersion: install.adapterVersion,
    originSetDigest: install.originSetDigest,
    aggregateSha256: item.sha256,
    bytes: item.bytes,
    deliveredFormat: item.deliveredFormat,
    ...(item.deliveredFormat === 'pack' ? { primaryPack: item.primaryPack } : { primaryModel: item.primaryModel }),
    engine: { version: ENGINE_VERSION, commit: ENGINE_COMMIT },
    refreshed,
    files: item.manifest.map((entry) => ({
      relativePath: entry.path, role: entry.role, sha256: entry.sha256, bytes: entry.bytes,
      engineRows: rows.filter((row) => row.source === `${sourcePrefix}${entry.path}`),
    })),
    catalog: { verify: readback.verify, list: readback.list, inspect: readback.inspect },
  };
}

function commitItem(projectRoot: string, initialJournal: Journal, install: Asset3dInstallManifest, item: ProviderSuccess, refresh: boolean, lockTimeoutMs: number, carrierPluginRoot?: string) {
  const destination = resolve(projectRoot, 'assets', '3d', 'ea-3d', item.providerAssetId);
  const assetRoot = resolve(projectRoot, 'assets', '3d', 'ea-3d');
  ensurePrivateDir(assetRoot);
  if (!confined(assetRoot, destination)) throw new Error('asset_destination_escape');
  const releaseLock = acquireLock(projectRoot, item.providerAssetId, lockTimeoutMs);
  let journal = initialJournal;
  try {
    const prior = priorProvenance(destination);
    const priorDigest = typeof prior?.aggregateSha256 === 'string' ? prior.aggregateSha256 : undefined;
    if (priorDigest === item.sha256 && liveFilesMatch(destination, item)) {
      const priorRows = Array.isArray((prior?.files as { engineRows?: unknown[] }[] | undefined))
        ? (prior!.files as { engineRows?: Record<string, unknown>[] }[]).flatMap((entry) => entry.engineRows ?? []) : [];
      const baseReadback = item.deliveredFormat === 'pack' ? packReadback(projectRoot, item, carrierPluginRoot)
        : engineReadback(projectRoot, `assets/3d/ea-3d/${item.providerAssetId}`, undefined, carrierPluginRoot);
      const guids = priorRows.flatMap((row) => typeof row.guid === 'string' ? [row.guid] : []);
      const listed = Array.isArray(baseReadback.list) ? baseReadback.list as readonly { guid?: unknown }[] : [];
      if (guids.length === 0 || guids.some((guid) => !listed.some((entry) => entry.guid === guid))) throw new Error('asset_reuse_readback_failed');
      const readback = item.deliveredFormat === 'pack' ? baseReadback
        : { ...baseReadback, inspect: guids.map((guid) => engineCommand(projectRoot, ['asset', 'inspect', guid, '--json'], carrierPluginRoot).value) };
      journal = updateJournal(projectRoot, journal, { state: 'committed', previousDigest: priorDigest, newDigest: item.sha256 });
      return { providerAssetId: item.providerAssetId, digest: item.sha256, bytes: item.bytes, reused: true, refreshed: false, sourcePath: relative(projectRoot, destination), provenancePath: relative(projectRoot, resolve(destination, '.forgeax-asset.json')), engine: { version: ENGINE_VERSION, commit: ENGINE_COMMIT }, catalog: readback, rows: priorRows };
    }
    if (priorDigest && priorDigest !== item.sha256 && !refresh) throw new Error('asset_changed');
    const stage = stageItem(projectRoot, journal, item, destination, prior);
    const backup = resolve(forgeaxRoot(projectRoot), 'asset3d-backups', journal.execution, item.providerAssetId);
    ensurePrivateDir(resolve(backup, '..'));
    journal = updateJournal(projectRoot, journal, { state: 'committing', destination, backupPath: existsSync(destination) ? backup : undefined, previousDigest: priorDigest, newDigest: item.sha256 });
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(stage, destination);
    try {
      const assetRelative = `assets/3d/ea-3d/${item.providerAssetId}`;
      // Authored Pack is already a source package. Engine build owns its production;
      // asset add only understands image/glTF producers in the released SDK.
      const readback = item.deliveredFormat === 'pack' ? packReadback(projectRoot, item, carrierPluginRoot)
        : engineReadback(projectRoot, assetRelative,
          engineCommand(projectRoot, ['asset', 'add', assetRelative, '--reimport-policy', 'semantic-only', '--json'], carrierPluginRoot), carrierPluginRoot);
      if (item.deliveredFormat === 'pack' && !liveFilesMatch(destination, item)) throw new Error('engine_pack_source_changed');
      atomicWrite(resolve(destination, '.forgeax-asset.json'), `${JSON.stringify(provenance(item, install, readback, priorDigest !== undefined), null, 2)}\n`);
      journal = updateJournal(projectRoot, journal, { state: 'engine_verified' });
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
      journal = updateJournal(projectRoot, journal, { state: 'committed' });
      return { providerAssetId: item.providerAssetId, digest: item.sha256, bytes: item.bytes, reused: false, refreshed: priorDigest !== undefined, sourcePath: assetRelative, provenancePath: `${assetRelative}/.forgeax-asset.json`, engine: { version: ENGINE_VERSION, commit: ENGINE_COMMIT }, catalog: readback, rows: readback.rows };
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, destination);
      updateJournal(projectRoot, journal, { state: 'rolled_back', error: error instanceof Error ? error.message.slice(0, 256) : 'engine failure' });
      throw error;
    }
  } finally { releaseLock(); }
}

export function commitAsset3d(options: CommitOptions) {
  const projectRoot = realpathSync(options.projectRoot);
  const install = readInstall(projectRoot);
  let journal = readJournal(projectRoot, options.execution);
  if (journal.state !== 'begun' && journal.state !== 'provider_complete' && journal.state !== 'validated') {
    throw new Error(`asset3d_execution_state_invalid: ${journal.state}`);
  }
  if (journal.adapterVersion !== install.adapterVersion || journal.engineCommit !== ENGINE_COMMIT || journal.engineVersion !== ENGINE_VERSION) {
    throw new Error('asset3d_execution_identity_mismatch');
  }
  let providerResult = options.providerResult;
  if (providerResult === undefined) {
    try { providerResult = readFileSync(providerResultPath(projectRoot, options.execution)); }
    catch { throw new Error('asset3d_import_result_missing'); }
  }
  let result: ReturnType<typeof parseProviderResult>;
  try {
    result = parseProviderResult(providerResult, install.adapterVersion, install.originSetDigest);
    if (result.total !== journal.requestedCount) throw new Error('provider_result_invalid: requested count mismatch');
    const orderedQueries = [...result.results]
      .sort((left, right) => left.queryIndex - right.queryIndex)
      .map((item) => item.query);
    if (sha256(canonicalJson(orderedQueries)) !== journal.queryDigest) {
      throw new Error('provider_result_invalid: query identity mismatch');
    }
    const successes = result.results.filter((item): item is ProviderSuccess => item.status === 'ok');
    // The provider always materializes the checked result in this transaction's
    // quarantine, even when the live destination can later be reused. Validate
    // every declared success before deciding whether commitItem can reuse it.
    validateQuarantine(journal, successes);
    journal = updateJournal(projectRoot, journal, { state: 'validated' });
  } catch (error) {
    rmSync(journal.allowedQuarantineRoot, { recursive: true, force: true });
    rmSync(providerResultPath(projectRoot, options.execution), { force: true });
    updateJournal(projectRoot, journal, {
      state: 'failed',
      error: error instanceof Error ? error.message.slice(0, 256) : 'provider validation failed',
    });
    throw error;
  }
  const terminal: unknown[] = [];
  for (const item of result.results) {
    if (item.status === 'error') { terminal.push(item); continue; }
    try { terminal.push({ status: 'ok', ...commitItem(projectRoot, journal, install, item, options.refresh === true, options.lockTimeoutMs ?? 30_000, options.carrierPluginRoot) }); }
    catch (error) { terminal.push({ status: 'error', providerAssetId: item.providerAssetId, code: error instanceof Error ? error.message.split(':', 1)[0] : 'internal_error', retryable: false }); }
  }
  rmSync(journal.allowedQuarantineRoot, { recursive: true, force: true });
  rmSync(providerResultPath(projectRoot, options.execution), { force: true });
  const failed = terminal.filter((entry) => (entry as { status?: unknown }).status === 'error').length;
  updateJournal(projectRoot, journal, { state: failed === 0 ? 'complete' : 'failed' });
  return {
    schemaVersion: 'forgeax.asset3d-commit-result/1.0.0', execution: journal.execution,
    succeeded: terminal.filter((entry) => (entry as { status?: unknown }).status === 'ok').length,
    failed,
    results: terminal,
  };
}

export function abortAsset3d(projectRootInput: string, execution: string): { execution: string; aborted: boolean } {
  const projectRoot = realpathSync(projectRootInput);
  const journal = readJournal(projectRoot, execution);
  if (journal.state === 'committed' || journal.state === 'complete' || journal.state === 'engine_verified') {
    throw new Error('asset3d_execution_already_committed');
  }
  rmSync(journal.allowedQuarantineRoot, { recursive: true, force: true });
  rmSync(providerResultPath(projectRoot, execution), { force: true });
  updateJournal(projectRoot, journal, { state: 'aborted' });
  return { execution, aborted: true };
}

export function doctorAsset3d(projectRootInput: string, options: Asset3dRuntimeOptions = {}): { installed: true; recovered: readonly string[]; engine: { version: string; commit: string }; adapter: { version: string; transport: 'http' }; access: 'not_checked' } {
  const projectRoot = realpathSync(projectRootInput);
  const install = readInstall(projectRoot);
  const release = resolveEngineRelease(
    projectRoot,
    options.carrierPluginRoot === undefined ? {} : { pluginRoot: options.carrierPluginRoot },
  );
  const recovered: string[] = [];
  const root = resolve(forgeaxRoot(projectRoot), 'asset3d-transactions');
  if (existsSync(root)) for (const file of readdirSync(root).filter((name) => name.endsWith('.json'))) {
    try {
      const path = resolve(root, file);
      const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
      if (journal.schemaVersion !== TRANSACTION_SCHEMA || journal.state !== 'committing' || !journal.destination) continue;
      const assetsRoot = resolve(projectRoot, 'assets', '3d', 'ea-3d');
      const backupsRoot = resolve(forgeaxRoot(projectRoot), 'asset3d-backups');
      if (!confined(assetsRoot, journal.destination) || (journal.backupPath && !confined(backupsRoot, journal.backupPath))) continue;
      rmSync(journal.destination, { recursive: true, force: true });
      if (journal.backupPath && existsSync(journal.backupPath)) renameSync(journal.backupPath, journal.destination);
      updateJournal(projectRoot, journal, { state: 'rolled_back', error: 'stale_committing_recovered' });
      recovered.push(journal.execution);
    } catch { /* malformed/unowned journals are fail-closed and left for inspection */ }
  }
  return { installed: true, recovered, engine: { version: release.version, commit: release.commit }, adapter: { version: install.adapterVersion, transport: 'http' }, access: 'not_checked' };
}
