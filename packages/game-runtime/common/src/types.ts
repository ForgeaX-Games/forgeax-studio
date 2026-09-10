export const RUNTIME_MANIFEST_VERSION = 2 as const;
export const DEFAULT_RUNTIME_ID = 'forgeax-game-runtime';
export const PREVIEW_BUILD_HASH_INPUT_VERSION = 2 as const;
export const PREVIEW_BUILD_MANIFEST_VERSION = 2 as const;
export const PREVIEW_HEALTH_VERSION = 2 as const;

export interface RuntimeMachine {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface RuntimeCapability {
  readonly script: string;
}

export interface RuntimeCapabilities {
  readonly build: RuntimeCapability;
  readonly serve: RuntimeCapability;
}

export interface RuntimeArtifact {
  readonly runtimeId?: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform | 'any';
  readonly arch?: string | 'any';
  readonly source: string;
  readonly sha256: string;
  readonly engineCommit: string;
  readonly capabilities: RuntimeCapabilities;
  readonly format?: 'file' | 'archive';
  /** Retained while the v1 installer still launches the extracted Runtime directly. */
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface RuntimeManifest {
  readonly schemaVersion: typeof RUNTIME_MANIFEST_VERSION;
  readonly runtimeId: string;
  readonly artifacts: readonly RuntimeArtifact[];
}

export interface InstalledRuntime {
  readonly runtimeId: string;
  readonly version: string;
  readonly root: string;
  readonly artifactPath?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sha256: string;
  readonly engineCommit: string;
  readonly capabilities: RuntimeCapabilities;
  readonly platform: string;
  readonly arch: string;
}

export interface RuntimeLauncher {
  readonly runtime: InstalledRuntime;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface EngineSdkInstall {
  readonly changed: boolean;
  readonly sdkRoot: string;
  readonly engineCommit?: string;
  readonly sourceRoot?: string;
}

export interface PreviewBuildHashFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PreviewBuildHashInput {
  readonly schemaVersion: typeof PREVIEW_BUILD_HASH_INPUT_VERSION;
  readonly gameId: string;
  readonly runtimeVersion: string;
  readonly engineCommit: string;
  readonly files: readonly PreviewBuildHashFile[];
}

export interface PreviewIdentity {
  readonly gameId: string;
  readonly buildHash: string;
  readonly runtimeVersion: string;
  readonly engineCommit: string;
  readonly projectRoot: string;
  readonly gameRoot: string;
  readonly outputRoot: string;
  readonly payloadDigest: string;
}

export interface PreviewBuildManifest extends PreviewIdentity {
  readonly schemaVersion: typeof PREVIEW_BUILD_MANIFEST_VERSION;
}

export interface PreviewHealthIdentity extends PreviewIdentity {
  readonly schemaVersion: typeof PREVIEW_HEALTH_VERSION;
  readonly status: 'ok';
}
