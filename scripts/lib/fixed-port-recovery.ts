// Port-anchored recovery of leftover CI heavy-sample RuntimeInstances.
//
// The heavy Studio-QA / SFC-07 profile pins each sample to a fixed port triple
// (server/interface/engine per slot) instead of selecting a free slot. A single
// leftover listener from a previous run therefore blocks the next batch with
// "port <p> already in use". The previous bash recovery was *environ-anchored*:
// it only killed a PID whose /proc/<pid>/environ exposed both a
// /tmp/<prefix>-sample-* workspace root AND FORGEAX_SERVER_PORT ∈ fixed ports.
// A server that carried the port as a CLI arg (not env), or that came from an
// earlier workspace-naming scheme, was silently skipped — the scan reported
// "all ports already free" while the port was still held.
//
// This module inverts the anchor: start from the fixed ports, resolve whoever
// LISTENs there, and decide ownership from what the process *is* (its cwd /
// command line) — the same "prove it's ours, never guess from the port alone"
// stance as runtime-process-owner.ts, but tolerant of a deleted sample
// workspace (the raw /proc/<pid>/cwd symlink keeps a " (deleted)" suffix that
// realpath cannot resolve). The planner is pure over injected occupants so the
// kill decision is unit-testable without touching real processes.

/** Fixed RuntimeInstance port bases; slot N adds N * SLOT_STRIDE. */
export const FIXED_PORT_BASES = { server: 18900, interface: 18920, engine: 15173 } as const;
export const SLOT_STRIDE = 10000;
export const FIXED_SLOTS = [0, 1, 2, 3, 4] as const;

/** Every fixed heavy port across all slots (server + interface + engine). */
export function fixedHeavyPorts(): number[] {
  const ports: number[] = [];
  for (const slot of FIXED_SLOTS) {
    const offset = slot * SLOT_STRIDE;
    ports.push(FIXED_PORT_BASES.server + offset);
    ports.push(FIXED_PORT_BASES.interface + offset);
    ports.push(FIXED_PORT_BASES.engine + offset);
  }
  return ports;
}

export interface FixedPortHolder {
  readonly pid: number;
  /** /proc/<pid>/cmdline (NUL-joined then space-normalized). Null if unreadable. */
  readonly commandLine: string | null;
  /**
   * Raw readlink of /proc/<pid>/cwd. Unlike realpath it survives a deleted
   * workspace, arriving as e.g. "/tmp/studio-qa-sample-abc (deleted)". Null if
   * unreadable.
   */
  readonly cwdLink: string | null;
}

export interface FixedPortOccupant extends FixedPortHolder {
  readonly port: number;
}

export interface RecoveryPlanOptions {
  /**
   * Directory-name prefixes of generated sample workspaces under /tmp, each
   * ending in the trailing dash (e.g. "studio-qa-sample-"). A holder is ours
   * only when its cwd or command line is anchored to one of these paths.
   */
  readonly samplePrefixes: readonly string[];
  /** PIDs that must never be killed (this process and its ancestors). */
  readonly protectedPids?: ReadonlySet<number>;
}

export interface SkippedOccupant {
  readonly occupant: FixedPortOccupant;
  readonly reason: string;
}

export interface RecoveryPlan {
  readonly kill: readonly FixedPortOccupant[];
  readonly skip: readonly SkippedOccupant[];
}

/** The absolute /tmp path prefixes a generated sample workspace can carry. */
function anchorPrefixes(samplePrefixes: readonly string[]): string[] {
  return samplePrefixes
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `/tmp/${p}`);
}

/**
 * True when `text` names a generated sample workspace. Matches the raw cwd
 * symlink (with or without a trailing " (deleted)") and absolute command-line
 * paths that live under the sample workspace.
 */
export function isGeneratedSampleAnchor(
  text: string | null,
  samplePrefixes: readonly string[],
): boolean {
  if (!text) return false;
  return anchorPrefixes(samplePrefixes).some((prefix) => text.includes(prefix));
}

/**
 * Decide which fixed-port listeners to kill. A listener is killed only when it
 * is anchored to a generated sample workspace AND not protected — so an
 * unrelated process that happens to hold a fixed port, or the recovery process
 * itself, is left untouched.
 */
export function planFixedPortRecovery(
  occupants: readonly FixedPortOccupant[],
  options: RecoveryPlanOptions,
): RecoveryPlan {
  const protectedPids = options.protectedPids ?? new Set<number>();
  const kill: FixedPortOccupant[] = [];
  const skip: SkippedOccupant[] = [];
  for (const occupant of occupants) {
    if (protectedPids.has(occupant.pid)) {
      skip.push({ occupant, reason: 'protected (recovery process or its ancestor)' });
      continue;
    }
    const anchored =
      isGeneratedSampleAnchor(occupant.cwdLink, options.samplePrefixes) ||
      isGeneratedSampleAnchor(occupant.commandLine, options.samplePrefixes);
    if (anchored) {
      kill.push(occupant);
    } else {
      skip.push({
        occupant,
        reason: 'not anchored to a generated sample workspace (left untouched for safety)',
      });
    }
  }
  return { kill, skip };
}
