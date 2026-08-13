export const RUNTIME_MANIFEST_VERSION = 1 as const;
export const DEFAULT_RUNTIME_ID = 'forgeax-game-runtime';

export interface RuntimeMachine {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface RuntimeArtifact {
  readonly runtimeId?: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform | 'any';
  readonly arch?: string | 'any';
  readonly source: string;
  readonly sha256: string;
  readonly format?: 'file' | 'archive';
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
