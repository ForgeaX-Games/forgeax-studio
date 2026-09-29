import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ENGINE_COMMIT, ENGINE_SDK_PACKAGE, ENGINE_VERSION, PNPM_VERSION } from './constants';

const SDK_MANIFEST_SCHEMA = '1.8.0';
const SDK_CLI_RELATIVE = ['bin', 'forgeax.mjs'] as const;
const CARRIER_ENVIRONMENT_ALLOWLIST = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_globalconfig',
  'NPM_CONFIG_GLOBALCONFIG',
  'npm_config_cafile',
  'NPM_CONFIG_CAFILE',
  'npm_config_ca',
  'NPM_CONFIG_CA',
  'npm_config_cert',
  'NPM_CONFIG_CERT',
  'npm_config_key',
  'NPM_CONFIG_KEY',
  'npm_config_strict_ssl',
  'NPM_CONFIG_STRICT_SSL',
  'npm_config_proxy',
  'NPM_CONFIG_PROXY',
  'npm_config_https_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_http_proxy',
  'NPM_CONFIG_HTTP_PROXY',
  'npm_config_noproxy',
  'NPM_CONFIG_NOPROXY',
  'npm_config_offline',
  'NPM_CONFIG_OFFLINE',
  'npm_config_prefer_offline',
  'NPM_CONFIG_PREFER_OFFLINE',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'npm_config_store_dir',
  'NPM_CONFIG_STORE_DIR',
] as const;
const CARRIER_ENVIRONMENT_EXCLUDE = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'FORGEAX_SDK_ROOT',
  'npm_execpath',
  'NPM_EXEC_PATH',
  'npm_node_execpath',
  'NPM_NODE_EXEC_PATH',
  'npm_config_execpath',
  'NPM_CONFIG_EXECPATH',
  'npm_config_node_execpath',
  'NPM_CONFIG_NODE_EXECPATH',
  'npm_config_node_options',
  'NPM_CONFIG_NODE_OPTIONS',
  'npm_config_script_shell',
  'NPM_CONFIG_SCRIPT_SHELL',
  'npm_config_shell',
  'NPM_CONFIG_SHELL',
  'npm_config_prefix',
  'NPM_CONFIG_PREFIX',
  'PNPM_HOME',
  'pnpm_home',
  'COREPACK_HOME',
  'COREPACK_BIN_PATH',
] as const;

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly bin?: unknown;
}

interface SdkManifest {
  readonly schemaVersion?: unknown;
  readonly sdkVersion?: unknown;
  readonly engineCommit?: unknown;
  readonly requirements?: { readonly pnpm?: unknown };
  readonly packages?: readonly { readonly name?: unknown; readonly version?: unknown }[];
}

export interface EngineSdkCarrier {
  readonly pluginRoot: string;
  readonly root: string;
  readonly sdkRoot: string;
  readonly cliPath: string;
  readonly pnpmRoot: string;
  readonly pnpmCliPath: string;
  readonly sdkManifest: SdkManifest;
}

/**
 * Test fixtures may point resolution at a complete fake Game Plugin installation.
 * Production callers leave this unset: the root is found from this package module,
 * and all dependencies are resolved with Node's own package graph from that root.
 */
export interface CarrierResolutionOptions {
  readonly pluginRoot?: string;
}

interface PackageLocation {
  readonly root: string;
  readonly manifest: PackageManifest;
}

function packageJson(path: string): PackageManifest {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-an-object');
    return value as PackageManifest;
  } catch (error) {
    throw new Error(
      `engine_sdk_manifest_invalid: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalRegularFile(path: string, code: string, root: string): string {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${code}: ${path}`);
  const canonical = realpathSync(path);
  if (!confined(root, canonical)) throw new Error(`${code}_escape: ${canonical}`);
  return canonical;
}

