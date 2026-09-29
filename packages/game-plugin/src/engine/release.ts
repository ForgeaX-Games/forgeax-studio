import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ENGINE_COMMIT, ENGINE_SDK_PACKAGE, ENGINE_VERSION } from './constants';
import { resolveGamePluginCarrier, type CarrierResolutionOptions } from './carrier';

export { ENGINE_COMMIT, ENGINE_SDK_PACKAGE, ENGINE_VERSION } from './constants';

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly forgeax?: { readonly engineCommit?: unknown };
}

export interface EngineRelease {
  readonly gameRoot: string;
  readonly packageRoot: string;
  readonly cliPath: string;
  readonly carrierRoot: string;
  readonly version: typeof ENGINE_VERSION;
  readonly commit: typeof ENGINE_COMMIT;
}

function readManifest(path: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `engine_release_manifest_invalid: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`engine_release_manifest_invalid: ${path} is not a JSON object`);
  }
  return value as PackageManifest;
}

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function exactPackage(root: string, name: string): { root: string; manifest: PackageManifest } {
  const parts = name.slice(1).split('/');
  const packageRoot = resolve(root, 'node_modules', `@${parts[0]}`, parts[1]!);
  const manifestPath = resolve(packageRoot, 'package.json');
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new Error(`engine_release_missing: ${name} is not installed under ${root}`);
  }
  const canonicalRoot = realpathSync(packageRoot);
  const canonicalModules = realpathSync(resolve(root, 'node_modules'));
  if (!confined(canonicalModules, canonicalRoot)) {
    throw new Error(`engine_release_escape: ${name} resolves outside the game node_modules tree`);
  }
  return { root: canonicalRoot, manifest: readManifest(realpathSync(manifestPath)) };
}

/**
 * Resolve the only Engine package and CLI G0 is allowed to execute. The
 * validated SDK carrier manifest supplies the exact DevKit identity; the SDK
 * carrier and pnpm are resolved from this installed Game Plugin's dependency graph.
 *
 * The lookup starts at the external game, never PATH, a workspace checkout, Editor,
 * Studio, npx, or a mutable environment override. Package identity is checked before
 * a byte of CLI code is executed.
 */
export function resolveEngineRelease(
  gameRoot: string,
  options: CarrierResolutionOptions = {},
): EngineRelease {
  const canonicalGameRoot = realpathSync(resolve(gameRoot));
  const gameManifest = readManifest(resolve(canonicalGameRoot, 'package.json'));
  const declared = gameManifest.dependencies?.['@forgeax/engine'];
  if (declared !== ENGINE_VERSION) {
    throw new Error(
      `engine_release_mismatch: game declares @forgeax/engine=${String(declared)}, expected ${ENGINE_VERSION}`,
    );
  }

  const engine = exactPackage(canonicalGameRoot, '@forgeax/engine');
  if (engine.manifest.name !== '@forgeax/engine' || engine.manifest.version !== ENGINE_VERSION) {
    throw new Error(
      `engine_release_mismatch: installed Engine must be @forgeax/engine@${ENGINE_VERSION} from ${ENGINE_COMMIT}`,
    );
  }

  const carrier = resolveGamePluginCarrier(options);
  const carrierCommit = carrier.sdkManifest.engineCommit;
  if (carrierCommit !== ENGINE_COMMIT) {
    throw new Error(`engine_release_mismatch: SDK carrier does not identify Engine commit ${ENGINE_COMMIT}`);
  }
  const declaredCommit = engine.manifest.forgeax?.engineCommit;
  if (declaredCommit !== undefined && declaredCommit !== carrierCommit) {
    throw new Error(
      `engine_release_mismatch: installed Engine declares ${String(declaredCommit)}, expected ${String(carrierCommit)}`,
    );
  }

  const cliPath = resolve(engine.root, 'dist', 'bin', 'forgeax.mjs');
  if (!existsSync(cliPath) || !lstatSync(cliPath).isFile()) {
    throw new Error(`engine_cli_missing: ${cliPath}`);
  }
  const canonicalCli = realpathSync(cliPath);
  if (!confined(engine.root, canonicalCli)) {
    throw new Error('engine_cli_escape: Engine CLI resolves outside @forgeax/engine');
  }

  return {
    gameRoot: canonicalGameRoot,
    packageRoot: engine.root,
    cliPath: canonicalCli,
    carrierRoot: carrier.root,
    version: ENGINE_VERSION,
    commit: ENGINE_COMMIT,
  };
}
