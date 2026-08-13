// scripts/lib/env.ts — pure dotenv parsing for the source-runtime launcher.
// Parsing and precedence are intentionally separate: callers merge the parsed
// values once without mutating process.env, then pass the final environment to
// every detached child.

import { existsSync, readFileSync } from 'node:fs';

/** Parses a dotenv file without mutating process.env. */
export function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as string;
    let val = (m[2] as string).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
