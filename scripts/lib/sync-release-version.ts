// scripts/lib/sync-release-version.ts — keep shipping version in sync across artifacts.
//
// SSOT: root package.json "version" (semver x.y.z). Propagates to the Tauri shell
// (tauri.conf.json + Cargo.toml) before desktop builds.
//
// Deliberately does NOT touch packages/interface/package.json: that version field
// is the SSOT of interface's OWN release name (`interface-vX.Y.Z` tags are derived
// from it by the subrepo's tag-release.yml — ADR 0022). Verified 2026-07-03 that
// nothing reads it for desktop builds; the old write (d10c105) was tidiness only.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readRootVersion(root: string): string {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
}

/** Sync root package.json version into desktop-shipping manifests. Returns the version. */
export function syncReleaseVersion(root: string): string {
  const version = readRootVersion(root);
  const ifaceDir = join(root, 'packages/interface');

  const tauriConfPath = join(ifaceDir, 'src-tauri/tauri.conf.json');
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  if (tauriConf.version !== version) {
    tauriConf.version = version;
    writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
  }

  const cargoPath = join(ifaceDir, 'src-tauri/Cargo.toml');
  const cargo = readFileSync(cargoPath, 'utf8');
  const nextCargo = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  if (nextCargo !== cargo) writeFileSync(cargoPath, nextCargo);

  return version;
}
