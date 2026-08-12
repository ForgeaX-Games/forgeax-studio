/**
 * Bounded crash log for the MCP server process.
 *
 * An MCP server owns stdout as the protocol channel and usually has no terminal, so
 * an unhandled throw is invisible unless it lands in a file. The size caps are not
 * theoretical: an AI client that repeatedly respawns a crashing server will write an
 * unbounded log, and the failure mode observed in the wild is a multi-hundred-MB file
 * on a user's disk.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024;

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function crashLogPath(): string {
  return process.env.FORGEAX_GAME_CRASH_LOG || join(homedir(), '.forgeax', 'game-mcp-crash.log');
}

/**
 * Append one diagnostic entry, rotating once past the cap.
 *
 * Every failure path here is swallowed: logging must never be the reason a request
 * fails, and the disk may legitimately be read-only or full.
 */
export function writeCrashLog(scope: string, err: unknown): void {
  try {
    const path = crashLogPath();
    mkdirSync(dirname(path), { recursive: true });

    const maxBytes = numFromEnv('FORGEAX_GAME_CRASH_LOG_MAX_BYTES', DEFAULT_MAX_BYTES);
    const maxEntry = numFromEnv('FORGEAX_GAME_CRASH_LOG_MAX_ENTRY_BYTES', DEFAULT_MAX_ENTRY_BYTES);

    try {
      if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
    } catch {
      /* missing file or un-rotatable path — append anyway */
    }

    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const entry = `${new Date().toISOString()} [${scope}] ${detail}\n`;
    appendFileSync(path, entry.length > maxEntry ? `${entry.slice(0, maxEntry)}…(truncated)\n` : entry);
  } catch {
    /* logging is best-effort by construction */
  }
}
