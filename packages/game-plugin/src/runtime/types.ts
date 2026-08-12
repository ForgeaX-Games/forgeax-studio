export const RUNTIME_MANIFEST_VERSION = 1 as const;
export const DEFAULT_RUNTIME_ID = 'forgeax-game-runtime';

/** A launchable runtime artifact described by the distribution manifest. */
export interface RuntimeArtifact {
  readonly runtimeId?: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform | 'any';
  readonly arch?: string | 'any';
  /** A local path or an https URL. The plugin does not execute an unverified file. */
  readonly source: string;
  readonly sha256: string;
  /** `archive` artifacts are extracted into the verified runtime root before launch. */
  readonly format?: 'file' | 'archive';
  /** Executable relative to the installed artifact, or the artifact itself by default. */
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
  /** Absent for archive installs: the archive is removed once extraction succeeds. */
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
