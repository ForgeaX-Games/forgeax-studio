// scripts/lib/ports.ts — single source of truth for the FIXED studio ports.
//
// Both run.ts (preflight / launch) and stop.ts (teardown) import this so a port
// is declared exactly once. Dynamic plugin ports (node-editor apps, reel, etc.)
// are NOT here — they are allocated at launch and recorded in
// .forgeax/dev-stack.env (FORGEAX_RUN_PORTS) + .forgeax/plugin-dev-ports.json,
// which stop.ts reads as the dynamic-port source. See perf doc 08 §PortRegistry.
//
// Every value honours an env override so the three run formats (web-dev /
// desktop-dev / desktop-prod) can re-point ports without editing this file.

const n = (v: string | undefined, dflt: number): number => {
  const p = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(p) ? p : dflt;
};

export const PORT_SERVER = n(process.env.FORGEAX_SERVER_PORT, 18900);
export const PORT_INTERFACE = n(process.env.FORGEAX_INTERFACE_PORT, 18920);
export const PORT_ENGINE = n(process.env.FORGEAX_ENGINE_PORT, 15173);
export const PORT_EDITOR = n(process.env.FORGEAX_EDITOR_PORT, 15280);
export const PORT_NARRATIVE = n(process.env.NARRATIVE_PORT, 8900);
export const PORT_FACEMASK = n(process.env.FACE_MASK_PORT, 18930);

/**
 * Fixed ports stop.ts must always sweep, even when dev-stack.env is missing
 * (the F1 root cause: face-mask :18930 + editor :15280 were never in the table).
 * Order mirrors FIXED_SVCS for the stop report.
 */
export const FIXED_PORTS: readonly number[] = [
  PORT_SERVER,
  PORT_INTERFACE,
  PORT_ENGINE,
  PORT_EDITOR,
  PORT_NARRATIVE,
  PORT_FACEMASK,
];

export const FIXED_SVCS: readonly string[] = [
  'server     (forgeax-server / bun --watch)',
  'interface  (vite)',
  'engine     (vite — engine-src / play-runtime)',
  'editor     (vite — edit-runtime / Edit mode)',
  'narrative  (wb-narrative API · optional)',
  'face-mask  (wb-reel python sidecar · optional)',
];