function pluginRootFromModule(): string {
  let cursor = resolve(dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    const manifestPath = resolve(cursor, 'package.json');
    try {
      if (packageJson(manifestPath).name === '@forgeax/game') return realpathSync(cursor);
    } catch {
      /* Continue towards the package root; the final error is explicit below. */
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('engine_sdk_plugin_missing: cannot locate @forgeax/game package root');
    cursor = parent;
  }
}

function manifestFromEntry(entry: string, name: string): string {
  let cursor = resolve(dirname(entry));
  for (;;) {
    const manifestPath = resolve(cursor, 'package.json');
    try {
      if (packageJson(manifestPath).name === name) return realpathSync(manifestPath);
    } catch {
      /* Keep walking in case a package entry points through a nested dist folder. */
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`engine_sdk_dependency_invalid: ${name} package.json was not found`);
    cursor = parent;
  }
}

function installationRoot(pluginRoot: string): string {
  let cursor = pluginRoot;
  let found: string | undefined;
  for (;;) {
    if (basename(cursor) === 'node_modules') found = cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (found === undefined) {
    throw new Error(`engine_sdk_install_root_missing: ${pluginRoot} is not inside a node_modules installation`);
  }
  return realpathSync(found);
}

function resolveDependency(
  pluginRoot: string,
  installRoot: string,
  name: string,
  missingCode: string,
): PackageLocation {
  const packageRequire = createRequire(resolve(pluginRoot, 'package.json'));
  let manifestPath: string;
  try {
    try {
      manifestPath = packageRequire.resolve(`${name}/package.json`, { paths: [pluginRoot] });
    } catch {
      manifestPath = manifestFromEntry(packageRequire.resolve(name, { paths: [pluginRoot] }), name);
    }
  } catch (error) {
    throw new Error(
      `${missingCode}: ${name} is not installed in the Game Plugin dependency graph${
        error instanceof Error ? ` (${error.message})` : ''
      }`,
    );
  }
  const canonicalManifest = realpathSync(manifestPath);
  const root = realpathSync(dirname(canonicalManifest));
  if (!confined(installRoot, pluginRoot) || !confined(installRoot, root)) {
    throw new Error(`engine_sdk_dependency_escape: ${name} resolves outside the Game Plugin installation root`);
  }
  return { root, manifest: packageJson(canonicalManifest) };
}

function sdkManifest(path: string): SdkManifest {
  const value = packageJson(path) as SdkManifest;
  const packageEntries = Array.isArray(value.packages) ? value.packages : [];
  const requiredPackages = new Map<string, unknown>();
  const packageNames = new Set<string>();
  let packagesValid = Array.isArray(value.packages);
  for (const entry of packageEntries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      packagesValid = false;
      continue;
    }
    const name = (entry as { readonly name?: unknown }).name;
    const version = (entry as { readonly version?: unknown }).version;
    if (
      typeof name !== 'string' ||
      typeof version !== 'string' ||
      packageNames.has(name)
    ) {
      packagesValid = false;
    } else {
      packageNames.add(name);
      requiredPackages.set(name, version);
    }
  }
  if (
    !packagesValid ||
    value.schemaVersion !== SDK_MANIFEST_SCHEMA ||
    value.sdkVersion !== ENGINE_VERSION ||
    value.engineCommit !== ENGINE_COMMIT ||
    value.requirements?.pnpm !== PNPM_VERSION ||
    requiredPackages.get('@forgeax/engine') !== ENGINE_VERSION ||
    requiredPackages.get('@forgeax/engine-devkit') !== ENGINE_VERSION
  ) {
    throw new Error('engine_sdk_manifest_mismatch: carrier does not identify the approved Engine/DevKit/pnpm set');
  }
  return value;
}

function packageBin(manifest: PackageManifest, name: string): string {
  if (typeof manifest.bin === 'string') return manifest.bin;
  if (manifest.bin !== null && typeof manifest.bin === 'object') {
    const value = (manifest.bin as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`engine_sdk_cli_invalid: ${name} package does not declare a ${name} binary`);
}

/**
 * Resolve the SDK and package manager from this plugin's installed dependency graph.
 * No PATH search, source checkout, environment-selected SDK root, or game-local
 * carrier is accepted here.
 */
export function resolveGamePluginCarrier(options: CarrierResolutionOptions = {}): EngineSdkCarrier {
  const configuredRoot = resolve(options.pluginRoot ?? pluginRootFromModule());
  let pluginRoot: string;
  try {
    pluginRoot = realpathSync(configuredRoot);
  } catch (error) {
    throw new Error(
      `engine_sdk_plugin_missing: cannot read Game Plugin root ${configuredRoot}${
        error instanceof Error ? ` (${error.message})` : ''
      }`,
    );
  }
  const plugin = packageJson(resolve(pluginRoot, 'package.json'));
  const installRoot = installationRoot(pluginRoot);
  if (!confined(installRoot, pluginRoot)) {
    throw new Error(`engine_sdk_plugin_escape: ${pluginRoot} is outside its installation root`);
  }
  if (plugin.name !== '@forgeax/game') throw new Error(`engine_sdk_plugin_invalid: ${pluginRoot}`);
  if (plugin.dependencies?.[ENGINE_SDK_PACKAGE] !== ENGINE_VERSION) {
    throw new Error(`engine_sdk_dependency_mismatch: ${ENGINE_SDK_PACKAGE} must be ${ENGINE_VERSION}`);
  }
  if (plugin.dependencies?.pnpm !== PNPM_VERSION) {
    throw new Error(`pnpm_dependency_mismatch: pnpm must be ${PNPM_VERSION}`);
  }

  const carrier = resolveDependency(pluginRoot, installRoot, ENGINE_SDK_PACKAGE, 'engine_sdk_carrier_missing');
  if (carrier.manifest.name !== ENGINE_SDK_PACKAGE || carrier.manifest.version !== ENGINE_VERSION) {
    throw new Error(`engine_sdk_carrier_mismatch: installed SDK carrier must be ${ENGINE_SDK_PACKAGE}@${ENGINE_VERSION}`);
  }
  const sdkRoot = resolve(carrier.root, 'sdk');
  if (!existsSync(sdkRoot) || !lstatSync(sdkRoot).isDirectory()) {
    throw new Error(`engine_sdk_root_missing: ${sdkRoot}`);
  }
  const canonicalSdkRoot = realpathSync(sdkRoot);
  if (!confined(carrier.root, canonicalSdkRoot)) throw new Error('engine_sdk_root_escape: SDK root escaped carrier');
  const manifest = sdkManifest(resolve(canonicalSdkRoot, 'sdk-manifest.json'));
  const cliPath = canonicalRegularFile(resolve(canonicalSdkRoot, ...SDK_CLI_RELATIVE), 'engine_sdk_cli_invalid', canonicalSdkRoot);

  const pnpm = resolveDependency(pluginRoot, installRoot, 'pnpm', 'pnpm_missing');
  if (pnpm.manifest.name !== 'pnpm' || pnpm.manifest.version !== PNPM_VERSION) {
    throw new Error(`pnpm_version_mismatch: installed pnpm must be ${PNPM_VERSION}`);
  }
  const pnpmCliPath = canonicalRegularFile(
    resolve(pnpm.root, packageBin(pnpm.manifest, 'pnpm')),
    'pnpm_cli_invalid',
    pnpm.root,
  );

  return {
    pluginRoot,
    root: carrier.root,
    sdkRoot: canonicalSdkRoot,
    cliPath,
    pnpmRoot: pnpm.root,
    pnpmCliPath,
    sdkManifest: manifest,
  };
}

export interface CarrierCommandEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly command: string;
  readonly ok: true;
  readonly value: Record<string, unknown>;
}

export interface CarrierBootstrapResult {
  readonly carrier: EngineSdkCarrier;
  readonly init: CarrierCommandEnvelope;
  readonly created: CarrierCommandEnvelope;
}

function emptyTarget(targetRoot: string): string {
  const absolute = resolve(targetRoot);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) {
    throw new Error(`project_target_invalid: ${absolute} must be an existing directory`);
  }
  const entries = readdirSync(absolute);
  if (entries.length !== 0) throw new Error(`project_target_not_empty: ${absolute}`);
  // Preserve the caller's absolute spelling for the SDK `new` argv. The SDK itself
  // performs its canonical containment check; the Plugin only needs to establish
  // that this current directory has zero entries before resolving/spawning anything.
  return absolute;
}

