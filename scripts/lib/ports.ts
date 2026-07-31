// scripts/lib/ports.ts — stop/report compatibility view of fixed ports.
//
// Core endpoints are derived from StartupEnvironment; this module adds the
// optional fixed services that stop.ts must also sweep. Dynamic plugin ports
// are allocated at launch and recorded in
// .forgeax/dev-stack.env (FORGEAX_RUN_PORTS) + .forgeax/extension-dev-ports.json,
// which stop.ts reads as the dynamic-port source.

import {
  isStartupProfile,
  resolveStartupEnvironment,
  type StartupProfile,
} from './startup-environment.ts';

const optionalPort = (v: string | undefined, dflt: number): number => {
  const p = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(p) ? p : dflt;
};

const requestedProfile = process.env.FORGEAX_STARTUP_PROFILE;
const sourceProfile: Exclude<StartupProfile, 'desktop-prod'> =
  isStartupProfile(requestedProfile) && requestedProfile !== 'desktop-prod'
    ? requestedProfile
    : 'web-dev';
const startup = resolveStartupEnvironment({
  root: process.cwd(),
  profile: sourceProfile,
  env: process.env,
});

export const PORT_SERVER = startup.server.port;
export const PORT_INTERFACE = startup.interface.port;
export const PORT_ENGINE = startup.engine.port;
export const PORT_NARRATIVE = optionalPort(process.env.NARRATIVE_PORT, 8900);
export const PORT_FACEMASK = optionalPort(process.env.FACE_MASK_PORT, 18930);

// NOTE: the editor (:15280) port is gone — feat-20260703 single-realm serves the
// Edit engine IN-PROCESS in the interface(studio) vite at :18920, so there is no
// separate edit-runtime vite service to preflight or sweep.

/**
 * Fixed ports stop.ts must always sweep, even when dev-stack.env is missing
 * (the F1 root cause: face-mask :18930 was never in the table).
 * Order mirrors FIXED_SVCS for the stop report.
 */
export const FIXED_PORTS: readonly number[] = [
  PORT_SERVER,
  PORT_INTERFACE,
  PORT_ENGINE,
  PORT_NARRATIVE,
  PORT_FACEMASK,
];

export const FIXED_SVCS: readonly string[] = [
  'server     (forgeax-server / bun --watch)',
  'interface  (vite — serves the editor engine in-process)',
  'engine     (vite — engine-src / play-runtime)',
  'narrative  (wb-narrative API · optional)',
  'face-mask  (wb-reel python sidecar · optional)',
];