function createPnpmShim(pnpmCliPath: string): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax-game-pnpm-'));
  try {
    if (process.platform === 'win32') {
      const path = resolve(root, 'pnpm.cmd');
      writeFileSync(path, `@echo off\r\n"${process.execPath}" "${pnpmCliPath}" %*\r\n`, 'utf8');
    } else {
      const path = resolve(root, 'pnpm');
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpmCliPath)} "$@"\n`, 'utf8');
      chmodSync(path, 0o755);
    }
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function carrierEnvironment(pnpmShimRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CARRIER_ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const systemPath = process.platform === 'win32'
    ? [dirname(process.execPath), 'C:\\Windows\\System32', 'C:\\Windows']
    : [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  environment.FORGEAX_DISABLE_UPDATE_CHECK = '1';
  environment.PATH = [pnpmShimRoot, ...new Set(systemPath)].join(delimiter);
  // Keep this explicit list next to the allowlist so newly-added operational
  // variables cannot accidentally become execution or module-resolution overrides.
  for (const key of CARRIER_ENVIRONMENT_EXCLUDE) delete environment[key];
  return environment;
}

interface CarrierProcessOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCarrierProcess(
  carrier: EngineSdkCarrier,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CarrierProcessOutput> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      process.execPath,
      ['./bin/forgeax.mjs', ...args],
      {
        cwd: carrier.sdkRoot,
        env: environment,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        if (error !== null && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          rejectOutput(new Error(`engine_sdk_${args[0]}_failed: output exceeded 32 MiB`));
          return;
        }
        resolveOutput({ status, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseSuccessEnvelope(output: string, command: string): CarrierCommandEnvelope {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: expected exactly one JSON success envelope`);
  }
  let value: unknown;
  try {
    // The carrier may pretty-print one envelope across several physical lines.
    // Parsing the complete trimmed stream accepts that form while rejecting any
    // prefix/suffix output because JSON.parse requires one complete JSON value.
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== undefined ||
    (value as Record<string, unknown>).command !== `project ${command}` ||
    !Array.isArray((value as Record<string, unknown>).artifacts) ||
    (value as Record<string, unknown>).ok !== true ||
    (value as Record<string, unknown>).value === null ||
    typeof (value as Record<string, unknown>).value !== 'object' ||
    Array.isArray((value as Record<string, unknown>).value)
  ) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: expected one ${command} success envelope`);
  }
  return value as CarrierCommandEnvelope;
}

function failureDetail(output: CarrierProcessOutput, command: string): string {
  const trimmed = output.stdout.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = (parsed as Record<string, unknown>).error;
        if (error !== undefined) return JSON.stringify(error);
      }
    } catch {
      /* Use stderr/text below when the failure frame itself is malformed. */
    }
  }
  return output.stderr.trim() || output.stdout.trim() || `exit status ${output.status} during ${command}`;
}

function assertIdentity(command: string, envelope: CarrierCommandEnvelope, targetRoot?: string): void {
  const value = envelope.value;
  const commitValid = command === 'init'
    ? value.engineCommit === ENGINE_COMMIT
    : value.engineCommit === undefined || value.engineCommit === ENGINE_COMMIT;
  const pnpmValid = command === 'init'
    ? value.pnpm === PNPM_VERSION
    : value.pnpm === undefined || value.pnpm === PNPM_VERSION;
  if (value.sdkVersion !== ENGINE_VERSION || !commitValid || !pnpmValid) {
    throw new Error(`engine_sdk_${command}_identity_mismatch: expected ${ENGINE_VERSION}/${ENGINE_COMMIT}`);
  }
  if (targetRoot !== undefined && (value.root !== targetRoot || value.template !== 'empty')) {
    throw new Error(`engine_sdk_${command}_identity_mismatch: created project root/template was not ${targetRoot}/empty`);
  }
}

/**
 * Run the tested SDK-root sequence. This function never removes files from the target;
 * any partial artifacts and the carrier's own exact error remain available for repair.
 */
export async function createEmptyGameWithCarrier(
  targetRoot: string,
  options: CarrierResolutionOptions = {},
): Promise<CarrierBootstrapResult> {
  const target = emptyTarget(targetRoot);
  const carrier = resolveGamePluginCarrier(options);
  const shim = createPnpmShim(carrier.pnpmCliPath);
  const environment = carrierEnvironment(shim.root);
  try {
    const initOutput = await runCarrierProcess(carrier, ['project', 'init', '--json'], environment);
    if (initOutput.status !== 0) {
      throw new Error(`engine_sdk_init_failed: ${failureDetail(initOutput, 'init')}`);
    }
    const init = parseSuccessEnvelope(initOutput.stdout, 'init');
    assertIdentity('init', init);

    const newOutput = await runCarrierProcess(
      carrier,
      ['project', 'new', '--root', target, '--template', 'empty', '--json'],
      environment,
    );
    if (newOutput.status !== 0) {
      throw new Error(`engine_sdk_new_failed: ${failureDetail(newOutput, 'new')}`);
    }
    const created = parseSuccessEnvelope(newOutput.stdout, 'new');
    assertIdentity('new', created, target);
    return { carrier, init, created };
  } finally {
    shim.cleanup();
  }
}
